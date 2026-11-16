/**
 * Slippy-map tile maths (https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames).
 * Fixed tiles are the unit of work: two users scanning overlapping areas hit the same cache rows.
 */

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface Tile {
  z: number;
  x: number;
  y: number;
}

// Web Mercator cannot represent the poles.
const MAX_LAT = 85.05112878;

const clampLat = (lat: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat: number, z: number): number {
  const rad = (clampLat(lat) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** Inclusive tile index range that covers a bbox. Edges that land exactly on a tile border don't pull in the next tile. */
export function bboxToTileRange(bbox: BBox, z: number) {
  const n = 2 ** z;
  const clampIdx = (v: number) => Math.max(0, Math.min(n - 1, v));
  const maxIndex = (v: number) => (Number.isInteger(v) ? v - 1 : Math.floor(v));

  const minX = clampIdx(Math.floor(lonToTileX(bbox.west, z)));
  const maxX = clampIdx(Math.max(minX, maxIndex(lonToTileX(bbox.east, z))));
  // Tile y grows southwards, so north gives the smallest y.
  const minY = clampIdx(Math.floor(latToTileY(bbox.north, z)));
  const maxY = clampIdx(Math.max(minY, maxIndex(latToTileY(bbox.south, z))));
  return { z, minX, maxX, minY, maxY };
}

export function countTiles(bbox: BBox, z: number): number {
  const r = bboxToTileRange(bbox, z);
  return (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
}

export function bboxToTiles(bbox: BBox, z: number): Tile[] {
  const r = bboxToTileRange(bbox, z);
  const tiles: Tile[] = [];
  for (let y = r.minY; y <= r.maxY; y++) {
    for (let x = r.minX; x <= r.maxX; x++) tiles.push({ z, x, y });
  }
  return tiles;
}

export function tileToBBox({ z, x, y }: Tile): BBox {
  return {
    north: tileYToLat(y, z),
    south: tileYToLat(y + 1, z),
    west: tileXToLon(x, z),
    east: tileXToLon(x + 1, z),
  };
}

/** The four tiles one zoom level deeper — used when a dense tile times out. */
export function tileChildren({ z, x, y }: Tile): Tile[] {
  return [
    { z: z + 1, x: 2 * x, y: 2 * y },
    { z: z + 1, x: 2 * x + 1, y: 2 * y },
    { z: z + 1, x: 2 * x, y: 2 * y + 1 },
    { z: z + 1, x: 2 * x + 1, y: 2 * y + 1 },
  ];
}

export const tileKey = ({ z, x, y }: Tile) => `${z}/${x}/${y}`;

export function bboxContains(b: BBox, lat: number, lon: number): boolean {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}
