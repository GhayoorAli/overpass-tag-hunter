import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                -- bcrypt
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS areas (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  south REAL NOT NULL, west REAL NOT NULL, north REAL NOT NULL, east REAL NOT NULL,
  share_token    TEXT UNIQUE,                 -- stretch: read-only share link
  last_forced_at TEXT,                        -- force refresh at most once per hour
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS areas_user ON areas(user_id);

CREATE TABLE IF NOT EXISTS area_scans (       -- progress over time
  area_id             INTEGER REFERENCES areas(id) ON DELETE CASCADE,
  scanned_at          TEXT NOT NULL,
  shops               INTEGER NOT NULL,
  missing_hours       INTEGER NOT NULL,
  missing_wheelchair  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS area_scans_area ON area_scans(area_id, scanned_at);

CREATE TABLE IF NOT EXISTS tile_cache (
  z INTEGER, x INTEGER, y INTEGER,
  fetched_at TEXT NOT NULL,
  status     TEXT NOT NULL,                   -- 'ok' | 'failed' | 'split'
  geojson    TEXT,                            -- FeatureCollection as JSON
  PRIMARY KEY (z, x, y)
);
`;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
