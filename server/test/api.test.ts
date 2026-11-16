import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { tileToBBox } from '../src/tiles.js';
import { fakeOverpass, makeTestApp, type MockElement } from './helpers.js';

// Two z14 tiles side by side: 8587/5549 and 8588/5549.
const left = tileToBBox({ z: 14, x: 8587, y: 5549 });
const right = tileToBBox({ z: 14, x: 8588, y: 5549 });
const edgeLon = left.east;
const midLat = (left.north + left.south) / 2;
const AREA = { south: left.south + 1e-6, west: left.west + 1e-6, north: left.north - 1e-6, east: right.east - 1e-6 };

const SHOPS: (MockElement & { touches?: [number, number][] })[] = [
  { type: 'node', id: 1, lat: midLat, lon: left.west + 0.005, tags: { shop: 'bakery', name: 'Both missing' } },
  { type: 'node', id: 2, lat: midLat, lon: right.east - 0.005, tags: { shop: 'books', wheelchair: 'yes' } },
  { type: 'node', id: 3, lat: midLat + 0.001, lon: left.west + 0.006, tags: { shop: 'kiosk', opening_hours: 'Mo-Fr 08:00-18:00' } },
  { type: 'node', id: 4, lat: midLat - 0.001, lon: left.west + 0.007, tags: { shop: 'vacant' } },
  // A supermarket building straddling the tile edge: both tiles return it.
  {
    type: 'way',
    id: 123456,
    center: { lat: midLat, lon: edgeLon + 0.0001 },
    touches: [
      [midLat, edgeLon - 0.0005],
      [midLat, edgeLon + 0.0005],
    ],
    tags: { shop: 'supermarket', name: 'Edge Markt', opening_hours: '24/7', wheelchair: 'yes' },
  },
];

async function scan(app: ReturnType<typeof makeTestApp>, bbox = AREA) {
  const res = await request(app.app).post('/api/scans').send(bbox).expect(202);
  await app.scans.get(res.body.jobId)!.completed;
  const result = await request(app.app).get(`/api/scans/${res.body.jobId}/result`).expect(200);
  return { start: res.body, result: result.body };
}

describe('scans', () => {
  it('plans tiles, merges results and deduplicates a way crossing a tile edge', async () => {
    const fake = fakeOverpass(SHOPS);
    const app = makeTestApp(fake.fetch);
    const { start, result } = await scan(app);

    expect(start).toMatchObject({ tiles: 2, cached: 0 });
    expect(fake.calls).toHaveLength(2);
    const ids = result.features.map((f: { properties: { id: string } }) => f.properties.id).sort();
    expect(ids).toEqual(['node/1', 'node/2', 'node/3', 'way/123456']);
    expect(ids.filter((id: string) => id === 'way/123456')).toHaveLength(1);
    expect(result.counts).toEqual({ shops: 4, missingHours: 2, missingWheelchair: 2, missingBoth: 1, missingAny: 3, missingWebsite: 4 });
    expect(result.complete).toBe(true);
  });

  it('scanning the same area twice within 24 hours makes zero Overpass calls the second time', async () => {
    const fake = fakeOverpass(SHOPS);
    const app = makeTestApp(fake.fetch);
    await scan(app);
    const callsAfterFirst = fake.calls.length;
    const second = await scan(app);
    expect(fake.calls.length).toBe(callsAfterFirst);
    expect(second.start).toMatchObject({ tiles: 2, cached: 2 });
    expect(second.result.features).toHaveLength(4);
  });

  it('refetches once the cache is older than 24 hours', async () => {
    const fake = fakeOverpass(SHOPS);
    const app = makeTestApp(fake.fetch);
    await scan(app);
    app.db.prepare("UPDATE tile_cache SET fetched_at = '2000-01-01T00:00:00.000Z'").run();
    await scan(app);
    expect(fake.calls).toHaveLength(4);
  });

  it('rejects a scan over 150 tiles with a clear message', async () => {
    const app = makeTestApp(fakeOverpass([]).fetch);
    const res = await request(app.app).post('/api/scans').send({ south: 49.9, west: 8.3, north: 50.4, east: 9.1 }).expect(400);
    expect(res.body.error).toBe('area_too_large');
    expect(res.body.message).toMatch(/limit is 150/);
  });

  it('validates the bbox with zod', async () => {
    const app = makeTestApp(fakeOverpass([]).fetch);
    const res = await request(app.app).post('/api/scans').send({ south: 51, west: 8, north: 50, east: 9 }).expect(400);
    expect(res.body.error).toBe('invalid_request');
    await request(app.app).post('/api/scans').send({ south: 'x' }).expect(400);
  });

  it('streams progress and completion over Server-Sent Events', async () => {
    const app = makeTestApp(fakeOverpass(SHOPS).fetch);
    const start = await request(app.app).post('/api/scans').send(AREA).expect(202);
    const res = await request(app.app).get(`/api/scans/${start.body.jobId}/events`).buffer(true).parse((r, cb) => {
      let text = '';
      r.on('data', (c: Buffer) => (text += c.toString()));
      r.on('end', () => cb(null, text));
    });
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.body).toContain('event: progress');
    expect(res.body).toMatch(/event: complete\ndata: \{"done":2,"total":2,"failed":0/);
  });
});

