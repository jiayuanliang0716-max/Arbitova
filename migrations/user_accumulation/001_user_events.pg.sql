-- migrations/user_accumulation/001_user_events.pg.sql
-- User accumulation system — event capture + entity resolution + attribution.
-- Design doc: docs/user-accumulation-system.md
-- Run with: psql $DATABASE_URL -f migrations/user_accumulation/001_user_events.pg.sql

-- Raw event log: one row per request/signal. Never modified; append-only.
CREATE TABLE IF NOT EXISTS user_events (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type   TEXT NOT NULL,
  ip_hash      TEXT,
  wallet       TEXT,
  github       TEXT,
  email        TEXT,
  api_key_id   TEXT,
  path         TEXT,
  referrer     TEXT,
  ua_family    TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  heat_points  INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_user_events_ts         ON user_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_user_events_type       ON user_events (event_type);
CREATE INDEX IF NOT EXISTS idx_user_events_wallet     ON user_events (wallet)   WHERE wallet IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_events_github     ON user_events (github)   WHERE github IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_events_api_key    ON user_events (api_key_id) WHERE api_key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_events_ip_hash    ON user_events (ip_hash)  WHERE ip_hash IS NOT NULL;

-- Resolved entities: one row per inferred person/project.
-- Populated by the identity resolution job; wallet > github > api_key_id > ip_hash.
CREATE TABLE IF NOT EXISTS user_entities (
  id            TEXT PRIMARY KEY,
  first_seen    TIMESTAMPTZ NOT NULL,
  last_seen     TIMESTAMPTZ NOT NULL,
  total_heat    INT NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'cold'
                  CHECK (state IN ('cold','warm','hot','customer','reference','ignored')),
  wallets       TEXT[] NOT NULL DEFAULT '{}',
  githubs       TEXT[] NOT NULL DEFAULT '{}',
  emails        TEXT[] NOT NULL DEFAULT '{}',
  api_key_ids   TEXT[] NOT NULL DEFAULT '{}',
  ip_hashes     TEXT[] NOT NULL DEFAULT '{}',
  project_name  TEXT,
  project_url   TEXT,
  project_logo  TEXT,
  notes         TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_entities_state      ON user_entities (state);
CREATE INDEX IF NOT EXISTS idx_user_entities_total_heat ON user_entities (total_heat DESC);
CREATE INDEX IF NOT EXISTS idx_user_entities_last_seen  ON user_entities (last_seen DESC);

-- Attribution keys: projects voluntarily identify themselves in exchange for
-- logo display on /verdicts. key_hash (sha256) is what the server stores; the
-- plaintext key is returned to the project ONCE at signup.
CREATE TABLE IF NOT EXISTS attribution_keys (
  id              TEXT PRIMARY KEY,
  key_hash        TEXT UNIQUE NOT NULL,
  project_name    TEXT NOT NULL,
  project_url     TEXT NOT NULL,
  project_logo    TEXT,
  contact_email   TEXT NOT NULL,
  contact_wallet  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at     TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_attribution_keys_verified ON attribution_keys (verified_at) WHERE revoked_at IS NULL;

-- Outreach log: every cold DM / email / GitHub issue comment I send out.
-- Used to correlate outreach → visit → signup in the funnel.
CREATE TABLE IF NOT EXISTS outreach_log (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel      TEXT NOT NULL,
  target       TEXT NOT NULL,
  target_kind  TEXT NOT NULL,
  subject      TEXT,
  body_excerpt TEXT,
  response     TEXT,
  entity_id    TEXT REFERENCES user_entities(id),
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_outreach_log_ts       ON outreach_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_log_channel  ON outreach_log (channel);
CREATE INDEX IF NOT EXISTS idx_outreach_log_target   ON outreach_log (target);

-- GitHub snapshot: daily point-in-time copy of stars/forks/issues counts.
CREATE TABLE IF NOT EXISTS github_snapshots (
  id         BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  repo       TEXT NOT NULL,
  stars      INT NOT NULL,
  forks      INT NOT NULL,
  watchers   INT NOT NULL,
  open_issues INT NOT NULL,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_github_snapshots_repo_ts ON github_snapshots (repo, ts DESC);
