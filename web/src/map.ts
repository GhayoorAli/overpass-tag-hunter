import L from './leaflet-global';
import 'leaflet.markercluster';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import type { BBox, GridTile, ShopFeature, TileStatus } from './api';

export const COLORS = {
  both: '#d23b2c',
  hours: '#e2860b',
  wheel: '#2f67c9',
  complete: '#7d8a92',
};

export function featureColor(p: ShopFeature['properties']): string {
  if (p.missingHours && p.missingWheelchair) return COLORS.both;
  if (p.missingHours) return COLORS.hours;
  if (p.missingWheelchair) return COLORS.wheel;
  return COLORS.complete;
}

export const boundsToBBox = (b: L.LatLngBounds): BBox => ({
  south: b.getSouth(),
  west: b.getWest(),
  north: b.getNorth(),
  east: b.getEast(),
});

export const bboxToBounds = (b: BBox) => L.latLngBounds([b.south, b.west], [b.north, b.east]);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function createMap(el: HTMLElement): L.Map {
  const map = L.map(el, { zoomControl: false, preferCanvas: true, boxZoom: false }).setView([50.1155, 8.6842], 15);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
  // Re-measure once styles/fonts have settled and whenever the layout changes size.
  new ResizeObserver(() => map.invalidateSize()).observe(el);
  return map;
}

/* ------------------------------------------------------------------ */
/* Shop markers                                                        */
/* ------------------------------------------------------------------ */

