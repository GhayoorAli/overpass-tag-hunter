import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** Repo root, whether running from server/src (tsx) or server/dist (node). */
const ROOT = path.resolve(import.meta.dirname, '../..');

// Real environment variables win; then <repo>/.env; then server/.env.
dotenv.config({ path: [path.join(ROOT, '.env'), path.join(ROOT, 'server/.env')], quiet: true });

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const isProduction = process.env.NODE_ENV === 'production';

let jwtSecret = process.env.JWT_SECRET ?? '';
if (!jwtSecret) {
  if (isProduction) throw new Error('JWT_SECRET must be set in production (see .env.example)');
  jwtSecret = randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET not set: using a random secret, tokens will not survive a restart.');
}

export const config = {
  // API_PORT wins so tools that inject PORT for the Vite dev server don't collide with the API.
  port: int('API_PORT', int('PORT', 3000)),
  isProduction,
  jwtSecret,
  jwtExpiresIn: '7d' as const,
  dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(ROOT, 'data', 'tag-hunter.db'),
  overpassUrl: process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter',
  /** Optional second instance(s) used when the main one answers 429/504 (stretch goal). */
  overpassFallbackUrls: list('OVERPASS_FALLBACK_URLS'),
  userAgent: process.env.USER_AGENT ?? 'OverpassTagHunter/0.1 (github.com/your-name/overpass-tag-hunter)',
  /** Check /api/status for a free slot before each query. */
  checkStatus: (process.env.OVERPASS_CHECK_STATUS ?? 'true') !== 'false',
  baseZoom: 14,
  maxTiles: int('MAX_TILES', 150),
  cacheMaxAgeMs: 24 * 60 * 60 * 1000,
  forceRefreshIntervalMs: 60 * 60 * 1000,
  authRateLimit: int('AUTH_RATE_LIMIT', 20),
};

export type AppConfig = typeof config;
