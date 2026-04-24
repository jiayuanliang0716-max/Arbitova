-- migrations/user_accumulation/001_user_events.sqlite.sql
-- SQLite variant for local dev. Mirrors the Postgres schema with
-- JSONB→TEXT, TEXT[]→TEXT(JSON), TIMESTAMPTZ→TEXT(ISO).

CREATE TABLE IF NOT EXISTS user_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  event_type   TEXT NOT NULL,
  ip_hash      TEXT,
  wallet       TEXT,
  github       TEXT,
  email        TEXT,
  api_key_id   TEXT,
  path         TEXT,
  referrer     TEXT,
  ua_family    TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}',
  heat_points  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_user_events_ts      ON user_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_user_events_type    ON user_events (event_type);
CREATE INDEX IF NOT EXISTS idx_user_events_wallet  ON user_events (wallet);
CREATE INDEX IF NOT EXISTS idx_user_events_github  ON user_events (github);
CREATE INDEX IF NOT EXISTS idx_user_events_api_key ON user_events (api_key_id);
CREATE INDEX IF NOT EXISTS idx_user_events_ip_hash ON user_events (ip_hash);

CREATE TABLE IF NOT EXISTS user_entities (
  id            TEXT PRIMARY KEY,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  total_heat    INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'cold'
                  CHECK (state IN ('cold','warm','hot','customer','reference','ignored')),
  wallets       TEXT NOT NULL DEFAULT '[]',
  githubs       TEXT NOT NULL DEFAULT '[]',
  emails        TEXT NOT NULL DEFAULT '[]',
  api_key_ids   TEXT NOT NULL DEFAULT '[]',
  ip_hashes     TEXT NOT NULL DEFAULT '[]',
  project_name  TEXT,
  project_url   TEXT,
  project_logo  TEXT,
  notes         TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_entities_state      ON user_entities (state);
CREATE INDEX IF NOT EXISTS idx_user_entities_total_heat ON user_entities (total_heat DESC);
CREATE INDEX IF NOT EXISTS idx_user_entities_last_seen  ON user_entities (last_seen DESC);

CREATE TABLE IF NOT EXISTS attribution_keys (
  id              TEXT PRIMARY KEY,
  key_hash        TEXT UNIQUE NOT NULL,
  project_name    TEXT NOT NULL,
  project_url     TEXT NOT NULL,
  project_logo    TEXT,
  contact_email   TEXT NOT NULL,
  contact_wallet  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at     TEXT,
  revoked_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_attribution_keys_verified ON attribution_keys (verified_at);

CREATE TABLE IF NOT EXISTS outreach_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  channel      TEXT NOT NULL,
  target       TEXT NOT NULL,
  target_kind  TEXT NOT NULL,
  subject      TEXT,
  body_excerpt TEXT,
  response     TEXT,
  entity_id    TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_outreach_log_ts       ON outreach_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_log_channel  ON outreach_log (channel);
CREATE INDEX IF NOT EXISTS idx_outreach_log_target   ON outreach_log (target);

CREATE TABLE IF NOT EXISTS github_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  repo        TEXT NOT NULL,
  stars       INTEGER NOT NULL,
  forks       INTEGER NOT NULL,
  watchers    INTEGER NOT NULL,
  open_issues INTEGER NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_github_snapshots_repo_ts ON github_snapshots (repo, ts DESC);
