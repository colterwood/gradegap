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
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
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
