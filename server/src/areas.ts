import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { requireAuth } from './auth.js';
import type { DB } from './db.js';
import { HttpError } from './errors.js';
import { type Job, type ScanManager, countFeatures, jobSummary } from './scans.js';
import type { BBox } from './tiles.js';
import { areaSchema, idParam, rescanSchema } from './validation.js';

interface AreaRow extends BBox {
  id: number;
  user_id: number;
  name: string;
  share_token: string | null;
  last_forced_at: string | null;
  created_at: string;
}

interface ScanRow {
  scanned_at: string;
  shops: number;
  missing_hours: number;
  missing_wheelchair: number;
}

const HISTORY_LIMIT = 50;

function toHistoryPoint(r: ScanRow) {
  return {
    scannedAt: r.scanned_at,
    shops: r.shops,
    missingHours: r.missing_hours,
    missingWheelchair: r.missing_wheelchair,
    /** "Gaps left" = missing tags still to survey. */
    gaps: r.missing_hours + r.missing_wheelchair,
  };
}

export function areasRouter(db: DB, scans: ScanManager, opts: { secret: string; forceRefreshIntervalMs: number }) {
  const router = Router();
  router.use(requireAuth(opts.secret));

  const listAreas = db.prepare<[number], AreaRow>('SELECT * FROM areas WHERE user_id = ? ORDER BY created_at DESC, id DESC');
  const getArea = db.prepare<[number], AreaRow>('SELECT * FROM areas WHERE id = ?');
  const insertArea = db.prepare(
    'INSERT INTO areas (user_id, name, south, west, north, east) VALUES (@user_id, @name, @south, @west, @north, @east)',
  );
  const deleteArea = db.prepare<[number]>('DELETE FROM areas WHERE id = ?');
  const history = db.prepare<[number, number], ScanRow>(
    `SELECT * FROM (SELECT scanned_at, shops, missing_hours, missing_wheelchair, rowid AS r FROM area_scans
       WHERE area_id = ? ORDER BY scanned_at DESC, r DESC LIMIT ?) ORDER BY scanned_at ASC, r ASC`,
  );
  const insertScan = db.prepare(
    `INSERT INTO area_scans (area_id, scanned_at, shops, missing_hours, missing_wheelchair)
     VALUES (@area_id, @scanned_at, @shops, @missing_hours, @missing_wheelchair)`,
  );
  const setForced = db.prepare<[string, number]>('UPDATE areas SET last_forced_at = ? WHERE id = ?');
  const setShare = db.prepare<[string | null, number]>('UPDATE areas SET share_token = ? WHERE id = ?');

  const recordScan = (areaId: number, job: Job) => {
    const c = countFeatures(job.features.values());
    insertScan.run({
      area_id: areaId,
      scanned_at: new Date().toISOString(),
      shops: c.shops,
      missing_hours: c.missingHours,
      missing_wheelchair: c.missingWheelchair,
    });
  };

  const present = (a: AreaRow) => {
    const h = history.all(a.id, HISTORY_LIMIT).map(toHistoryPoint);
    return {
      id: a.id,
      name: a.name,
      bbox: { south: a.south, west: a.west, north: a.north, east: a.east },
      createdAt: a.created_at,
      shareToken: a.share_token,
      latest: h.at(-1) ?? null,
      previous: h.at(-2) ?? null,
      history: h,
    };
  };

  /** 404 when missing, 403 when it belongs to someone else. */
  const ownedArea = (rawId: unknown, userId: number): AreaRow => {
    const area = getArea.get(idParam.parse(rawId));
    if (!area) throw new HttpError(404, 'Area not found.', 'not_found');
    if (area.user_id !== userId) throw new HttpError(403, 'This area belongs to another user.', 'forbidden');
    return area;
  };

  router.get('/', (req, res) => {
    res.json({ areas: listAreas.all(req.user!.id).map(present) });
  });

  router.post('/', (req, res) => {
    const body = areaSchema.parse(req.body);
    const info = insertArea.run({
      user_id: req.user!.id,
      name: body.name,
      south: body.south,
      west: body.west,
      north: body.north,
      east: body.east,
    });
    const id = Number(info.lastInsertRowid);

    // If the client just scanned exactly this bbox, keep that scan as the first history point.
    if (body.jobId) {
      const job = scans.get(body.jobId);
      const same =
        job &&
        job.status === 'complete' &&
        (['south', 'west', 'north', 'east'] as const).every((k) => Math.abs(job.bbox[k] - body[k]) < 1e-9);
      if (same) recordScan(id, job);
    }
    res.status(201).json({ area: present(getArea.get(id)!) });
  });

  router.delete('/:id', (req, res) => {
    const area = ownedArea(req.params.id, req.user!.id);
    deleteArea.run(area.id);
    res.status(204).end();
  });

  router.post('/:id/scan', (req, res) => {
    const area = ownedArea(req.params.id, req.user!.id);
    const { force } = rescanSchema.parse(req.body ?? {});
    if (force) {
      const last = area.last_forced_at ? Date.parse(area.last_forced_at) : 0;
      const waitMs = last + opts.forceRefreshIntervalMs - Date.now();
      if (waitMs > 0) {
        throw new HttpError(
          429,
          `This area was force-refreshed recently. You can refresh it again in ${Math.ceil(waitMs / 60000)} min; a normal rescan uses the 24-hour cache.`,
          'refresh_too_soon',
        );
      }
      setForced.run(new Date().toISOString(), area.id);
    }
    const bbox = { south: area.south, west: area.west, north: area.north, east: area.east };
    const job = scans.start(bbox, { force, onComplete: (j) => recordScan(area.id, j) });
    res.status(202).json({ ...jobSummary(job), areaId: area.id });
  });

  router.post('/:id/share', (req, res) => {
    const area = ownedArea(req.params.id, req.user!.id);
    const token = area.share_token ?? randomBytes(12).toString('base64url');
    setShare.run(token, area.id);
    res.json({ shareToken: token });
  });

  router.delete('/:id/share', (req, res) => {
    const area = ownedArea(req.params.id, req.user!.id);
    setShare.run(null, area.id);
    res.status(204).end();
  });

  return router;
}

/** Public, read-only view of a shared area (stretch goal). */
export function sharedRouter(db: DB) {
  const router = Router();
  const byToken = db.prepare<[string], AreaRow>('SELECT * FROM areas WHERE share_token = ?');
  const history = db.prepare<[number], ScanRow>(
    'SELECT scanned_at, shops, missing_hours, missing_wheelchair FROM area_scans WHERE area_id = ? ORDER BY scanned_at ASC',
  );
  router.get('/:token', (req, res) => {
    const area = byToken.get(String(req.params.token));
    if (!area) throw new HttpError(404, 'This share link is invalid or was revoked.', 'not_found');
    const h = history.all(area.id).map(toHistoryPoint);
    res.json({
      area: {
        name: area.name,
        bbox: { south: area.south, west: area.west, north: area.north, east: area.east },
        latest: h.at(-1) ?? null,
        previous: h.at(-2) ?? null,
        history: h,
      },
    });
  });
  return router;
}
