import PQueue from 'p-queue';
import type { TileCache } from './cache.js';
import { OverpassError, type OverpassClient, type ShopFeature } from './overpass.js';
import { type Tile, tileChildren, tileKey } from './tiles.js';

export interface TileResult {
  status: 'ok' | 'failed';
  features: ShopFeature[];
  /** True when the tile timed out and was answered by its four children. */
  split: boolean;
  error?: string;
}

/**
 * The one-at-a-time Overpass worker shared by every scan job.
 *
 * - concurrency 1: the public server limits parallel queries per client;
 * - backoff on 429/504 lives in OverpassClient and runs *inside* the queue slot,
 *   so nothing else hits the server while we wait;
 * - a tile that still times out is split into its 4 children, re-queued once;
 * - the same tile requested by two jobs at once is fetched once.
 */
export class TileQueue {
  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly inflight = new Map<string, Promise<TileResult>>();

  constructor(
    private readonly client: OverpassClient,
    private readonly cache: TileCache,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  get pending() {
    return this.queue.size + this.queue.pending;
  }

  fetch(tile: Tile, allowSplit = true): Promise<TileResult> {
    const key = tileKey(tile);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.run(tile, allowSplit).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async run(tile: Tile, allowSplit: boolean): Promise<TileResult> {
    try {
      const features = await this.queue.add(() => this.client.fetchTile(tile));
      this.cache.put(tile, 'ok', features);
      return { status: 'ok', features, split: false };
    } catch (err) {
      const e = err instanceof OverpassError ? err : new OverpassError('network', String(err));
      if (e.kind === 'timeout' && allowSplit) {
        this.log(`tile ${tileKey(tile)} still times out, splitting into 4 children`);
        const children = await Promise.all(
          tileChildren(tile).map((c): Promise<TileResult> => {
            const hit = this.cache.get(c);
            return hit ? Promise.resolve({ status: 'ok', features: hit, split: false }) : this.fetch(c, false);
          }),
        );
        const failed = children.filter((c) => c.status === 'failed');
        this.cache.put(tile, failed.length ? 'failed' : 'split');
        return {
          status: failed.length ? 'failed' : 'ok',
          features: children.flatMap((c) => c.features),
          split: true,
          error: failed[0]?.error,
        };
      }
      this.log(`tile ${tileKey(tile)} failed: ${e.message}`);
      this.cache.put(tile, 'failed');
      return { status: 'failed', features: [], split: false, error: e.message };
    }
  }
}
