/**
 * 資料庫連線與 schema 初始化
 *
 * 本機開發：使用 SQLite（DATABASE_URL 未設定時）
 * Railway 部署：使用 PostgreSQL（DATABASE_URL 由 Railway 自動注入）
 */

const DATABASE_URL = process.env.DATABASE_URL;

let db;

if (DATABASE_URL) {
  // PostgreSQL 模式（Railway 部署）
  const { Pool } = require('pg');

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4
  });

  // 初始化資料表
  async function initSchema() {
    // Drop zombie tables from pre-focus era (safe: user confirmed no real users yet)
    await pool.query(`
      DROP TABLE IF EXISTS request_applications CASCADE;
      DROP TABLE IF EXISTS requests CASCADE;
      DROP TABLE IF EXISTS messages CASCADE;
      DROP TABLE IF EXISTS subscriptions CASCADE;
      DROP TABLE IF EXISTS reviews CASCADE;
      DROP TABLE IF EXISTS payments CASCADE;
      DROP TABLE IF EXISTS telegram_commands CASCADE;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        description      TEXT,
        api_key          TEXT UNIQUE NOT NULL,
        owner_email      TEXT,
        balance          NUMERIC DEFAULT 100.0,
        escrow           NUMERIC DEFAULT 0.0,
        reputation_score INTEGER DEFAULT 0,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS reputation_score INTEGER DEFAULT 0;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS escrow NUMERIC DEFAULT 0.0;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS wallet_address TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS wallet_encrypted_key TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS supabase_user_id TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS auth_provider TEXT;

      CREATE TABLE IF NOT EXISTS deposits (
        id         TEXT PRIMARY KEY,
        agent_id   TEXT NOT NULL REFERENCES agents(id),
        amount     NUMERIC NOT NULL,
        tx_hash    TEXT UNIQUE NOT NULL,
        from_address TEXT,
        confirmed_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS withdrawals (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL REFERENCES agents(id),
        amount      NUMERIC NOT NULL,
        to_address  TEXT NOT NULL,
        tx_hash     TEXT,
        status      TEXT DEFAULT 'pending',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS reputation_history (
        id         SERIAL PRIMARY KEY,
        agent_id   TEXT NOT NULL REFERENCES agents(id),
        delta      INTEGER NOT NULL,
        reason     TEXT NOT NULL,
        order_id   TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS services (
        id                 TEXT PRIMARY KEY,
        agent_id           TEXT NOT NULL REFERENCES agents(id),
        name               TEXT NOT NULL,
        description        TEXT,
        price              NUMERIC NOT NULL,
        delivery_hours     INTEGER DEFAULT 24,
        is_active          BOOLEAN DEFAULT TRUE,
        input_schema       JSONB,
        output_schema      JSONB,
        min_seller_stake   NUMERIC DEFAULT 0,
        created_at         TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE services ADD COLUMN IF NOT EXISTS input_schema JSONB;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS output_schema JSONB;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS min_seller_stake NUMERIC DEFAULT 0;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'general';
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS stake NUMERIC DEFAULT 0;

      CREATE TABLE IF NOT EXISTS reputation_by_category (
        id         SERIAL PRIMARY KEY,
        agent_id   TEXT NOT NULL REFERENCES agents(id),
        category   TEXT NOT NULL,
        score      INTEGER DEFAULT 0,
        order_count INTEGER DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (agent_id, category)
      );

      CREATE TABLE IF NOT EXISTS orders (
        id           TEXT PRIMARY KEY,
        buyer_id     TEXT NOT NULL REFERENCES agents(id),
        seller_id    TEXT NOT NULL REFERENCES agents(id),
        service_id   TEXT NOT NULL REFERENCES services(id),
        status       TEXT DEFAULT 'paid',
        amount       NUMERIC NOT NULL,
        requirements TEXT,
        bundle_id    TEXT,
        deadline     TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS bundle_id TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS parent_order_id TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS counter_offer TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller_extension_used BOOLEAN DEFAULT FALSE;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS revision_count INTEGER DEFAULT 0;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS max_revisions INTEGER DEFAULT 3;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS spot_order_title TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS comments TEXT;
      ALTER TABLE orders ALTER COLUMN service_id DROP NOT NULL;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS away_mode TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS blocklist TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS capability_tags TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS service_templates TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS settings TEXT;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS rate_card TEXT;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS min_buyer_trust INTEGER DEFAULT 0;

      CREATE TABLE IF NOT EXISTS order_bundles (
        id           TEXT PRIMARY KEY,
        buyer_id     TEXT NOT NULL REFERENCES agents(id),
        total_amount NUMERIC NOT NULL,
        status       TEXT DEFAULT 'active',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id           TEXT PRIMARY KEY,
        order_id     TEXT NOT NULL REFERENCES orders(id),
        content      TEXT NOT NULL,
        delivered_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS disputes (
        id          TEXT PRIMARY KEY,
        order_id    TEXT NOT NULL REFERENCES orders(id),
        raised_by   TEXT NOT NULL REFERENCES agents(id),
        reason      TEXT NOT NULL,
        evidence    TEXT,
        status      TEXT DEFAULT 'open',
        resolution  TEXT,
        appealed    BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );

      ALTER TABLE disputes ADD COLUMN IF NOT EXISTS appealed BOOLEAN DEFAULT FALSE;
      ALTER TABLE disputes ADD COLUMN IF NOT EXISTS bond_amount NUMERIC DEFAULT 0;

      CREATE TABLE IF NOT EXISTS api_keys (
        id           TEXT PRIMARY KEY,
        agent_id     TEXT NOT NULL REFERENCES agents(id),
        key_hash     TEXT NOT NULL,
        key_prefix   TEXT NOT NULL,
        name         TEXT,
        scope        TEXT DEFAULT 'full',
        is_active    BOOLEAN DEFAULT TRUE,
        last_used_at TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS webhooks (
        id                TEXT PRIMARY KEY,
        agent_id          TEXT NOT NULL REFERENCES agents(id),
        url               TEXT NOT NULL,
        events            JSONB NOT NULL,
        secret            TEXT NOT NULL,
        is_active         BOOLEAN DEFAULT TRUE,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        last_triggered_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id            TEXT PRIMARY KEY,
        webhook_id    TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        event_type    TEXT NOT NULL,
        payload       TEXT NOT NULL,
        response_code INTEGER,
        attempts      INTEGER DEFAULT 1,
        status        TEXT DEFAULT 'pending',
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        delivered_at  TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        id              SERIAL PRIMARY KEY,
        key_value       TEXT NOT NULL UNIQUE,
        status          TEXT DEFAULT 'processing',
        response_status INTEGER,
        response_body   TEXT,
        expires_at      TIMESTAMPTZ NOT NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);

      CREATE TABLE IF NOT EXISTS human_review_queue (
        id           TEXT PRIMARY KEY,
        order_id     TEXT NOT NULL REFERENCES orders(id),
        dispute_id   TEXT NOT NULL,
        ai_votes     JSONB NOT NULL,
        ai_reasoning TEXT,
        ai_confidence NUMERIC,
        escalation_reason TEXT,
        status       TEXT DEFAULT 'pending',
        reviewed_by  TEXT,
        resolution   TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        resolved_at  TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS platform_revenue (
        id               TEXT PRIMARY KEY DEFAULT 'singleton',
        balance          NUMERIC(18,6) NOT NULL DEFAULT 0,
        total_earned     NUMERIC(18,6) NOT NULL DEFAULT 0,
        total_withdrawn  NUMERIC(18,6) NOT NULL DEFAULT 0,
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO platform_revenue (id, balance, total_earned, total_withdrawn)
      VALUES ('singleton', 0, 0, 0) ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS tips (
        id          TEXT PRIMARY KEY,
        order_id    TEXT NOT NULL REFERENCES orders(id),
        from_id     TEXT NOT NULL REFERENCES agents(id),
        to_id       TEXT NOT NULL REFERENCES agents(id),
        amount      NUMERIC(18,6) NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tips_order ON tips (order_id);

      CREATE TABLE IF NOT EXISTS agent_credentials (
        id           TEXT PRIMARY KEY,
        agent_id     TEXT NOT NULL REFERENCES agents(id),
        type         TEXT NOT NULL,
        title        TEXT NOT NULL,
        description  TEXT,
        issuer       TEXT,
        issuer_url   TEXT,
        proof        TEXT,
        scope        TEXT,
        expires_at   TIMESTAMPTZ,
        self_attested BOOLEAN DEFAULT TRUE,
        is_public    BOOLEAN DEFAULT TRUE,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_credentials_agent ON agent_credentials (agent_id);

      CREATE TABLE IF NOT EXISTS site_config (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        text       TEXT NOT NULL,
        url        TEXT,
        active     BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS posts (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        slug         TEXT NOT NULL UNIQUE,
        content      TEXT NOT NULL,
        excerpt      TEXT,
        cover_image  TEXT,
        category     TEXT DEFAULT 'update',
        author_name  TEXT DEFAULT 'Arbitova Team',
        published    BOOLEAN DEFAULT TRUE,
        pinned       BOOLEAN DEFAULT FALSE,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts (slug);
      CREATE INDEX IF NOT EXISTS idx_posts_published ON posts (published, created_at DESC);
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS cover_image TEXT;
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE;

      CREATE TABLE IF NOT EXISTS arbitration_transactions (
        id              TEXT PRIMARY KEY,
        api_key_owner   TEXT NOT NULL,
        buyer_ref       TEXT NOT NULL,
        seller_ref      TEXT NOT NULL,
        amount          NUMERIC,
        currency        TEXT DEFAULT 'USDC',
        requirements    TEXT NOT NULL,
        metadata        JSONB,
        status          TEXT DEFAULT 'active',
        verdict_id      TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_arb_tx_owner ON arbitration_transactions (api_key_owner);
      CREATE INDEX IF NOT EXISTS idx_arb_tx_status ON arbitration_transactions (status);

      CREATE TABLE IF NOT EXISTS arbitration_evidence (
        id              TEXT PRIMARY KEY,
        transaction_id  TEXT NOT NULL REFERENCES arbitration_transactions(id),
        submitted_by    TEXT NOT NULL,
        role            TEXT NOT NULL,
        evidence_type   TEXT NOT NULL,
        content         TEXT NOT NULL,
        metadata        JSONB,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_arb_evidence_tx ON arbitration_evidence (transaction_id);

      CREATE TABLE IF NOT EXISTS arbitration_verdicts (
        id              TEXT PRIMARY KEY,
        transaction_id  TEXT NOT NULL REFERENCES arbitration_transactions(id),
        winner          TEXT NOT NULL,
        confidence      NUMERIC NOT NULL,
        method          TEXT NOT NULL,
        reasoning       TEXT,
        key_factors     JSONB,
        dissent         TEXT,
        votes           JSONB,
        escalate_to_human BOOLEAN DEFAULT FALSE,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_arb_verdicts_tx ON arbitration_verdicts (transaction_id);
    `);

    console.log('PostgreSQL schema initialized');
  }

  initSchema().catch(console.error);

  // 封裝成與 SQLite 相同的介面，方便 routes 呼叫
  db = {
    type: 'pg',
    pool,
    query: (sql, params) => pool.query(sql, params),
    // 模擬 better-sqlite3 的 prepare().get() 介面（回傳 Promise）
    prepare: (sql) => ({
      get: (...params) => pool.query(sql, params).then(r => r.rows[0] || null),
      all: (...params) => pool.query(sql, params).then(r => r.rows),
      run: (...params) => pool.query(sql, params)
    }),
    transaction: (fn) => async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await fn(client);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
  };

} else {
  // SQLite 模式（本機開發）
  const Database = require('better-sqlite3');
  const path = require('path');
  const fs = require('fs');

  const dataDir = path.join(__dirname, '../../data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const sqlite = new Database(path.join(dataDir, 'a2a.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Drop zombie tables from pre-focus era (safe: user confirmed no real users yet)
  try {
    sqlite.exec(`
      DROP TABLE IF EXISTS request_applications;
      DROP TABLE IF EXISTS requests;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS subscriptions;
      DROP TABLE IF EXISTS reviews;
      DROP TABLE IF EXISTS payments;
      DROP TABLE IF EXISTS telegram_commands;
    `);
  } catch (e) { console.error('Drop zombie tables warn:', e.message); }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      description      TEXT,
      api_key          TEXT UNIQUE NOT NULL,
      owner_email      TEXT,
      balance          REAL DEFAULT 100.0,
      escrow           REAL DEFAULT 0.0,
      reputation_score INTEGER DEFAULT 0,
      created_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reputation_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id   TEXT NOT NULL REFERENCES agents(id),
      delta      INTEGER NOT NULL,
      reason     TEXT NOT NULL,
      order_id   TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS services (
      id                 TEXT PRIMARY KEY,
      agent_id           TEXT NOT NULL REFERENCES agents(id),
      name               TEXT NOT NULL,
      description        TEXT,
      price              REAL NOT NULL,
      delivery_hours     INTEGER DEFAULT 24,
      is_active          INTEGER DEFAULT 1,
      input_schema       TEXT,
      output_schema      TEXT,
      min_seller_stake   REAL DEFAULT 0,
      created_at         TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_bundles (
      id           TEXT PRIMARY KEY,
      buyer_id     TEXT NOT NULL REFERENCES agents(id),
      total_amount REAL NOT NULL,
      status       TEXT DEFAULT 'active',
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id           TEXT PRIMARY KEY,
      buyer_id     TEXT NOT NULL REFERENCES agents(id),
      seller_id    TEXT NOT NULL REFERENCES agents(id),
      service_id   TEXT NOT NULL REFERENCES services(id),
      status       TEXT DEFAULT 'paid',
      amount       REAL NOT NULL,
      requirements TEXT,
      bundle_id    TEXT,
      deadline     TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id           TEXT PRIMARY KEY,
      order_id     TEXT NOT NULL REFERENCES orders(id),
      content      TEXT NOT NULL,
      delivered_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS disputes (
      id          TEXT PRIMARY KEY,
      order_id    TEXT NOT NULL REFERENCES orders(id),
      raised_by   TEXT NOT NULL REFERENCES agents(id),
      reason      TEXT NOT NULL,
      evidence    TEXT,
      status      TEXT DEFAULT 'open',
      resolution  TEXT,
      appealed    INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL REFERENCES agents(id),
      key_hash     TEXT NOT NULL,
      key_prefix   TEXT NOT NULL,
      name         TEXT,
      scope        TEXT DEFAULT 'full',
      is_active    INTEGER DEFAULT 1,
      last_used_at TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id                TEXT PRIMARY KEY,
      agent_id          TEXT NOT NULL REFERENCES agents(id),
      url               TEXT NOT NULL,
      events            TEXT NOT NULL,
      secret            TEXT NOT NULL,
      is_active         INTEGER DEFAULT 1,
      created_at        TEXT DEFAULT (datetime('now')),
      last_triggered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id            TEXT PRIMARY KEY,
      webhook_id    TEXT NOT NULL REFERENCES webhooks(id),
      event_type    TEXT NOT NULL,
      payload       TEXT NOT NULL,
      response_code INTEGER,
      attempts      INTEGER DEFAULT 1,
      status        TEXT DEFAULT 'pending',
      created_at    TEXT DEFAULT (datetime('now')),
      delivered_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      key_value       TEXT NOT NULL UNIQUE,
      status          TEXT DEFAULT 'processing',
      response_status INTEGER,
      response_body   TEXT,
      expires_at      TEXT NOT NULL,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);

    CREATE TABLE IF NOT EXISTS human_review_queue (
      id                TEXT PRIMARY KEY,
      order_id          TEXT NOT NULL REFERENCES orders(id),
      dispute_id        TEXT NOT NULL,
      ai_votes          TEXT NOT NULL,
      ai_reasoning      TEXT,
      ai_confidence     REAL,
      escalation_reason TEXT,
      status            TEXT DEFAULT 'pending',
      reviewed_by       TEXT,
      resolution        TEXT,
      created_at        TEXT DEFAULT (datetime('now')),
      resolved_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS platform_revenue (
      id               TEXT PRIMARY KEY DEFAULT 'singleton',
      balance          REAL NOT NULL DEFAULT 0,
      total_earned     REAL NOT NULL DEFAULT 0,
      total_withdrawn  REAL NOT NULL DEFAULT 0,
      updated_at       TEXT DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO platform_revenue (id, balance, total_earned, total_withdrawn)
    VALUES ('singleton', 0, 0, 0);

    CREATE TABLE IF NOT EXISTS deposits (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL REFERENCES agents(id),
      amount       REAL NOT NULL,
      tx_hash      TEXT UNIQUE NOT NULL,
      from_address TEXT,
      confirmed_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL REFERENCES agents(id),
      amount       REAL NOT NULL,
      to_address   TEXT NOT NULL,
      tx_hash      TEXT,
      status       TEXT DEFAULT 'pending',
      created_at   TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS arbitration_transactions (
      id              TEXT PRIMARY KEY,
      api_key_owner   TEXT NOT NULL,
      buyer_ref       TEXT NOT NULL,
      seller_ref      TEXT NOT NULL,
      amount          REAL,
      currency        TEXT DEFAULT 'USDC',
      requirements    TEXT NOT NULL,
      metadata        TEXT,
      status          TEXT DEFAULT 'active',
      verdict_id      TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_arb_tx_owner ON arbitration_transactions (api_key_owner);
    CREATE INDEX IF NOT EXISTS idx_arb_tx_status ON arbitration_transactions (status);

    CREATE TABLE IF NOT EXISTS arbitration_evidence (
      id              TEXT PRIMARY KEY,
      transaction_id  TEXT NOT NULL REFERENCES arbitration_transactions(id),
      submitted_by    TEXT NOT NULL,
      role            TEXT NOT NULL,
      evidence_type   TEXT NOT NULL,
      content         TEXT NOT NULL,
      metadata        TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_arb_evidence_tx ON arbitration_evidence (transaction_id);

    CREATE TABLE IF NOT EXISTS arbitration_verdicts (
      id              TEXT PRIMARY KEY,
      transaction_id  TEXT NOT NULL REFERENCES arbitration_transactions(id),
      winner          TEXT NOT NULL,
      confidence      REAL NOT NULL,
      method          TEXT NOT NULL,
      reasoning       TEXT,
      key_factors     TEXT,
      dissent         TEXT,
      votes           TEXT,
      escalate_to_human INTEGER DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_arb_verdicts_tx ON arbitration_verdicts (transaction_id);
  `);

  // Idempotent migrations for older SQLite DBs
  function addColIfMissing(table, col, ddl) {
    try {
      const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.find(c => c.name === col)) {
        sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
      }
    } catch (e) { console.error('Migration warn:', e.message); }
  }
  addColIfMissing('agents', 'reputation_score', 'INTEGER DEFAULT 0');
  addColIfMissing('agents', 'escrow', 'REAL DEFAULT 0');
  addColIfMissing('agents', 'stake', 'REAL DEFAULT 0');
  addColIfMissing('services', 'input_schema', 'TEXT');
  addColIfMissing('services', 'output_schema', 'TEXT');
  addColIfMissing('services', 'min_seller_stake', 'REAL DEFAULT 0');
  addColIfMissing('services', 'category', "TEXT DEFAULT 'general'");
  addColIfMissing('orders', 'bundle_id', 'TEXT');
  addColIfMissing('orders', 'parent_order_id', 'TEXT');
  addColIfMissing('agents', 'wallet_address', 'TEXT');
  addColIfMissing('agents', 'wallet_encrypted_key', 'TEXT');

  // tips table
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS tips (
        id          TEXT PRIMARY KEY,
        order_id    TEXT NOT NULL REFERENCES orders(id),
        from_id     TEXT NOT NULL REFERENCES agents(id),
        to_id       TEXT NOT NULL REFERENCES agents(id),
        amount      REAL NOT NULL,
        created_at  TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tips_order ON tips (order_id);
    `);
  } catch(e) { console.error('Migration warn:', e.message); }

  addColIfMissing('orders', 'counter_offer', 'TEXT');
  addColIfMissing('orders', 'seller_extension_used', 'INTEGER');
  addColIfMissing('orders', 'revision_count', 'INTEGER');
  addColIfMissing('orders', 'max_revisions', 'INTEGER');
  addColIfMissing('orders', 'spot_order_title', 'TEXT');
  addColIfMissing('orders', 'comments', 'TEXT');
  addColIfMissing('agents', 'away_mode', 'TEXT');
  addColIfMissing('agents', 'blocklist', 'TEXT');
  addColIfMissing('agents', 'capability_tags', 'TEXT');
  addColIfMissing('agents', 'service_templates', 'TEXT');
  addColIfMissing('agents', 'settings', 'TEXT');
  addColIfMissing('services', 'min_buyer_trust', 'INTEGER');

  // rate_card on services — JSON array of volume pricing tiers
  addColIfMissing('services', 'rate_card', 'TEXT');

  // agent_credentials table
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_credentials (
        id            TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL REFERENCES agents(id),
        type          TEXT NOT NULL,
        title         TEXT NOT NULL,
        description   TEXT,
        issuer        TEXT,
        issuer_url    TEXT,
        proof         TEXT,
        scope         TEXT,
        expires_at    TEXT,
        self_attested INTEGER DEFAULT 1,
        is_public     INTEGER DEFAULT 1,
        created_at    TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_credentials_agent ON agent_credentials (agent_id);
    `);
  } catch(e) { console.error('Migration warn (credentials):', e.message); }

  // reputation_by_category table
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS reputation_by_category (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    TEXT NOT NULL REFERENCES agents(id),
        category    TEXT NOT NULL,
        score       INTEGER DEFAULT 0,
        order_count INTEGER DEFAULT 0,
        updated_at  TEXT DEFAULT (datetime('now')),
        UNIQUE (agent_id, category)
      );
    `);
  } catch(e) { console.error('Migration warn:', e.message); }

  // Dispute bond column (P2-1 upgrade)
  addColIfMissing('disputes', 'bond_amount', 'REAL DEFAULT 0');

  console.log('SQLite schema initialized');

  db = {
    type: 'sqlite',
    prepare: (sql) => sqlite.prepare(sql),
    transaction: (fn) => sqlite.transaction(fn)
  };
}

module.exports = db;
