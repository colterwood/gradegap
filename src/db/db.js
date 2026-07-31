import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function openDb(dbPath = path.join(config.dataDir, 'gradegap.db')) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Table rebuilds run BEFORE schema.sql (whose indexes assume the new
  // shape) and before foreign_keys is switched on.
  migrateWatchesForManual(db);
  db.exec(readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  // Lightweight migrations: add columns to already-existing tables (CREATE
  // TABLE IF NOT EXISTS won't alter a table that predates a new column).
  ensureColumn(db, 'grade_prices', 'population', 'INTEGER');
  ensureColumn(db, 'grade_prices', 'num_sales', 'INTEGER');
  ensureColumn(db, 'listings', 'followed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'listings', 'follow_reminder_sent', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'watches', 'search_term', 'TEXT');
  purgeDismissedAndEndedListings(db);
  db.pragma('foreign_keys = ON');
  return db;
}

// Manual watches have no Card Ladder card, so card_id had to lose its NOT
// NULL and gain a description column. SQLite can't relax a column
// constraint in place — the table is rebuilt and copied.
function migrateWatchesForManual(db) {
  const cols = db.prepare(`PRAGMA table_info(watches)`).all();
  if (cols.length === 0) return; // fresh DB — schema.sql creates it correctly
  const cardId = cols.find((c) => c.name === 'card_id');
  const hasDescription = cols.some((c) => c.name === 'description');
  if (hasDescription && cardId && cardId.notnull === 0) return; // already migrated

  // listings.watch_id references watches, so the swap needs FK enforcement
  // off — and PRAGMA foreign_keys is a no-op inside a transaction, hence
  // outside the BEGIN.
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
    BEGIN;
    CREATE TABLE watches_migrated (
      id               INTEGER PRIMARY KEY,
      card_id          INTEGER REFERENCES cards(id),
      description      TEXT,
      grading_company  TEXT NOT NULL,
      grade            TEXT NOT NULL,
      max_price        REAL,
      enabled          INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at  TEXT,
      UNIQUE(card_id, grading_company, grade)
    );
    INSERT INTO watches_migrated
      (id, card_id, grading_company, grade, max_price, enabled, created_at, last_checked_at)
      SELECT id, card_id, grading_company, grade, max_price, enabled, created_at, last_checked_at
      FROM watches;
    DROP TABLE watches;
    ALTER TABLE watches_migrated RENAME TO watches;
    COMMIT;
  `);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// One-time-per-DB cleanup for rows written before dismissed/ended listings
// were deleted outright (2026-07-30): move any 'dismissed' rows into the
// permanent blocklist first, then drop both statuses. A no-op once a DB has
// no such rows left, so it's cheap to run on every startup.
function purgeDismissedAndEndedListings(db) {
  const cols = db.prepare(`PRAGMA table_info(listings)`).all().map((c) => c.name);
  if (!cols.includes('status')) return; // fresh DB, schema.sql just built it clean
  db.exec(`
    INSERT OR IGNORE INTO dismissed_listings (watch_id, source, listing_id, canonical_key)
      SELECT watch_id, source, listing_id, canonical_key FROM listings WHERE status = 'dismissed';
    DELETE FROM listings WHERE status IN ('dismissed', 'ended');
  `);
}

export function syncPlayersFromConfig(db, players) {
  const upsert = db.prepare(`
    INSERT INTO players (name, search_term, enabled)
    VALUES (@name, @searchTerm, @enabled)
    ON CONFLICT(name) DO UPDATE SET
      search_term = excluded.search_term,
      enabled = excluded.enabled
  `);
  const tx = db.transaction((list) => {
    for (const p of list) {
      upsert.run({ name: p.name, searchTerm: p.searchTerm, enabled: p.enabled === false ? 0 : 1 });
    }
  });
  tx(players);
}
