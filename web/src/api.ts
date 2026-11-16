import type { Feature, FeatureCollection, Point } from 'geojson';

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface ShopProperties {
  id: string;
  osmType: 'node' | 'way' | 'relation';
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

export interface Counts {
  shops: number;
  missingHours: number;
  missingWheelchair: number;
  missingBoth: number;
  missingAny: number;
  missingWebsite: number;
}

export type TileStatus = 'pending' | 'cached' | 'ok' | 'failed';
export interface GridTile {
  z: number;
  x: number;
  y: number;
  status: TileStatus;
  bbox: BBox;
}

export interface ScanSummary {
  jobId: string;
  status: 'running' | 'complete';
  tiles: number;
  cached: number;
  done: number;
  failed: number;
  grid: GridTile[];
  areaId?: number;
}

export interface ScanResult extends FeatureCollection<Point, ShopProperties> {
  counts: Counts;
  complete: boolean;
  area: BBox;
  failedTiles: number;
}

export interface HistoryPoint {
  scannedAt: string;
  shops: number;
  missingHours: number;
  missingWheelchair: number;
  gaps: number;
}

export interface Area {
  id: number;
  name: string;
  bbox: BBox;
  createdAt: string;
  shareToken: string | null;
  latest: HistoryPoint | null;
  previous: HistoryPoint | null;
  history: HistoryPoint[];
}

export interface User {
  id: number;
  email: string;
}

const TOKEN_KEY = 'tag-hunter.token';

export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string | null) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage blocked: stay logged in for this tab only */
    }
  },
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Is it running?');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) tokenStore.set(null);
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}
