CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  search_term   TEXT,
  cl_player_id  TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
  id            INTEGER PRIMARY KEY,
  player_id     INTEGER REFERENCES players(id),
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
  population       INTEGER,
  num_sales        INTEGER,
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

-- ============ marketplace watcher ============

-- One row per watched (card, grading company, grade). Two kinds:
--   * flagged from the disparity table -> card_id set, description NULL
--   * added by hand on the Watched tab -> card_id NULL, description = the
--     typed text (every word of which must appear in a listing title)
-- max_price is a USD cap on matched listings (NULL = none).
CREATE TABLE IF NOT EXISTS watches (
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

-- Every marketplace listing that ever matched a watch. Rows are kept after a
-- listing ends so history stays visible. One listing = one row: dedupe is
-- (source, listing_id), plus canonical_key for the same item surfacing via
-- two sources (e.g. an eBay listing mirrored by an aggregator) — first watch
-- to match keeps the row, later sightings just refresh price/last_seen_at.
CREATE TABLE IF NOT EXISTS listings (
  id             INTEGER PRIMARY KEY,
  watch_id       INTEGER NOT NULL REFERENCES watches(id),
  source         TEXT NOT NULL,
  listing_id     TEXT NOT NULL,
  canonical_key  TEXT,
  title          TEXT NOT NULL,
  url            TEXT,
  price          REAL,
  currency       TEXT DEFAULT 'USD',
  price_usd      REAL,
  listing_type   TEXT CHECK (listing_type IN ('auction','fixed')),
  ends_at        TEXT,
  image_url      TEXT,
  seller         TEXT,
  match_score    REAL,
  match_debug    TEXT,
  status         TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','notified','dismissed','ended')),
  reminder_sent  INTEGER NOT NULL DEFAULT 0,
  misses         INTEGER NOT NULL DEFAULT 0,
  found_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, listing_id)
);

-- Work queue for one check cycle, mirroring sync_runs/sync_items: one item
-- per (watch, source) so an interrupted check resumes with only its pending
-- items.
CREATE TABLE IF NOT EXISTS watch_check_runs (
  id              INTEGER PRIMARY KEY,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  trigger_kind    TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_kind IN ('manual','scheduled')),
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','completed','failed','cancelled')),
  items_total     INTEGER NOT NULL DEFAULT 0,
  items_processed INTEGER NOT NULL DEFAULT 0,
  items_failed    INTEGER NOT NULL DEFAULT 0,
  new_listings    INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS watch_check_items (
  id        INTEGER PRIMARY KEY,
  run_id    INTEGER NOT NULL REFERENCES watch_check_runs(id),
  watch_id  INTEGER NOT NULL REFERENCES watches(id),
  source    TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts  INTEGER NOT NULL DEFAULT 0,
  error     TEXT,
  UNIQUE(run_id, watch_id, source)
);

-- Per-source bookkeeping: kill switch, 429 backoff, cached auth (e.g. the
-- eBay OAuth token, so restarts don't re-mint).
CREATE TABLE IF NOT EXISTS source_state (
  source           TEXT PRIMARY KEY,
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_request_at  TEXT,
  backoff_until    TEXT,
  auth_json        TEXT
);

-- Tiny key/value cache (currently: daily FX rates for USD normalization).
CREATE TABLE IF NOT EXISTS kv_cache (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cards_player ON cards(player_id);
CREATE INDEX IF NOT EXISTS idx_grade_prices_card ON grade_prices(card_id);
-- Serves the disparity query's driving scan (grading_company = X AND grade IN …).
CREATE INDEX IF NOT EXISTS idx_grade_prices_company_grade ON grade_prices(grading_company, grade, card_id);
CREATE INDEX IF NOT EXISTS idx_sync_items_run_status ON sync_items(sync_run_id, status);
-- UNIQUE(card_id,…) can't police manual watches (SQLite treats NULL card_ids
-- as distinct), so they get their own uniqueness rule.
CREATE UNIQUE INDEX IF NOT EXISTS idx_watches_manual
  ON watches(description, grading_company, grade) WHERE card_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_listings_watch_status ON listings(watch_id, status);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, found_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_canonical ON listings(canonical_key) WHERE canonical_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_watch_check_items_run ON watch_check_items(run_id, status);
