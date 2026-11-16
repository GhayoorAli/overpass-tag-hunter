import type { Feature, FeatureCollection, Point } from 'geojson';
import { type BBox, type Tile, tileToBBox } from './tiles.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type OsmType = 'node' | 'way' | 'relation';

export interface ShopProperties {
  /** `type/id`, e.g. `way/123456` — the dedup key across tile edges. */
  id: string;
  osmType: OsmType;
  osmId: number;
  name: string | null;
  shop: string;
  tags: Record<string, string>;
  missingHours: boolean;
  missingWheelchair: boolean;
  missingWebsite: boolean;
  editUrl: string;
  osmUrl: string;
}

export type ShopFeature = Feature<Point, ShopProperties>;
export type ShopCollection = FeatureCollection<Point, ShopProperties>;

interface OverpassElement {
  type: OsmType;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export type OverpassErrorKind = 'rate_limited' | 'unavailable' | 'timeout' | 'http' | 'network' | 'bad_response';

export class OverpassError extends Error {
  constructor(
    public readonly kind: OverpassErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OverpassError';
  }
  /** 429/504 are the documented "server busy" answers; 502/503 are transient gateway hiccups. All worth waiting for. */
  get retryable() {
    return this.kind === 'rate_limited' || this.kind === 'unavailable' || this.kind === 'timeout' || this.kind === 'network';
  }
}

/* ------------------------------------------------------------------ */
/* Query + classification                                              */
/* ------------------------------------------------------------------ */

const fmt = (n: number) => n.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');

export function buildShopQuery(b: BBox, timeoutSec = 60): string {
  return `[out:json][timeout:${timeoutSec}];\nnwr["shop"](${fmt(b.south)},${fmt(b.west)},${fmt(b.north)},${fmt(b.east)});\nout center tags;`;
}

export function osmLinks(osmType: OsmType, osmId: number) {
  return {
    editUrl: `https://www.openstreetmap.org/edit?editor=id&${osmType}=${osmId}`,
    osmUrl: `https://www.openstreetmap.org/${osmType}/${osmId}`,
  };
}

export function elementToFeature(el: OverpassElement): ShopFeature | null {
  const tags = el.tags ?? {};
  const shop = tags.shop;
  if (!shop || shop === 'vacant' || shop === 'no') return null;
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat === undefined || lon === undefined) return null;

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      id: `${el.type}/${el.id}`,
      osmType: el.type,
      osmId: el.id,
      name: tags.name ?? tags.brand ?? null,
      shop,
      tags,
      missingHours: !tags.opening_hours,
      missingWheelchair: !tags.wheelchair,
      missingWebsite: !(tags.website || tags['contact:website']),
      ...osmLinks(el.type, el.id),
    },
  };
}

