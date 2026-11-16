import type { ShopFeature } from './api';

const CSV_COLUMNS = [
  'osm_id',
  'name',
  'shop',
  'lat',
  'lon',
  'missing_opening_hours',
  'missing_wheelchair',
  'opening_hours',
  'wheelchair',
  'address',
  'edit_url',
] as const;

function csvCell(v: string | number | boolean | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  // Quote anything with separators, quotes or newlines; neutralise spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function address(tags: Record<string, string>): string {
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  return [street, tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(', ');
}

/** CSV for field surveys: one row per shop, missing tags as yes/no. */
export function toCsv(features: ShopFeature[]): string {
  const rows = features.map(({ properties: p, geometry }) => {
    const [lon, lat] = geometry.coordinates as [number, number];
    return [
      p.id,
      p.name,
      p.shop,
      lat.toFixed(7),
      lon.toFixed(7),
      p.missingHours ? 'yes' : 'no',
      p.missingWheelchair ? 'yes' : 'no',
      p.tags.opening_hours,
      p.tags.wheelchair,
      address(p.tags),
      p.editUrl,
    ]
      .map(csvCell)
      .join(',');
  });
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}

export function toGeoJson(features: ShopFeature[]): string {
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
}

export function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
