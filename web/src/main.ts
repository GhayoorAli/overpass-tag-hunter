import { api, ApiError, type Area, type BBox, type ScanResult, type ScanSummary, type ShopFeature } from './api';
import { AccountPanel, sparkline, trendText } from './auth';
import { download, toCsv, toGeoJson } from './export';
import { bboxToBounds, boundsToBBox, createMap, GridLayer, RectangleTool, ShopLayer } from './map';
import { followScan, type Progress } from './scan';
import { countTiles } from './tiles';
// Last, so app styles override Leaflet's defaults.
import './styles.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  scanBtn: $<HTMLButtonElement>('scan-btn'),
  drawBtn: $<HTMLButtonElement>('draw-btn'),
  clearBtn: $<HTMLButtonElement>('clear-btn'),
  estimate: $('tile-estimate'),
  hint: $('selection-hint'),
  progress: $('progress'),
  bar: document.querySelector<HTMLElement>('#progress .bar')!,
  fill: document.querySelector<HTMLElement>('#progress .fill')!,
  progressText: document.querySelector<HTMLElement>('#progress .progress-text')!,
  error: $('scan-error'),
  results: $('results-card'),
  resultsMeta: $('results-meta'),
  statAny: $('stat-any'),
  statShops: $('stat-shops'),
  fHours: $<HTMLInputElement>('f-hours'),
  fWheel: $<HTMLInputElement>('f-wheel'),
  fComplete: $<HTMLInputElement>('f-complete'),
  fType: $<HTMLSelectElement>('f-type'),
  cHours: $('c-hours'),
  cWheel: $('c-wheel'),
  cComplete: $('c-complete'),
  exportGeo: $<HTMLButtonElement>('export-geojson'),
  exportCsv: $<HTMLButtonElement>('export-csv'),
  saveForm: $<HTMLFormElement>('save-form'),
  saveName: $<HTMLInputElement>('save-name'),
  shareBanner: $('share-banner'),
};

const map = createMap($('map'));
const shops = new ShopLayer(map);
const grid = new GridLayer(map);

const state = {
  maxTiles: 150,
  baseZoom: 14,
  scanning: false,
  cancel: null as null | (() => void),
  result: null as ScanResult | null,
  job: null as null | { jobId: string; bbox: BBox },
  readOnly: false,
};

/* ------------------------------------------------------------------ */
/* Selection + tile estimate                                           */
/* ------------------------------------------------------------------ */

const rect = new RectangleTool(map, (sel, drawing) => {
  ui.drawBtn.setAttribute('aria-pressed', String(drawing));
  ui.drawBtn.textContent = drawing ? 'Drag on the map…' : 'Draw area';
  ui.clearBtn.hidden = !sel;
  ui.scanBtn.textContent = sel ? 'Scan selection' : 'Scan this view';
  ui.hint.textContent = drawing
    ? 'Click and drag to draw the area you want to survey.'
    : sel
      ? 'Scanning the drawn rectangle.'
      : 'Pan the map to your district, or draw a rectangle.';
  updateEstimate();
});

const currentBBox = (): BBox => rect.selection ?? boundsToBBox(map.getBounds());

function updateEstimate() {
  const n = countTiles(currentBBox(), state.baseZoom);
  const tooBig = n > state.maxTiles;
  ui.estimate.textContent = `${n} / ${state.maxTiles} tiles`;
  ui.estimate.classList.toggle('over', tooBig);
  ui.scanBtn.disabled = state.scanning || tooBig;
  ui.scanBtn.title = tooBig ? `This needs ${n} tiles; zoom in or draw a smaller area (max ${state.maxTiles}).` : '';
}
map.on('moveend', updateEstimate);

/* ------------------------------------------------------------------ */
/* Scanning                                                            */
/* ------------------------------------------------------------------ */

function showError(msg: string | null) {
  ui.error.hidden = !msg;
  ui.error.textContent = msg ?? '';
}

function renderProgress(p: Progress) {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  ui.progress.hidden = false;
  ui.fill.style.width = `${pct}%`;
  ui.bar.setAttribute('aria-valuenow', String(pct));
  ui.fill.classList.toggle('has-failed', p.failed > 0);
  const parts = [`${p.done} / ${p.total} tiles`];
  if (p.cached) parts.push(`${p.cached} cached`);
  if (p.failed) parts.push(`${p.failed} failed`);
  ui.progressText.textContent = parts.join(' · ');
  if (p.tile) grid.setStatus(p.tile);
}

/** Start a scan (anonymous or a saved-area rescan) and follow it to completion. */
async function runScan(start: () => Promise<ScanSummary>, bbox: BBox): Promise<void> {
  state.cancel?.();
  showError(null);
  state.scanning = true;
  updateEstimate();
  ui.scanBtn.textContent = 'Scanning…';

  let summary: ScanSummary;
  try {
    summary = await start();
  } catch (err) {
    state.scanning = false;
    rect.set(rect.selection); // restores button label
    showError((err as Error).message);
    return;
  }

  state.job = { jobId: summary.jobId, bbox };
  grid.show(summary.grid);

  await new Promise<void>((resolve) => {
    state.cancel = followScan(summary, {
      onProgress: renderProgress,
      onResult: (r, final) => {
        setResult(r);
        if (final) {
          grid.settle();
          finish();
          if (r.failedTiles) showError(`${r.failedTiles} tile(s) failed after retries (server busy). Scan again later to fill them in — finished tiles stay cached.`);
        }
      },
      onError: (msg) => {
        showError(msg);
        finish();
      },
    });
    function finish() {
      state.scanning = false;
      state.cancel = null;
      rect.set(rect.selection);
      resolve();
    }
  });
}

