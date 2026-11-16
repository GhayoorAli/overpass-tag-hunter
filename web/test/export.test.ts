import { describe, expect, it } from 'vitest';
import type { ShopFeature } from '../src/api';
import { trendText } from '../src/auth';
import { toCsv } from '../src/export';
import { countTiles } from '../src/tiles';

const feature = (id: string, tags: Record<string, string>): ShopFeature => {
  const [osmType, osmId] = id.split('/') as ['node' | 'way', string];
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [8.68, 50.11] },
    properties: {
      id,
      osmType,
      osmId: Number(osmId),
      name: tags.name ?? null,
      shop: tags.shop!,
      tags,
      missingHours: !tags.opening_hours,
      missingWheelchair: !tags.wheelchair,
      missingWebsite: true,
      editUrl: `https://www.openstreetmap.org/edit?editor=id&${osmType}=${osmId}`,
      osmUrl: `https://www.openstreetmap.org/${osmType}/${osmId}`,
    },
  };
};

describe('CSV export', () => {
  it('writes one row per shop with quoting and editor links', () => {
    const csv = toCsv([
      feature('node/1', { shop: 'bakery', name: 'Bäckerei "Zum Korn", Bornheim', 'addr:street': 'Berger Straße', 'addr:housenumber': '12' }),
      feature('way/2', { shop: 'books', name: '=HYPERLINK("x")', opening_hours: 'Mo-Sa 10:00-19:00', wheelchair: 'yes' }),
    ]);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('osm_id,name,shop,lat,lon,missing_opening_hours,missing_wheelchair,opening_hours,wheelchair,address,edit_url');
    expect(lines[1]).toBe(
      'node/1,"Bäckerei ""Zum Korn"", Bornheim",bakery,50.1100000,8.6800000,yes,yes,,,Berger Straße 12,https://www.openstreetmap.org/edit?editor=id&node=1',
    );
    // Formula injection is neutralised.
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[2]).toContain('https://www.openstreetmap.org/edit?editor=id&way=2');
  });
});

describe('helpers', () => {
  it('estimates tiles like the server', () => {
    expect(countTiles({ south: 50.105, west: 8.665, north: 50.12, east: 8.695 }, 14)).toBe(4);
  });

  it('formats the gaps trend', () => {
    const p = (gaps: number, scannedAt: string) => ({ gaps, scannedAt, shops: 50, missingHours: gaps, missingWheelchair: 0 });
    expect(trendText(p(21, '2026-11-15T10:00:00Z'), p(34, '2026-11-01T10:00:00Z'))).toBe('34 → 21 since 1 Nov');
    expect(trendText(null, null)).toBe('Not scanned yet');
  });
});