export function elementsToFeatures(elements: OverpassElement[]): ShopFeature[] {
  const out: ShopFeature[] = [];
  for (const el of elements) {
    const f = elementToFeature(el);
    if (f) out.push(f);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* HTTP client with backoff                                            */
/* ------------------------------------------------------------------ */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface OverpassClientOptions {
  urls: string[];
  userAgent: string;
  checkStatus?: boolean;
  /** Waits between retries on 429/504. Default 5 s, 15 s, 45 s. */
  backoffMs?: number[];
  requestTimeoutMs?: number;
  fetch?: FetchLike;
  sleep?: Sleep;
  log?: (msg: string) => void;
}

export class OverpassClient {
  readonly backoffMs: number[];
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly log: (msg: string) => void;
  /** Total HTTP queries sent to an interpreter (used by tests and /api/health). */
  queryCount = 0;
  private endpointIndex = 0;

  constructor(private readonly opts: OverpassClientOptions) {
    if (opts.urls.length === 0) throw new Error('OverpassClient needs at least one URL');
    this.backoffMs = opts.backoffMs ?? [5_000, 15_000, 45_000];
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? realSleep;
    this.log = opts.log ?? (() => {});
  }

  private get url() {
    return this.opts.urls[this.endpointIndex % this.opts.urls.length]!;
  }

  /** Fetch every shop in one tile, retrying with exponential backoff on 429/504. */
  async fetchTile(tile: Tile): Promise<ShopFeature[]> {
    const query = buildShopQuery(tileToBBox(tile));
    let lastError: OverpassError | undefined;

    for (let attempt = 0; attempt <= this.backoffMs.length; attempt++) {
      if (attempt > 0) {
        const wait = this.backoffMs[attempt - 1]!;
        this.log(`tile ${tile.z}/${tile.x}/${tile.y}: ${lastError?.message}; retry ${attempt} in ${wait / 1000}s`);
        await this.sleep(wait);
      }
      try {
        const elements = await this.runQuery(query);
        return elementsToFeatures(elements);
      } catch (err) {
        const e = err instanceof OverpassError ? err : new OverpassError('network', String(err));
        if (!e.retryable) throw e;
        lastError = e;
        // Busy server: if a fallback instance is configured, use it for the next attempt.
        if ((e.kind === 'rate_limited' || e.kind === 'unavailable') && this.opts.urls.length > 1) this.endpointIndex++;
      }
    }
    throw lastError!;
  }

  async runQuery(query: string): Promise<OverpassElement[]> {
    if (this.opts.checkStatus) await this.waitForSlot();
    const url = this.url;
    this.queryCount++;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'User-Agent': this.opts.userAgent,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ data: query }).toString(),
        // The query itself is capped at 60 s server-side; no answer well past that means the server is stuck.
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 90_000),
      });
    } catch (err) {
      // No HTTP answer at all: the instance is overloaded or unreachable, not our query being too heavy,
      // so back off / fall back rather than splitting the tile.
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new OverpassError('unavailable', 'no answer from Overpass (request timed out)');
      }
      throw new OverpassError('unavailable', `network error: ${(err as Error).message}`);
    }

    if (res.status === 429) throw new OverpassError('rate_limited', '429 Too Many Requests', 429);
    if (res.status === 504) throw new OverpassError('timeout', '504 Gateway Timeout', 504);
    if (res.status === 502 || res.status === 503) throw new OverpassError('unavailable', `${res.status} from Overpass (server overloaded)`, res.status);
    if (!res.ok) throw new OverpassError('http', `Overpass answered HTTP ${res.status}`, res.status);

    let body: { elements?: OverpassElement[]; remark?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new OverpassError('unavailable', 'Overpass stopped sending data (request timed out)');
      }
      throw new OverpassError('bad_response', 'Overpass returned non-JSON');
    }
    // Overpass reports query timeouts / memory exhaustion as HTTP 200 with a remark.
    if (body.remark && /runtime error/i.test(body.remark)) {
      const kind = /timed out|out of memory/i.test(body.remark) ? 'timeout' : 'http';
      throw new OverpassError(kind, body.remark);
    }
    return body.elements ?? [];
  }

  /** Optional politeness check: wait until /api/status reports a free slot (capped at 60 s). */
  private async waitForSlot(): Promise<void> {
    const statusUrl = this.url.replace(/\/interpreter\/?$/, '/status');
    if (statusUrl === this.url) return;
    try {
      const res = await this.fetchImpl(statusUrl, {
        headers: { 'User-Agent': this.opts.userAgent },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const wait = parseStatusWaitSeconds(await res.text());
      if (wait > 0) {
        this.log(`no free Overpass slot, waiting ${wait}s`);
        await this.sleep(Math.min(wait, 60) * 1000);
      }
    } catch {
      // Status endpoint is best effort; the backoff handles real overload.
    }
  }
}

/** Parse the plain-text /api/status page. Returns seconds to wait (0 when a slot is free). */
export function parseStatusWaitSeconds(text: string): number {
  const free = text.match(/(\d+)\s+slots? available now/i);
  if (free && Number(free[1]) > 0) return 0;
  const waits = [...text.matchAll(/in\s+(-?\d+)\s+seconds?/gi)].map((m) => Number(m[1]));
  if (waits.length === 0) return 0;
  return Math.max(0, Math.min(...waits)) + 1;
}