describe('auth and saved areas', () => {
  async function register(app: ReturnType<typeof makeTestApp>, email: string) {
    const res = await request(app.app).post('/api/auth/register').send({ email, password: 'correct horse battery' }).expect(201);
    return res.body.token as string;
  }

  it('registers, logs in and rejects bad credentials', async () => {
    const app = makeTestApp(fakeOverpass([]).fetch);
    await register(app, 'Mapper@Example.org');
    await request(app.app).post('/api/auth/register').send({ email: 'mapper@example.org', password: 'correct horse battery' }).expect(409);
    await request(app.app).post('/api/auth/register').send({ email: 'short@example.org', password: 'short' }).expect(400);
    const ok = await request(app.app).post('/api/auth/login').send({ email: 'mapper@example.org', password: 'correct horse battery' }).expect(200);
    expect(ok.body.token).toBeTypeOf('string');
    await request(app.app).post('/api/auth/login').send({ email: 'mapper@example.org', password: 'wrong password!' }).expect(401);
    const me = await request(app.app).get('/api/auth/me').set('Authorization', `Bearer ${ok.body.token}`).expect(200);
    expect(me.body.user.email).toBe('mapper@example.org');
  });

  it('protected routes return 401 without a token and 403 for another user’s area', async () => {
    const app = makeTestApp(fakeOverpass(SHOPS).fetch);
    await request(app.app).get('/api/areas').expect(401);
    await request(app.app).get('/api/areas').set('Authorization', 'Bearer not-a-token').expect(401);
    await request(app.app).post('/api/areas').send({ name: 'x', ...AREA }).expect(401);

    const alice = await register(app, 'alice@example.org');
    const bob = await register(app, 'bob@example.org');
    const created = await request(app.app).post('/api/areas').set('Authorization', `Bearer ${alice}`).send({ name: 'Bornheim', ...AREA }).expect(201);
    const id = created.body.area.id;

    await request(app.app).delete(`/api/areas/${id}`).set('Authorization', `Bearer ${bob}`).expect(403);
    await request(app.app).post(`/api/areas/${id}/scan`).set('Authorization', `Bearer ${bob}`).send({}).expect(403);
    const bobList = await request(app.app).get('/api/areas').set('Authorization', `Bearer ${bob}`).expect(200);
    expect(bobList.body.areas).toEqual([]);
    await request(app.app).delete(`/api/areas/9999`).set('Authorization', `Bearer ${alice}`).expect(404);
    await request(app.app).delete(`/api/areas/${id}`).set('Authorization', `Bearer ${alice}`).expect(204);
  });

  it('saves an area, records rescans in area_scans and rate-limits forced refreshes', async () => {
    const fake = fakeOverpass(SHOPS);
    const app = makeTestApp(fake.fetch);
    const token = await register(app, 'carol@example.org');
    const auth = { Authorization: `Bearer ${token}` };

    // Scan first, then save with the jobId: that scan becomes the first history point.
    const { start } = await scan(app);
    const created = await request(app.app).post('/api/areas').set(auth).send({ name: 'My street', jobId: start.jobId, ...AREA }).expect(201);
    expect(created.body.area.latest).toMatchObject({ shops: 4, missingHours: 2, missingWheelchair: 2, gaps: 4 });
    const id = created.body.area.id;

    const rescan = await request(app.app).post(`/api/areas/${id}/scan`).set(auth).send({}).expect(202);
    await app.scans.get(rescan.body.jobId)!.completed;
    const list = await request(app.app).get('/api/areas').set(auth).expect(200);
    expect(list.body.areas[0].history).toHaveLength(2);
    expect(list.body.areas[0].previous.gaps).toBe(4);

    const callsBefore = fake.calls.length;
    const forced = await request(app.app).post(`/api/areas/${id}/scan`).set(auth).send({ force: true }).expect(202);
    await app.scans.get(forced.body.jobId)!.completed;
    expect(fake.calls.length).toBe(callsBefore + 2);
    const tooSoon = await request(app.app).post(`/api/areas/${id}/scan`).set(auth).send({ force: true }).expect(429);
    expect(tooSoon.body.error).toBe('refresh_too_soon');
  });

  it('shares a read-only link for a saved area', async () => {
    const app = makeTestApp(fakeOverpass(SHOPS).fetch);
    const token = await register(app, 'dave@example.org');
    const auth = { Authorization: `Bearer ${token}` };
    const created = await request(app.app).post('/api/areas').set(auth).send({ name: 'Shared', ...AREA }).expect(201);
    const share = await request(app.app).post(`/api/areas/${created.body.area.id}/share`).set(auth).expect(200);
    const pub = await request(app.app).get(`/api/shared/${share.body.shareToken}`).expect(200);
    expect(pub.body.area).toMatchObject({ name: 'Shared' });
    expect(pub.body.area.user_id).toBeUndefined();
    await request(app.app).delete(`/api/areas/${created.body.area.id}/share`).set(auth).expect(204);
    await request(app.app).get(`/api/shared/${share.body.shareToken}`).expect(404);
  });
});
