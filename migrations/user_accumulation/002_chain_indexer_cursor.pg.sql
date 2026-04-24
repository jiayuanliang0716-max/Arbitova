-- migrations/user_accumulation/002_chain_indexer_cursor.pg.sql
-- Cursor table for the in-process chain indexer that feeds user_events with
-- wallet-scoped events from on-chain EscrowV1 activity.
-- Separate from path_b_indexer_cursor so user_accumulation does not depend on
-- path_b being deployed.

CREATE TABLE IF NOT EXISTS user_accum_chain_cursor (
  chain_id         BIGINT PRIMARY KEY,
  contract_address TEXT NOT NULL,
  last_block       BIGINT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
