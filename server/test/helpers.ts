import { createApp } from '../src/app.js';
import { config as baseConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import type { FetchLike } from '../src/overpass.js';

export interface MockElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags: Record<string, string>;
}

/** Parse the bbox out of a query built by buildShopQuery. */
export function bboxFromQuery(body: string) {
  const data = new URLSearchParams(body).get('data') ?? '';
  const m = data.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  if (!m) throw new Error(`no bbox in query: ${data}`);
  const [south, west, north, east] = m.slice(1).map(Number) as [number, number, number, number];
  return { south, west, north, east };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * A fake Overpass server holding a fixed set of elements. Returns those whose centre falls inside the
 * queried bbox (ways are matched on any of `touches` points, which is how a real way crosses tile edges).
 */
export function fakeOverpass(elements: (MockElement & { touches?: [number, number][] })[]) {
  const calls: { south: number; west: number; north: number; east: number }[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const b = bboxFromQuery(String(init.body));
    calls.push(b);
    const inside = (lat: number, lon: number) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
    const hits = elements.filter((e) => {
      const pts = e.touches ?? [[e.lat ?? e.center!.lat, e.lon ?? e.center!.lon]];
      return pts.some(([lat, lon]) => inside(lat, lon));
    });
    return json({ elements: hits.map(({ touches: _t, ...e }) => e) });
  };
  return { fetch, calls };
}

export function makeTestApp(fetch: FetchLike, overrides: Partial<typeof baseConfig> = {}) {
  const db = openDb(':memory:');
  const config = { ...baseConfig, jwtSecret: 'test-secret', checkStatus: false, authRateLimit: 1000, ...overrides };
  const built = createApp({
    db,
    config,
    staticDir: null,
    bcryptRounds: 4,
    overpass: { fetch, sleep: async () => {}, checkStatus: false },
  });
  return { ...built, db, config };
}