function popupHtml(f: ShopFeature): string {
  const p = f.properties;
  const missing = [
    p.missingHours ? '<span class="badge hours">no opening_hours</span>' : '',
    p.missingWheelchair ? '<span class="badge wheel">no wheelchair</span>' : '',
  ].join('');
  const rows = Object.entries(p.tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  return `
    <div class="pop">
      <h3>${p.name ? escapeHtml(p.name) : '<em>Unnamed shop</em>'}</h3>
      <p class="pop-kind mono">shop=${escapeHtml(p.shop)} · ${p.osmType}/${p.osmId}</p>
      ${missing ? `<p class="pop-missing">${missing}</p>` : '<p class="pop-missing"><span class="badge ok">complete</span></p>'}
      <div class="pop-tags"><table>${rows}</table></div>
      <p class="pop-links">
        <a class="btn small primary" href="${p.editUrl}" target="_blank" rel="noopener">Edit in iD</a>
        <a class="btn small" href="${p.osmUrl}" target="_blank" rel="noopener">View on OSM</a>
      </p>
    </div>`;
}

export class ShopLayer {
  private readonly cluster: L.MarkerClusterGroup;

  constructor(private readonly map: L.Map) {
    this.cluster = L.markerClusterGroup({
      disableClusteringAtZoom: 18,
      maxClusterRadius: 45,
      showCoverageOnHover: false,
      chunkedLoading: true,
      iconCreateFunction: (c) => {
        const n = c.getChildCount();
        const size = n < 10 ? 30 : n < 100 ? 36 : 44;
        return L.divIcon({ html: `<span>${n}</span>`, className: 'cluster', iconSize: [size, size] });
      },
    });
    map.addLayer(this.cluster);
  }

  render(features: ShopFeature[]) {
    this.cluster.clearLayers();
    const layer = L.geoJSON(
      { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection,
      {
        pointToLayer: (feature, latlng) => {
          const p = (feature as ShopFeature).properties;
          const complete = !p.missingHours && !p.missingWheelchair;
          return L.circleMarker(latlng, {
            radius: complete ? 5 : 7,
            color: '#ffffff',
            weight: 1.5,
            fillColor: featureColor(p),
            fillOpacity: complete ? 0.7 : 0.95,
          });
        },
        onEachFeature: (feature, l) => {
          const f = feature as ShopFeature;
          l.bindPopup(() => popupHtml(f), { maxWidth: 320, minWidth: 240 });
          l.bindTooltip(f.properties.name ? escapeHtml(f.properties.name) : escapeHtml(f.properties.shop), { direction: 'top', offset: [0, -6] });
        },
      },
    );
    this.cluster.addLayers(layer.getLayers());
  }

  clear() {
    this.cluster.clearLayers();
  }
}

/* ------------------------------------------------------------------ */
/* Tile grid overlay                                                   */
/* ------------------------------------------------------------------ */

const TILE_STYLE: Record<TileStatus, L.PathOptions> = {
  pending: { color: '#1d2a33', weight: 1, opacity: 0.45, dashArray: '4 4', fillColor: '#1d2a33', fillOpacity: 0.04 },
  cached: { color: '#2e8b57', weight: 1, opacity: 0.55, dashArray: undefined, fillColor: '#2e8b57', fillOpacity: 0.07 },
  ok: { color: '#2e8b57', weight: 1, opacity: 0.55, dashArray: undefined, fillColor: '#2e8b57', fillOpacity: 0.07 },
  failed: { color: '#c0392b', weight: 1.5, opacity: 0.8, dashArray: undefined, fillColor: '#c0392b', fillOpacity: 0.16 },
};

export class GridLayer {
  private readonly group = L.layerGroup();
  private readonly rects = new Map<string, { rect: L.Rectangle; status: TileStatus }>();

  constructor(map: L.Map) {
    this.group.addTo(map);
  }

  show(grid: GridTile[]) {
    this.clear();
    for (const t of grid) {
      const rect = L.rectangle(bboxToBounds(t.bbox), { ...TILE_STYLE[t.status], interactive: false });
      this.rects.set(`${t.z}/${t.x}/${t.y}`, { rect, status: t.status });
      rect.addTo(this.group);
    }
  }

  setStatus(t: { z: number; x: number; y: number; status: TileStatus }) {
    const entry = this.rects.get(`${t.z}/${t.x}/${t.y}`);
    if (!entry) return;
    entry.status = t.status;
    entry.rect.setStyle(TILE_STYLE[t.status]);
  }

  /** Fade the grid once a scan is done so markers stay readable; failed tiles stay red. */
  settle() {
    for (const { rect, status } of this.rects.values()) {
      rect.setStyle(status === 'failed' ? TILE_STYLE.failed : { opacity: 0.22, fillOpacity: 0, dashArray: '2 6' });
    }
  }

  clear() {
    this.group.clearLayers();
    this.rects.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Rectangle drawing (no plugin needed)                                */
/* ------------------------------------------------------------------ */

// Styled in JS: the canvas renderer (preferCanvas) ignores CSS classes on paths.
const SELECTION_STYLE: L.PolylineOptions = {
  interactive: false,
  color: '#1d2a33',
  weight: 2,
  dashArray: '6 5',
  fillColor: '#e2860b',
  fillOpacity: 0.07,
};

export class RectangleTool {
  private active = false;
  private start: L.LatLng | null = null;
  private rect: L.Rectangle | null = null;
  selection: BBox | null = null;

  constructor(
    private readonly map: L.Map,
    private readonly onChange: (sel: BBox | null, drawing: boolean) => void,
  ) {
    map.on('mousedown', this.down, this);
    map.on('mousemove', this.move, this);
    map.on('mouseup', this.up, this);
  }

  get drawing() {
    return this.active;
  }

  toggle(on = !this.active) {
    this.active = on;
    this.map.getContainer().classList.toggle('drawing', on);
    if (on) this.map.dragging.disable();
    else this.map.dragging.enable();
    this.onChange(this.selection, on);
  }

  set(b: BBox | null) {
    this.rect?.remove();
    this.rect = null;
    this.selection = b;
    if (b) this.rect = L.rectangle(bboxToBounds(b), SELECTION_STYLE).addTo(this.map);
    this.onChange(b, this.active);
  }

  private down(e: L.LeafletMouseEvent) {
    if (!this.active) return;
    this.start = e.latlng;
    this.rect?.remove();
    this.rect = L.rectangle(L.latLngBounds(e.latlng, e.latlng), SELECTION_STYLE).addTo(this.map);
  }

  private move(e: L.LeafletMouseEvent) {
    if (!this.active || !this.start || !this.rect) return;
    this.rect.setBounds(L.latLngBounds(this.start, e.latlng));
  }

  private up(e: L.LeafletMouseEvent) {
    if (!this.active || !this.start) return;
    const bounds = L.latLngBounds(this.start, e.latlng);
    this.start = null;
    const tiny = this.map.latLngToContainerPoint(bounds.getNorthEast()).distanceTo(this.map.latLngToContainerPoint(bounds.getSouthWest())) < 10;
    this.toggle(false);
    this.set(tiny ? null : boundsToBBox(bounds));
  }
}
