-- migrations/path_b/001_escrow_tables.pg.sql
-- Idempotent migration for Path B on-chain escrow tables (PostgreSQL)
-- Run with: psql $DATABASE_URL -f migrations/path_b/001_escrow_tables.pg.sql

CREATE TABLE IF NOT EXISTS path_b_escrows (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id             BIGINT UNIQUE NOT NULL,
  tx_hash               TEXT,
  buyer_address         TEXT NOT NULL,
  seller_address        TEXT NOT NULL,
  amount                NUMERIC NOT NULL,
  delivery_deadline     TIMESTAMPTZ NOT NULL,
  review_deadline       TIMESTAMPTZ,
  state                 TEXT NOT NULL DEFAULT 'CREATED'
                          CHECK (state IN ('CREATED','DELIVERED','RELEASED','DISPUTED','RESOLVED','CANCELLED')),
  delivery_hash         TEXT,
  delivery_payload_uri  TEXT,
  verification_uri      TEXT,
  buyer_email           TEXT,
  seller_email          TEXT,
  verdict_hash          TEXT,
  resolved_buyer_bps    INT,
  resolved_seller_bps   INT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS path_b_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id     BIGINT NOT NULL,
  event_name    TEXT NOT NULL,
  block_number  BIGINT NOT NULL,
  tx_hash       TEXT NOT NULL,
  log_index     INT NOT NULL,
  payload       JSONB NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS path_b_indexer_cursor (
  chain_id          INT PRIMARY KEY,
  contract_address  TEXT NOT NULL,
  last_block        BIGINT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS path_b_notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id     BIGINT NOT NULL,
  event_name    TEXT NOT NULL,
  channel       TEXT NOT NULL,   -- 'email' | 'webhook'
  recipient     TEXT NOT NULL,   -- email address or webhook URL
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','delivered','failed')),
  attempt_count INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for common query patterns
CREATE INDEX IF NOT EXISTS idx_path_b_escrows_state      ON path_b_escrows (state);
CREATE INDEX IF NOT EXISTS idx_path_b_escrows_state_rdl  ON path_b_escrows (state, review_deadline);
CREATE INDEX IF NOT EXISTS idx_path_b_events_escrow_id   ON path_b_events (escrow_id);
CREATE INDEX IF NOT EXISTS idx_path_b_notif_escrow_id    ON path_b_notifications (escrow_id);
