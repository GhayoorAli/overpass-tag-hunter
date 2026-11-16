import { describe, expect, it } from 'vitest';
import {
  bboxContains,
  bboxToTileRange,
  bboxToTiles,
  countTiles,
  lonToTileX,
  latToTileY,
  tileChildren,
  tileToBBox,
} from '../src/tiles.js';

// Frankfurt city centre: Hauptwache / Römer / Zeil.
const FRANKFURT = { south: 50.105, west: 8.665, north: 50.12, east: 8.695 };

describe('tile maths', () => {
  it('maps a known point to the right zoom-14 tile', () => {
    // Frankfurt Römer (50.1106, 8.6821) → z14 tile 8587/5548 (checked with the asinh form of the formula).
    expect(Math.floor(lonToTileX(8.6821, 14))).toBe(8587);
    expect(Math.floor(latToTileY(50.1106, 14))).toBe(5548);
  });

  it('gives the expected tile range for a bbox around Frankfurt city centre', () => {
    expect(bboxToTileRange(FRANKFURT, 14)).toEqual({ z: 14, minX: 8586, maxX: 8587, minY: 5548, maxY: 5549 });
    expect(countTiles(FRANKFURT, 14)).toBe(4);
    expect(bboxToTiles(FRANKFURT, 14)).toHaveLength(4);
  });

  it('turns tiles back into bboxes that cover the original area', () => {
    const tiles = bboxToTiles(FRANKFURT, 14).map(tileToBBox);
    const union = {
      south: Math.min(...tiles.map((t) => t.south)),
      west: Math.min(...tiles.map((t) => t.west)),
      north: Math.max(...tiles.map((t) => t.north)),
      east: Math.max(...tiles.map((t) => t.east)),
    };
    expect(union.south).toBeLessThanOrEqual(FRANKFURT.south);
    expect(union.west).toBeLessThanOrEqual(FRANKFURT.west);
    expect(union.north).toBeGreaterThanOrEqual(FRANKFURT.north);
    expect(union.east).toBeGreaterThanOrEqual(FRANKFURT.east);
    // Each zoom-14 tile is roughly 1.6 km wide at this latitude (~0.022° lon).
    expect(tiles[0]!.east - tiles[0]!.west).toBeCloseTo(360 / 2 ** 14, 10);
  });

  it('round-trips tile → bbox → tile', () => {
    const tile = { z: 14, x: 8587, y: 5549 };
    const b = tileToBBox(tile);
    // Shrink slightly so the edges don't touch neighbours.
    const eps = 1e-9;
    expect(bboxToTiles({ south: b.south + eps, west: b.west + eps, north: b.north - eps, east: b.east - eps }, 14)).toEqual([tile]);
    // An exact tile bbox must not pull in the neighbour to the east/south.
    expect(bboxToTiles(b, 14)).toEqual([tile]);
  });

  it('splits a tile into four children that exactly cover it', () => {
    const parent = { z: 14, x: 8587, y: 5549 };
    const kids = tileChildren(parent);
    expect(kids).toHaveLength(4);
    const pb = tileToBBox(parent);
    for (const k of kids) {
      const kb = tileToBBox(k);
      expect(k.z).toBe(15);
      expect(bboxContains(pb, (kb.north + kb.south) / 2, (kb.east + kb.west) / 2)).toBe(true);
    }
  });
});
