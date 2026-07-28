CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  search_term   TEXT NOT NULL,
  cl_player_id  TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
  id            INTEGER PRIMARY KEY,
  player_id     INTEGER NOT NULL REFERENCES players(id),
  cl_card_id    TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  set_name      TEXT,
  year          INTEGER,
  card_number   TEXT,
  parallel      TEXT,
  cl_url        TEXT,
  raw_json      TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (card, grading company, grade), upserted on each sync.
-- All parseable grades are stored, not just 10s.
CREATE TABLE IF NOT EXISTS grade_prices (
  id               INTEGER PRIMARY KEY,
  card_id          INTEGER NOT NULL REFERENCES cards(id),
  grading_company  TEXT NOT NULL,
  grade            TEXT NOT NULL,
  cl_value         REAL,
  last_sale_price  REAL,
  last_sale_date   TEXT,
  sync_run_id      INTEGER REFERENCES sync_runs(id),
  captured_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(card_id, grading_company, grade)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id              INTEGER PRIMARY KEY,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','completed','failed','cancelled')),
  cards_total     INTEGER NOT NULL DEFAULT 0,
  cards_processed INTEGER NOT NULL DEFAULT 0,
  cards_failed    INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);

-- Work queue: lets an interrupted sync resume with only its pending items.
CREATE TABLE IF NOT EXISTS sync_items (
  id           INTEGER PRIMARY KEY,
  sync_run_id  INTEGER NOT NULL REFERENCES sync_runs(id),
  cl_card_id   TEXT NOT NULL,
  card_name    TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','done','failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  UNIQUE(sync_run_id, cl_card_id)
);

CREATE INDEX IF NOT EXISTS idx_cards_player ON cards(player_id);
CREATE INDEX IF NOT EXISTS idx_grade_prices_card ON grade_prices(card_id);
CREATE INDEX IF NOT EXISTS idx_sync_items_run_status ON sync_items(sync_run_id, status);
