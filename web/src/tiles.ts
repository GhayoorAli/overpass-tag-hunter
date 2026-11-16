import type { BBox } from './api';

/** Same slippy-map maths as the server, used to preview how many tiles a view needs. */
export function countTiles(b: BBox, z: number): number {
  const n = 2 ** z;
  const x = (lon: number) => ((lon + 180) / 360) * n;
  const y = (lat: number) => {
    const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  };
  const maxIdx = (v: number) => (Number.isInteger(v) ? v - 1 : Math.floor(v));
  const minX = Math.floor(x(b.west));
  const maxX = Math.max(minX, maxIdx(x(b.east)));
  const minY = Math.floor(y(b.north));
  const maxY = Math.max(minY, maxIdx(y(b.south)));
  return (maxX - minX + 1) * (maxY - minY + 1);
}
