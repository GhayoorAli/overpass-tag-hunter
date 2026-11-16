import { api, type ScanResult, type ScanSummary, type TileStatus } from './api';

export interface Progress {
  done: number;
  total: number;
  failed: number;
  cached: number;
  tile?: { z: number; x: number; y: number; status: TileStatus };
}

export interface ScanHandlers {
  onProgress(p: Progress): void;
  /** Partial merged result — cached tiles render first, then markers fill in as tiles finish. */
  onResult(r: ScanResult, final: boolean): void;
  onError(message: string): void;
}

/**
 * Follow a background scan job: SSE for progress, the result endpoint for markers.
 * Returns a cancel function (closes the stream; the job keeps running on the server and stays cached).
 */
export function followScan(summary: ScanSummary, h: ScanHandlers): () => void {
  let closed = false;
  let partialTimer: number | undefined;
  let errors = 0;

  const fetchResult = async (final: boolean) => {
    try {
      const r = await api<ScanResult>(`/api/scans/${summary.jobId}/result`);
      if (!closed || final) h.onResult(r, final);
    } catch (err) {
      if (final) h.onError((err as Error).message);
    }
  };

  const schedulePartial = () => {
    if (partialTimer !== undefined) return;
    partialTimer = window.setTimeout(() => {
      partialTimer = undefined;
      if (!closed) void fetchResult(false);
    }, 1200);
  };

  h.onProgress({ done: summary.done, total: summary.tiles, failed: summary.failed, cached: summary.cached });
  if (summary.cached > 0) void fetchResult(false);

  const es = new EventSource(`/api/scans/${summary.jobId}/events`);
  const close = () => {
    closed = true;
    window.clearTimeout(partialTimer);
    es.close();
  };

  es.addEventListener('progress', (e) => {
    errors = 0;
    const p = JSON.parse((e as MessageEvent).data) as Progress;
    h.onProgress(p);
    if (p.tile && p.tile.status !== 'failed') schedulePartial();
  });
  es.addEventListener('complete', (e) => {
    const p = JSON.parse((e as MessageEvent).data) as Progress;
    h.onProgress(p);
    close();
    void fetchResult(true);
  });
  es.onerror = () => {
    if (closed) return;
    // EventSource reconnects by itself and the server replays a snapshot; give up after a few tries.
    if (++errors >= 5) {
      close();
      h.onError('Lost the connection to the scan. The server keeps working — scan again in a moment to load the cached tiles.');
    }
  };

  return close;
}
