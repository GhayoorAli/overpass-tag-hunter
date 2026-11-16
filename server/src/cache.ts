import type { DB } from './db.js';
import type { ShopCollection, ShopFeature } from './overpass.js';
import { type Tile, tileChildren } from './tiles.js';

export type TileStatus = 'ok' | 'failed' | 'split';

interface Row {
  fetched_at: string;
  status: TileStatus;
  geojson: string | null;
}

/** Per-tile GeoJSON cache in SQLite, keyed on z/x/y and shared by every user. */
export class TileCache {
  private readonly getStmt;
  private readonly putStmt;

  constructor(
    db: DB,
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.getStmt = db.prepare<[number, number, number], Row>(
      'SELECT fetched_at, status, geojson FROM tile_cache WHERE z = ? AND x = ? AND y = ?',
    );
    this.putStmt = db.prepare(
      `INSERT INTO tile_cache (z, x, y, fetched_at, status, geojson) VALUES (@z, @x, @y, @fetched_at, @status, @geojson)
       ON CONFLICT (z, x, y) DO UPDATE SET fetched_at = excluded.fetched_at, status = excluded.status, geojson = excluded.geojson`,
    );
  }

  private fresh(row: Row): boolean {
    return this.now() - Date.parse(row.fetched_at) < this.maxAgeMs;
  }

  /**
   * Features for a tile if it is a fresh cache hit, otherwise null.
   * A tile stored as `split` is a hit only when all four children are fresh hits.
   */
  get(tile: Tile): ShopFeature[] | null {
    const row = this.getStmt.get(tile.z, tile.x, tile.y);
    if (!row || !this.fresh(row)) return null;
    if (row.status === 'ok') return (JSON.parse(row.geojson ?? '{"features":[]}') as ShopCollection).features;
    if (row.status === 'split') {
      const parts: ShopFeature[] = [];
      for (const child of tileChildren(tile)) {
        const f = this.get(child);
        if (!f) return null;
        parts.push(...f);
      }
      return parts;
    }
    return null; // failed tiles are retried on the next scan
  }

  put(tile: Tile, status: TileStatus, features: ShopFeature[] | null = null) {
    const geojson: string | null = features ? JSON.stringify({ type: 'FeatureCollection', features }) : null;
    this.putStmt.run({ ...tile, status, geojson, fetched_at: new Date(this.now()).toISOString() });
  }
}
