import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { areasRouter, sharedRouter } from './areas.js';
import { authRouter } from './auth.js';
import { TileCache } from './cache.js';
import type { AppConfig } from './config.js';
import type { DB } from './db.js';
import { HttpError, errorHandler } from './errors.js';
import { OverpassClient, type OverpassClientOptions } from './overpass.js';
import { TileQueue } from './queue.js';
import { ScanManager, scansRouter } from './scans.js';

export interface AppDeps {
  db: DB;
  config: AppConfig;
  /** Override for tests (mocked fetch, no-op sleep). */
  overpass?: Partial<OverpassClientOptions>;
  bcryptRounds?: number;
  staticDir?: string | null;
  log?: (msg: string) => void;
}

export function createApp({ db, config, overpass, bcryptRounds, staticDir, log = () => {} }: AppDeps) {
  const client = new OverpassClient({
    urls: [config.overpassUrl, ...config.overpassFallbackUrls],
    userAgent: config.userAgent,
    checkStatus: config.checkStatus,
    log,
    ...overpass,
  });
  const cache = new TileCache(db, config.cacheMaxAgeMs);
  const queue = new TileQueue(client, cache, log);
  const scans = new ScanManager(cache, queue, { baseZoom: config.baseZoom, maxTiles: config.maxTiles });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, overpassQueries: client.queryCount, queued: queue.pending, jobs: scans.jobs.size });
  });
  app.get('/api/config', (_req, res) => {
    res.json({ maxTiles: config.maxTiles, baseZoom: config.baseZoom });
  });
  app.use('/api/auth', authRouter(db, { secret: config.jwtSecret, expiresIn: config.jwtExpiresIn, rateLimit: config.authRateLimit, bcryptRounds }));
  app.use('/api/scans', scansRouter(scans));
  app.use('/api/areas', areasRouter(db, scans, { secret: config.jwtSecret, forceRefreshIntervalMs: config.forceRefreshIntervalMs }));
  app.use('/api/shared', sharedRouter(db));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'No such API route.', 'not_found')));

  // Serve the built Leaflet client (web/dist) when it exists.
  const dir = staticDir === undefined ? path.resolve(import.meta.dirname, '../../web/dist') : staticDir;
  if (dir && fs.existsSync(path.join(dir, 'index.html'))) {
    app.use(express.static(dir, { maxAge: '1h', index: 'index.html' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dir, 'index.html')));
  }

  app.use(errorHandler);
  return { app, client, cache, queue, scans };
}
