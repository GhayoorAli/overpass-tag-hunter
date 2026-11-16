import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Router, type Request, type Response } from 'express';
import type { TileCache } from './cache.js';
import { HttpError } from './errors.js';
import type { ShopCollection, ShopFeature } from './overpass.js';
import type { TileQueue } from './queue.js';
import { type BBox, type Tile, bboxContains, bboxToTiles, countTiles, tileToBBox } from './tiles.js';
import { bboxSchema } from './validation.js';

export type TileState = Tile & { status: 'pending' | 'cached' | 'ok' | 'failed'; split?: boolean };

export interface ScanCounts {
  shops: number;
  missingHours: number;
  missingWheelchair: number;
  missingBoth: number;
  missingAny: number;
  missingWebsite: number;
}

export interface Job {
  id: string;
  bbox: BBox;
  createdAt: number;
  status: 'running' | 'complete';
  tiles: TileState[];
  total: number;
  done: number;
  failed: number;
  cached: number;
  features: Map<string, ShopFeature>;
  events: EventEmitter;
  completed: Promise<Job>;
}

export interface ScanOptions {
  force?: boolean;
  onComplete?: (job: Job) => void;
}

export function countFeatures(features: Iterable<ShopFeature>): ScanCounts {
  const c: ScanCounts = { shops: 0, missingHours: 0, missingWheelchair: 0, missingBoth: 0, missingAny: 0, missingWebsite: 0 };
  for (const { properties: p } of features) {
    c.shops++;
    if (p.missingHours) c.missingHours++;
    if (p.missingWheelchair) c.missingWheelchair++;
    if (p.missingHours && p.missingWheelchair) c.missingBoth++;
    if (p.missingHours || p.missingWheelchair) c.missingAny++;
    if (p.missingWebsite) c.missingWebsite++;
  }
  return c;
}

/**
 * Merge per-tile features into one map keyed by `type/id`, so a way that crosses a tile edge
 * (returned by both tiles) appears once. Features outside the requested bbox are dropped.
 */
export function mergeFeatures(into: Map<string, ShopFeature>, features: ShopFeature[], bbox: BBox) {
  for (const f of features) {
    const [lon, lat] = f.geometry.coordinates as [number, number];
    if (bboxContains(bbox, lat, lon)) into.set(f.properties.id, f);
  }
}

interface ScanManagerOptions {
  baseZoom: number;
  maxTiles: number;
  jobTtlMs?: number;
}

/** Scan jobs live in memory: they finish in minutes and their results are rebuilt from the tile cache. */
export class ScanManager {
  readonly jobs = new Map<string, Job>();
  private readonly gcTimer: NodeJS.Timeout;

  constructor(
    private readonly cache: TileCache,
    private readonly queue: TileQueue,
    private readonly opts: ScanManagerOptions,
  ) {
    const ttl = opts.jobTtlMs ?? 60 * 60 * 1000;
    this.gcTimer = setInterval(() => {
      const cutoff = Date.now() - ttl;
      for (const [id, job] of this.jobs) if (job.status === 'complete' && job.createdAt < cutoff) this.jobs.delete(id);
    }, 5 * 60 * 1000);
    this.gcTimer.unref();
  }

  stop() {
    clearInterval(this.gcTimer);
  }

  /** Throws HttpError(400) when the area needs more tiles than allowed. */
  plan(bbox: BBox): Tile[] {
    const n = countTiles(bbox, this.opts.baseZoom);
    if (n > this.opts.maxTiles) {
      throw new HttpError(
        400,
        `This area needs ${n} map tiles; the limit is ${this.opts.maxTiles} (roughly a big city district). Zoom in or draw a smaller rectangle.`,
        'area_too_large',
      );
    }
    return bboxToTiles(bbox, this.opts.baseZoom);
  }