function scanBBox(bbox: BBox) {
  return runScan(() => api<ScanSummary>('/api/scans', { body: bbox }), bbox);
}

ui.scanBtn.addEventListener('click', () => void scanBBox(currentBBox()));
ui.drawBtn.addEventListener('click', () => rect.toggle());
ui.clearBtn.addEventListener('click', () => rect.set(null));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && rect.drawing) rect.toggle(false);
});

/* ------------------------------------------------------------------ */
/* Results, filters, export                                            */
/* ------------------------------------------------------------------ */

function setResult(r: ScanResult) {
  state.result = r;
  ui.results.hidden = false;

  // Shop-type dropdown built from the result, most common first.
  const types = new Map<string, number>();
  for (const f of r.features) types.set(f.properties.shop, (types.get(f.properties.shop) ?? 0) + 1);
  const selected = ui.fType.value;
  ui.fType.innerHTML =
    `<option value="">All types (${r.features.length})</option>` +
    [...types.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t, n]) => `<option value="${t.replace(/"/g, '&quot;')}">${t.replace(/</g, '&lt;')} (${n})</option>`)
      .join('');
  ui.fType.value = types.has(selected) ? selected : '';

  const c = r.counts;
  ui.statAny.textContent = String(c.missingAny);
  ui.statShops.textContent = String(c.shops);
  ui.cHours.textContent = String(c.missingHours);
  ui.cWheel.textContent = String(c.missingWheelchair);
  ui.cComplete.textContent = String(c.shops - c.missingAny);
  ui.resultsMeta.textContent = r.complete ? (r.failedTiles ? `${r.failedTiles} tiles failed` : 'complete') : 'loading…';
  ui.saveForm.hidden = !(account.user && r.complete && !state.readOnly);
  applyFilters();
}

function filtered(): ShopFeature[] {
  const r = state.result;
  if (!r) return [];
  const type = ui.fType.value;
  return r.features.filter(({ properties: p }) => {
    if (type && p.shop !== type) return false;
    if (ui.fHours.checked && p.missingHours) return true;
    if (ui.fWheel.checked && p.missingWheelchair) return true;
    if (ui.fComplete.checked && !p.missingHours && !p.missingWheelchair) return true;
    return false;
  });
}

function applyFilters() {
  const list = filtered();
  shops.render(list);
  ui.exportGeo.disabled = ui.exportCsv.disabled = list.length === 0;
}

for (const el of [ui.fHours, ui.fWheel, ui.fComplete, ui.fType]) el.addEventListener('change', applyFilters);

const exportName = () => `tag-gaps-${new Date().toISOString().slice(0, 10)}`;
ui.exportGeo.addEventListener('click', () => download(`${exportName()}.geojson`, toGeoJson(filtered()), 'application/geo+json'));
ui.exportCsv.addEventListener('click', () => download(`${exportName()}.csv`, toCsv(filtered()), 'text/csv;charset=utf-8'));

/* ------------------------------------------------------------------ */
/* Accounts + saved areas                                              */
/* ------------------------------------------------------------------ */

const account = new AccountPanel($('account-body'), $('account-email'), {
  onUserChange: (user) => {
    ui.saveForm.hidden = !(user && state.result?.complete && !state.readOnly);
  },
  onShow: (area: Area) => {
    map.fitBounds(bboxToBounds(area.bbox), { padding: [24, 24] });
    rect.set(area.bbox);
    void scanBBox(area.bbox);
  },
  onRescan: async (area: Area, force: boolean) => {
    map.fitBounds(bboxToBounds(area.bbox), { padding: [24, 24] });
    rect.set(area.bbox);
    await runScan(() => api<ScanSummary>(`/api/areas/${area.id}/scan`, { body: { force } }), area.bbox);
  },
});

ui.saveForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.job) return;
  const name = ui.saveName.value.trim();
  if (!name) return;
  const btn = ui.saveForm.querySelector('button')!;
  btn.disabled = true;
  try {
    await account.save(name, state.job.bbox, state.job.jobId);
    ui.saveName.value = '';
    $('account-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    showError(err instanceof ApiError ? err.message : 'Could not save the area.');
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function openShared(token: string) {
  try {
    const { area } = await api<{ area: Omit<Area, 'id' | 'createdAt' | 'shareToken'> }>(`/api/shared/${encodeURIComponent(token)}`);
    state.readOnly = true;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    ui.shareBanner.hidden = false;
    ui.shareBanner.innerHTML = `
      <div><span class="eyebrow">Shared area · read-only</span><strong>${esc(area.name)}</strong>
      <span class="trend">${area.latest ? `${area.latest.gaps} gaps · ` : ''}${esc(trendText(area.latest, area.previous))}</span></div>
      ${sparkline(area.history)}`;
    map.fitBounds(bboxToBounds(area.bbox), { padding: [24, 24] });
    rect.set(area.bbox);
    await scanBBox(area.bbox);
  } catch (err) {
    showError((err as Error).message);
  }
}

async function boot() {
  try {
    const cfg = await api<{ maxTiles: number; baseZoom: number }>('/api/config');
    state.maxTiles = cfg.maxTiles;
    state.baseZoom = cfg.baseZoom;
  } catch {
    /* defaults */
  }
  updateEstimate();
  await account.init();
  const share = new URLSearchParams(location.search).get('share');
  if (share) await openShared(share);
}

void boot();
