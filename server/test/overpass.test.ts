import { describe, expect, it } from 'vitest';
import { TileCache } from '../src/cache.js';
import { openDb } from '../src/db.js';
import {
  OverpassClient,
  buildShopQuery,
  elementToFeature,
  parseStatusWaitSeconds,
  type FetchLike,
} from '../src/overpass.js';
import { TileQueue } from '../src/queue.js';
import { tileToBBox } from '../src/tiles.js';
import { bboxFromQuery } from './helpers.js';

const TILE = { z: 14, x: 8587, y: 5549 };

describe('query + classification', () => {
  it('builds the per-tile shop query', () => {
    expect(buildShopQuery({ south: 50.1, west: 8.65, north: 50.12, east: 8.68 })).toBe(
      '[out:json][timeout:60];\nnwr["shop"](50.1,8.65,50.12,8.68);\nout center tags;',
    );
  });

  it('classifies missing tags and skips vacant shops', () => {
    const f = elementToFeature({ type: 'node', id: 1, lat: 50, lon: 8, tags: { shop: 'bakery', name: 'Bäcker', wheelchair: 'yes' } })!;
    expect(f.properties).toMatchObject({ id: 'node/1', missingHours: true, missingWheelchair: false, shop: 'bakery' });
    expect(elementToFeature({ type: 'node', id: 2, lat: 50, lon: 8, tags: { shop: 'vacant' } })).toBeNull();
  });

  it('uses the centre of ways and builds editor links to the right object', () => {
    const f = elementToFeature({ type: 'way', id: 123456, center: { lat: 50.11, lon: 8.68 }, tags: { shop: 'books' } })!;
    expect(f.geometry.coordinates).toEqual([8.68, 50.11]);
    expect(f.properties.editUrl).toBe('https://www.openstreetmap.org/edit?editor=id&way=123456');
    expect(f.properties.osmUrl).toBe('https://www.openstreetmap.org/way/123456');
    const r = elementToFeature({ type: 'relation', id: 9, center: { lat: 1, lon: 2 }, tags: { shop: 'mall' } })!;
    expect(r.properties.editUrl).toBe('https://www.openstreetmap.org/edit?editor=id&relation=9');
    const n = elementToFeature({ type: 'node', id: 42, lat: 1, lon: 2, tags: { shop: 'kiosk' } })!;
    expect(n.properties.osmUrl).toBe('https://www.openstreetmap.org/node/42');
  });

  it('parses /api/status', () => {
    expect(parseStatusWaitSeconds('Rate limit: 2\n2 slots available now.\n')).toBe(0);
    expect(
      parseStatusWaitSeconds('Rate limit: 2\nSlot available after: 2026-11-15T10:00:05Z, in 7 seconds.\nSlot available after: x, in 30 seconds.\n'),
    ).toBe(8);
  });
});

describe('backoff and splitting', () => {
  it('a mocked 504 triggers backoff (5 s, 15 s, 45 s), then a split into 4 child tiles', async () => {
    const parentBox = tileToBBox(TILE);
    const queried: string[] = [];
    const fetch: FetchLike = async (_url, init) => {
      const b = bboxFromQuery(String(init.body));
      const isParent = Math.abs(b.north - b.south - (parentBox.north - parentBox.south)) < 1e-6;
      queried.push(isParent ? 'parent' : 'child');
      if (isParent) return new Response('<html>504 Gateway Timeout</html>', { status: 504 });
      return Response.json({
        elements: [{ type: 'node', id: queried.length, lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2, tags: { shop: 'bakery' } }],
      });
    };
    const sleeps: number[] = [];
    const client = new OverpassClient({ urls: ['https://example.test/api/interpreter'], userAgent: 'test', fetch, sleep: async (ms) => void sleeps.push(ms) });
    const db = openDb(':memory:');
    const cache = new TileCache(db, 24 * 3600_000);
    const queue = new TileQueue(client, cache);

    const result = await queue.fetch(TILE);

    expect(sleeps).toEqual([5_000, 15_000, 45_000]);
    expect(queried).toEqual(['parent', 'parent', 'parent', 'parent', 'child', 'child', 'child', 'child']);
    expect(result).toMatchObject({ status: 'ok', split: true });
    expect(result.features).toHaveLength(4);

    // The parent is stored as `split` and is a cache hit through its children.
    const row = db.prepare('SELECT status FROM tile_cache WHERE z = 14').get() as { status: string };
    expect(row.status).toBe('split');
    expect(cache.get(TILE)).toHaveLength(4);
    expect(db.prepare('SELECT count(*) AS n FROM tile_cache WHERE z = 15').get()).toEqual({ n: 4 });
  });

  it('marks a tile failed after repeated 429s without splitting, and switches to the fallback instance', async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      return new Response('rate limited', { status: 429 });
    };
    const client = new OverpassClient({
      urls: ['https://main.test/api/interpreter', 'https://fallback.test/api/interpreter'],
      userAgent: 'test',
      fetch,
      sleep: async () => {},
    });
    const queue = new TileQueue(client, new TileCache(openDb(':memory:'), 1000));
    const result = await queue.fetch(TILE);
    expect(result.status).toBe('failed');
    expect(result.split).toBe(false);
    expect(urls).toHaveLength(4);
    expect(new Set(urls)).toEqual(new Set(['https://main.test/api/interpreter', 'https://fallback.test/api/interpreter']));
  });

  it('retries transient 502/503 answers instead of failing the tile', async () => {
    const statuses = [502, 503];
    const fetch: FetchLike = async () => {
      const s = statuses.shift();
      return s ? new Response('Bad Gateway', { status: s }) : Response.json({ elements: [] });
    };
    const sleeps: number[] = [];
    const client = new OverpassClient({ urls: ['https://x.test/api/interpreter'], userAgent: 't', fetch, sleep: async (ms) => void sleeps.push(ms) });
    await expect(client.fetchTile(TILE)).resolves.toEqual([]);
    expect(sleeps).toEqual([5_000, 15_000]);
  });

  it('treats an HTTP 200 "Query timed out" remark as a timeout', async () => {
    let n = 0;
    const fetch: FetchLike = async () => {
      n++;
      return n === 1 ? Response.json({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 61 seconds.' }) : Response.json({ elements: [] });
    };
    const client = new OverpassClient({ urls: ['https://x.test/api/interpreter'], userAgent: 't', fetch, sleep: async () => {} });
    await expect(client.fetchTile(TILE)).resolves.toEqual([]);
    expect(n).toBe(2);
  });

  it('sends a clear User-Agent and the query in the data form field', async () => {
    let seen: RequestInit | undefined;
    const client = new OverpassClient({
      urls: ['https://x.test/api/interpreter'],
      userAgent: 'OverpassTagHunter/0.1 (test)',
      fetch: async (_u, init) => {
        seen = init;
        return Response.json({ elements: [] });
      },
    });
    await client.fetchTile(TILE);
    expect(seen?.method).toBe('POST');
    expect((seen?.headers as Record<string, string>)['User-Agent']).toBe('OverpassTagHunter/0.1 (test)');
    expect(new URLSearchParams(String(seen?.body)).get('data')).toContain('nwr["shop"]');
  });
});
