import { api, ApiError, tokenStore, type Area, type HistoryPoint, type User } from './api';

export interface AccountCallbacks {
  onShow(area: Area): void;
  onRescan(area: Area, force: boolean): Promise<void>;
  onUserChange(user: User | null): void;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** "34 → 21 since 1 Nov" */
export function trendText(latest: HistoryPoint | null, previous: HistoryPoint | null): string {
  if (!latest) return 'Not scanned yet';
  if (!previous) return `First scan ${shortDate(latest.scannedAt)}`;
  return `${previous.gaps} → ${latest.gaps} since ${shortDate(previous.scannedAt)}`;
}

/** Small inline SVG chart of gaps over time (stretch goal: progress history per area). */
export function sparkline(history: HistoryPoint[], w = 112, h = 28): string {
  if (history.length < 2) return '';
  const values = history.map((p) => p.gaps);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (w - 4) + 2;
    const y = h - 3 - ((v - min) / span) * (h - 6);
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts.at(-1)!;
  const title = history.map((p) => `${shortDate(p.scannedAt)}: ${p.gaps}`).join('\n');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Gaps over time">
    <title>${esc(title)}</title>
    <polyline points="${line}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.5" fill="currentColor" />
  </svg>`;
}

export class AccountPanel {
  user: User | null = null;
  areas: Area[] = [];
  private mode: 'login' | 'register' = 'login';
  private busy = new Set<number>();

  constructor(
    private readonly body: HTMLElement,
    private readonly emailEl: HTMLElement,
    private readonly cb: AccountCallbacks,
  ) {
    body.addEventListener('click', (e) => this.onClick(e));
    body.addEventListener('submit', (e) => this.onSubmit(e));
  }

  async init() {
    if (tokenStore.get()) {
      try {
        const { user } = await api<{ user: User }>('/api/auth/me');
        this.setUser(user);
        await this.refresh();
        return;
      } catch {
        tokenStore.set(null);
      }
    }
    this.setUser(null);
  }

  private setUser(user: User | null) {
    this.user = user;
    this.emailEl.textContent = user?.email ?? '';
    if (!user) this.areas = [];
    this.cb.onUserChange(user);
    this.render();
  }

  async refresh() {
    if (!this.user) return;
    try {
      const { areas } = await api<{ areas: Area[] }>('/api/areas');
      this.areas = areas;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return this.setUser(null);
    }
    this.render();
  }

  async save(name: string, bbox: Area['bbox'], jobId?: string) {
    await api<{ area: Area }>('/api/areas', { body: { name, jobId, ...bbox } });
    await this.refresh();
  }

  render(message?: { text: string; error?: boolean }) {
    const note = message ? `<p class="${message.error ? 'error' : 'note'}" role="status">${esc(message.text)}</p>` : '';
    if (!this.user) {
      const reg = this.mode === 'register';
      this.body.innerHTML = `
        <p class="hint">${reg ? 'Create a free account' : 'Log in'} to save areas like “Bornheim” or “My street” and track how many gaps are left.</p>
        <form class="auth-form" data-form="auth" novalidate>
          <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required /></label>
          <label class="field"><span>Password${reg ? ' <em>(min. 10 characters)</em>' : ''}</span>
            <input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" minlength="${reg ? 10 : 1}" required /></label>
          ${note}
          <div class="btn-row">
            <button class="btn primary" type="submit">${reg ? 'Create account' : 'Log in'}</button>
            <button class="btn ghost" type="button" data-action="switch">${reg ? 'I have an account' : 'Create account'}</button>
          </div>
        </form>`;
      return;
    }

    const items = this.areas.length
      ? this.areas
          .map((a) => {
            const gaps = a.latest ? `<strong class="mono">${a.latest.gaps}</strong> gaps left` : '<span class="muted">no scans yet</span>';
            const improved = a.latest && a.previous && a.latest.gaps < a.previous.gaps;
            const busy = this.busy.has(a.id);
            return `
          <li class="area" data-id="${a.id}">
            <div class="area-top">
              <button class="area-name" type="button" data-action="show" title="Show on map">${esc(a.name)}</button>
              ${sparkline(a.history)}
            </div>
            <p class="area-stats">${gaps}<span class="trend ${improved ? 'good' : ''}">${esc(trendText(a.latest, a.previous))}</span></p>
            <div class="area-actions">
              <button class="link" type="button" data-action="rescan" ${busy ? 'disabled' : ''}>${busy ? 'Scanning…' : 'Rescan'}</button>
              <button class="link" type="button" data-action="force" ${busy ? 'disabled' : ''} title="Ignore the 24 h cache (at most once per hour)">Force refresh</button>
              <button class="link" type="button" data-action="share">${a.shareToken ? 'Copy share link' : 'Share'}</button>
              <button class="link danger" type="button" data-action="delete">Delete</button>
            </div>
          </li>`;
          })
          .join('')
      : '<p class="hint">No saved areas yet. Scan an area, then save it from the Gaps panel.</p>';

    this.body.innerHTML = `
      ${note}
      <ul class="areas">${items}</ul>
      <div class="btn-row end"><button class="btn ghost small" type="button" data-action="logout">Log out</button></div>`;
  }

  private async onSubmit(e: Event) {
    const form = e.target as HTMLFormElement;
    if (form.dataset.form !== 'auth') return;
    e.preventDefault();
    const data = new FormData(form);
    const btn = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    btn.disabled = true;
    try {
      const res = await api<{ token: string; user: User }>(`/api/auth/${this.mode}`, {
        body: { email: String(data.get('email') ?? ''), password: String(data.get('password') ?? '') },
      });
      tokenStore.set(res.token);
      this.setUser(res.user);
      await this.refresh();
    } catch (err) {
      btn.disabled = false;
      this.render({ text: (err as Error).message, error: true });
      const email = this.body.querySelector<HTMLInputElement>('input[name=email]');
      if (email) email.value = String(data.get('email') ?? '');
    }
  }

  private async onClick(e: Event) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'switch') {
      this.mode = this.mode === 'login' ? 'register' : 'login';
      return this.render();
    }
    if (action === 'logout') {
      tokenStore.set(null);
      return this.setUser(null);
    }
    const id = Number(btn.closest<HTMLElement>('[data-id]')?.dataset.id);
    const area = this.areas.find((a) => a.id === id);
    if (!area) return;

    try {
      if (action === 'show') this.cb.onShow(area);
      if (action === 'rescan' || action === 'force') {
        this.busy.add(id);
        this.render();
        try {
          await this.cb.onRescan(area, action === 'force');
        } finally {
          this.busy.delete(id);
        }
        await this.refresh();
      }
      if (action === 'delete') {
        if (!confirm(`Delete “${area.name}” and its scan history?`)) return;
        await api(`/api/areas/${id}`, { method: 'DELETE' });
        await this.refresh();
      }
      if (action === 'share') {
        const { shareToken } = await api<{ shareToken: string }>(`/api/areas/${id}/share`, { method: 'POST' });
        const url = `${location.origin}/?share=${shareToken}`;
        let copied = false;
        try {
          await navigator.clipboard.writeText(url);
          copied = true;
        } catch {
          /* clipboard blocked */
        }
        await this.refresh();
        this.render({ text: copied ? `Read-only link copied: ${url}` : `Read-only link: ${url}` });
      }
    } catch (err) {
      this.render({ text: (err as Error).message, error: true });
    }
  }
}
