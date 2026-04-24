-- migrations/user_accumulation/002_chain_indexer_cursor.sqlite.sql
-- SQLite variant of the cursor table.

CREATE TABLE IF NOT EXISTS user_accum_chain_cursor (
  chain_id         INTEGER PRIMARY KEY,
  contract_address TEXT NOT NULL,
  last_block       INTEGER NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
