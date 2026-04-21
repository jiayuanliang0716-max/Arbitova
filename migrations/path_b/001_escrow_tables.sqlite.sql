-- migrations/path_b/001_escrow_tables.sqlite.sql
-- Idempotent migration for Path B on-chain escrow tables (SQLite — local dev only)
-- Run with: sqlite3 a2a.db < migrations/path_b/001_escrow_tables.sqlite.sql

CREATE TABLE IF NOT EXISTS path_b_escrows (
  id                    TEXT PRIMARY KEY,
  escrow_id             INTEGER UNIQUE NOT NULL,
  tx_hash               TEXT,
  buyer_address         TEXT NOT NULL,
  seller_address        TEXT NOT NULL,
  amount                TEXT NOT NULL,  -- stored as string to avoid float precision loss
  delivery_deadline     TEXT NOT NULL,  -- ISO-8601 string
  review_deadline       TEXT,
  state                 TEXT NOT NULL DEFAULT 'CREATED',
  delivery_hash         TEXT,
  delivery_payload_uri  TEXT,
  verification_uri      TEXT,
  buyer_email           TEXT,
  seller_email          TEXT,
  verdict_hash          TEXT,
  resolved_buyer_bps    INTEGER,
  resolved_seller_bps   INTEGER,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS path_b_events (
  id            TEXT PRIMARY KEY,
  escrow_id     INTEGER NOT NULL,
  event_name    TEXT NOT NULL,
  block_number  INTEGER NOT NULL,
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  payload       TEXT NOT NULL,  -- JSON.stringify
  processed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS path_b_indexer_cursor (
  chain_id          INTEGER PRIMARY KEY,
  contract_address  TEXT NOT NULL,
  last_block        INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS path_b_notifications (
  id            TEXT PRIMARY KEY,
  escrow_id     INTEGER NOT NULL,
  event_name    TEXT NOT NULL,
  channel       TEXT NOT NULL,
  recipient     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  sent_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_path_b_escrows_state      ON path_b_escrows (state);
CREATE INDEX IF NOT EXISTS idx_path_b_escrows_state_rdl  ON path_b_escrows (state, review_deadline);
CREATE INDEX IF NOT EXISTS idx_path_b_events_escrow_id   ON path_b_events (escrow_id);
CREATE INDEX IF NOT EXISTS idx_path_b_notif_escrow_id    ON path_b_notifications (escrow_id);