  start(bbox: BBox, options: ScanOptions = {}): Job {
    const tiles = this.plan(bbox);
    const events = new EventEmitter();
    events.setMaxListeners(100);

    let resolveCompleted!: (j: Job) => void;
    const job: Job = {
      id: randomUUID(),
      bbox,
      createdAt: Date.now(),
      status: 'running',
      tiles: tiles.map((t) => ({ ...t, status: 'pending' })),
      total: tiles.length,
      done: 0,
      failed: 0,
      cached: 0,
      features: new Map(),
      events,
      completed: new Promise((r) => (resolveCompleted = r)),
    };
    this.jobs.set(job.id, job);

    const finishIfDone = () => {
      if (job.done < job.total || job.status === 'complete') return;
      job.status = 'complete';
      try {
        options.onComplete?.(job);
      } catch (err) {
        console.error('[scans] onComplete failed', err);
      }
      job.events.emit('complete', job);
      resolveCompleted(job);
    };

    // Cache hits are answered at once so they render first.
    const misses: TileState[] = [];
    for (const state of job.tiles) {
      const hit = options.force ? null : this.cache.get(state);
      if (hit) {
        mergeFeatures(job.features, hit, bbox);
        state.status = 'cached';
        job.done++;
        job.cached++;
      } else {
        misses.push(state);
      }
    }

    for (const state of misses) {
      void this.queue.fetch(state).then((result) => {
        mergeFeatures(job.features, result.features, bbox);
        state.status = result.status;
        state.split = result.split;
        job.done++;
        if (result.status === 'failed') job.failed++;
        job.events.emit('progress', job, state);
        finishIfDone();
      });
    }
    // Defer so callers can subscribe before an all-cached job completes.
    queueMicrotask(finishIfDone);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }
}

export function jobSummary(job: Job) {
  return {
    jobId: job.id,
    status: job.status,
    tiles: job.total,
    cached: job.cached,
    done: job.done,
    failed: job.failed,
    grid: job.tiles.map(({ z, x, y, status }) => ({ z, x, y, status, bbox: tileToBBox({ z, x, y }) })),
  };
}

export function jobResult(job: Job): ShopCollection & { counts: ScanCounts; complete: boolean; area: BBox; failedTiles: number } {
  const features = [...job.features.values()];
  return {
    type: 'FeatureCollection',
    features,
    counts: countFeatures(features),
    complete: job.status === 'complete',
    area: job.bbox,
    failedTiles: job.failed,
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function scansRouter(manager: ScanManager) {
  const router = Router();

  router.post('/', (req, res) => {
    const bbox = bboxSchema.parse(req.body);
    const job = manager.start(bbox);
    res.status(202).json(jobSummary(job));
  });

  router.get('/:id', (req, res) => {
    res.json(jobSummary(requireJob(manager, req.params.id)));
  });

  router.get('/:id/result', (req, res) => {
    res.json(jobResult(requireJob(manager, req.params.id)));
  });

  router.get('/:id/events', (req, res) => streamJob(requireJob(manager, req.params.id), req, res));

  return router;
}

function requireJob(manager: ScanManager, id: string | string[] | undefined): Job {
  const job = typeof id === 'string' ? manager.get(id) : undefined;
  if (!job) throw new HttpError(404, 'Scan not found (jobs expire an hour after they finish).', 'scan_not_found');
  return job;
}

/** Server-Sent Events: `progress {done,total,failed,tile}` per tile, then `complete`. */
export function streamJob(job: Job, req: Request, res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let heartbeat: NodeJS.Timeout | undefined;
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const progress = (j: Job, tile?: TileState) =>
    send('progress', { done: j.done, total: j.total, failed: j.failed, cached: j.cached, tile });
  const cleanup = () => {
    clearInterval(heartbeat);
    job.events.off('progress', progress);
    job.events.off('complete', complete);
  };
  const complete = (j: Job) => {
    send('complete', { done: j.done, total: j.total, failed: j.failed, cached: j.cached, counts: countFeatures(j.features.values()) });
    cleanup();
    res.end();
  };

  // Snapshot so late subscribers (or reconnects) catch up.
  send('snapshot', jobSummary(job));
  progress(job);
  if (job.status === 'complete') {
    complete(job);
    return;
  }

  heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  job.events.on('progress', progress);
  job.events.on('complete', complete);
  req.on('close', cleanup);
}
