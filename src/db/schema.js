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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_commands (
        id           SERIAL PRIMARY KEY,
        command      TEXT NOT NULL,
        status       TEXT DEFAULT 'pending',
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        processed_at TIMESTAMPTZ
      );

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
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS wallet_address TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS wallet_encrypted_key TEXT;

      CREATE TABLE IF NOT EXISTS deposits (
        id         TEXT PRIMARY KEY,
        agent_id   TEXT NOT NULL REFERENCES agents(id),
        amount     NUMERIC NOT NULL,
        tx_hash    TEXT UNIQUE NOT NULL,
        from_address TEXT,
        confirmed_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payments (
        id                    TEXT PRIMARY KEY,
        agent_id              TEXT NOT NULL REFERENCES agents(id),
        service_id            TEXT REFERENCES services(id),
        amount_cents          INTEGER DEFAULT 0,
        status                TEXT DEFAULT 'pending',
        provider              TEXT DEFAULT 'lemonsqueezy',
        provider_checkout_id  TEXT,
        provider_order_id     TEXT,
        created_at            TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_id TEXT REFERENCES services(id);

      CREATE TABLE IF NOT EXISTS reviews (
        id          TEXT PRIMARY KEY,
        order_id    TEXT NOT NULL REFERENCES orders(id),
        service_id  TEXT NOT NULL REFERENCES services(id),
        reviewer_id TEXT NOT NULL REFERENCES agents(id),
        seller_id   TEXT NOT NULL REFERENCES agents(id),
        rating      INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
        comment     TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
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
        verification_rules JSONB,
        auto_verify        BOOLEAN DEFAULT FALSE,
        min_seller_stake   NUMERIC DEFAULT 0,
        created_at         TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE services ADD COLUMN IF NOT EXISTS input_schema JSONB;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS output_schema JSONB;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS verification_rules JSONB;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS auto_verify BOOLEAN DEFAULT FALSE;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS semantic_verify BOOLEAN DEFAULT FALSE;
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
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS expected_hash TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS release_oracle_url TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS release_oracle_secret TEXT;
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
      ALTER TABLE services ADD COLUMN IF NOT EXISTS sub_price NUMERIC DEFAULT 0;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS sub_interval TEXT DEFAULT NULL;

      CREATE TABLE IF NOT EXISTS subscriptions (
        id             TEXT PRIMARY KEY,
        buyer_id       TEXT NOT NULL REFERENCES agents(id),
        seller_id      TEXT NOT NULL REFERENCES agents(id),
        service_id     TEXT NOT NULL REFERENCES services(id),
        interval       TEXT NOT NULL,
        price          NUMERIC NOT NULL,
        status         TEXT DEFAULT 'active',
        next_billing_at TIMESTAMPTZ NOT NULL,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        cancelled_at   TIMESTAMPTZ
      );

      ALTER TABLE orders ADD COLUMN IF NOT EXISTS subscription_id TEXT;

      CREATE TABLE IF NOT EXISTS files (
        id          TEXT PRIMARY KEY,
        uploader_id TEXT NOT NULL REFERENCES agents(id),
        filename    TEXT NOT NULL,
        mimetype    TEXT,
        size        INTEGER,
        content     TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE services ADD COLUMN IF NOT EXISTS file_id TEXT REFERENCES files(id);
      ALTER TABLE services ADD COLUMN IF NOT EXISTS market_type TEXT DEFAULT 'h2a';
      ALTER TABLE services ADD COLUMN IF NOT EXISTS product_type TEXT DEFAULT 'ai_generated';

      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        recipient_id    TEXT NOT NULL REFERENCES agents(id),
        sender_id       TEXT REFERENCES agents(id),
        subject         TEXT,
        body            TEXT NOT NULL,
        order_id        TEXT REFERENCES orders(id),
        subscription_id TEXT,
        is_read         BOOLEAN DEFAULT FALSE,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );

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

      CREATE TABLE IF NOT EXISTS requests (
        id              TEXT PRIMARY KEY,
        buyer_id        TEXT NOT NULL REFERENCES agents(id),
        title           TEXT NOT NULL,
        description     TEXT NOT NULL,
        budget_usdc     NUMERIC(18,6) NOT NULL,
        category        TEXT,
        delivery_hours  INTEGER,
        expires_at      TIMESTAMPTZ NOT NULL,
        status          TEXT DEFAULT 'open',
        accepted_order_id TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_requests_buyer ON requests (buyer_id);
      CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);

      CREATE TABLE IF NOT EXISTS request_applications (
        id             TEXT PRIMARY KEY,
        request_id     TEXT NOT NULL REFERENCES requests(id),
        seller_id      TEXT NOT NULL REFERENCES agents(id),
        service_id     TEXT NOT NULL REFERENCES services(id),
        proposed_price NUMERIC(18,6) NOT NULL,
        message        TEXT,
        status         TEXT DEFAULT 'pending',
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (request_id, seller_id)
      );
      CREATE INDEX IF NOT EXISTS idx_req_app_request ON request_applications (request_id);

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
    `);

    // One-time migrations: set product_type for existing data
    await pool.query(`
      UPDATE services SET product_type = 'digital' WHERE file_id IS NOT NULL AND (product_type IS NULL OR product_type = 'ai_generated');
      UPDATE services SET product_type = 'subscription' WHERE sub_interval IS NOT NULL AND COALESCE(sub_price, 0) > 0 AND (product_type IS NULL OR product_type = 'ai_generated');
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

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS telegram_commands (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      command    TEXT NOT NULL,
      status     TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT
    );

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
      verification_rules TEXT,
      auto_verify        INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS subscriptions (
      id              TEXT PRIMARY KEY,
      buyer_id        TEXT NOT NULL REFERENCES agents(id),
      seller_id       TEXT NOT NULL REFERENCES agents(id),
      service_id      TEXT NOT NULL REFERENCES services(id),
      interval        TEXT NOT NULL,
      price           REAL NOT NULL,
      status          TEXT DEFAULT 'active',
      next_billing_at TEXT NOT NULL,
      created_at      TEXT DEFAULT (datetime('now')),
      cancelled_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      id          TEXT PRIMARY KEY,
      uploader_id TEXT NOT NULL REFERENCES agents(id),
      filename    TEXT NOT NULL,
      mimetype    TEXT,
      size        INTEGER,
      content     TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      recipient_id    TEXT NOT NULL REFERENCES agents(id),
      sender_id       TEXT REFERENCES agents(id),
      subject         TEXT,
      body            TEXT NOT NULL,
      order_id        TEXT REFERENCES orders(id),
      subscription_id TEXT,
      is_read         INTEGER DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS reviews (
      id          TEXT PRIMARY KEY,
      order_id    TEXT NOT NULL REFERENCES orders(id),
      service_id  TEXT NOT NULL REFERENCES services(id),
      reviewer_id TEXT NOT NULL REFERENCES agents(id),
      seller_id   TEXT NOT NULL REFERENCES agents(id),
      rating      INTEGER NOT NULL,
      comment     TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS payments (
      id                    TEXT PRIMARY KEY,
      agent_id              TEXT NOT NULL REFERENCES agents(id),
      service_id            TEXT REFERENCES services(id),
      amount_cents          INTEGER DEFAULT 0,
      status                TEXT DEFAULT 'pending',
      provider              TEXT DEFAULT 'lemonsqueezy',
      provider_checkout_id  TEXT,
      provider_order_id     TEXT,
      created_at            TEXT DEFAULT (datetime('now'))
    );
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
  addColIfMissing('agents', 'stake', 'REAL DEFAULT 0');
  addColIfMissing('services', 'input_schema', 'TEXT');
  addColIfMissing('services', 'output_schema', 'TEXT');
  addColIfMissing('services', 'verification_rules', 'TEXT');
  addColIfMissing('services', 'auto_verify', 'INTEGER DEFAULT 0');
  addColIfMissing('services', 'semantic_verify', 'INTEGER DEFAULT 0');
  addColIfMissing('services', 'min_seller_stake', 'REAL DEFAULT 0');
  addColIfMissing('services', 'category', "TEXT DEFAULT 'general'");
  addColIfMissing('services', 'sub_price', 'REAL DEFAULT 0');
  addColIfMissing('services', 'sub_interval', 'TEXT');
  addColIfMissing('orders', 'bundle_id', 'TEXT');
  addColIfMissing('orders', 'parent_order_id', 'TEXT');
  addColIfMissing('agents', 'wallet_address', 'TEXT');
  addColIfMissing('agents', 'wallet_encrypted_key', 'TEXT');
  addColIfMissing('orders', 'subscription_id', 'TEXT');
  addColIfMissing('services', 'file_id', 'TEXT');
  addColIfMissing('services', 'market_type', "TEXT DEFAULT 'h2a'");
  addColIfMissing('services', 'product_type', "TEXT DEFAULT 'ai_generated'");
  addColIfMissing('payments', 'service_id', 'TEXT');

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

  // expected_hash on orders — buyer pre-commits SHA-256 of expected delivery for zero-human A2A auto-settle
  addColIfMissing('orders', 'expected_hash', 'TEXT');
  addColIfMissing('orders', 'release_oracle_url', 'TEXT');
  addColIfMissing('orders', 'release_oracle_secret', 'TEXT');
  addColIfMissing('services', 'min_buyer_trust', 'INTEGER');

  // rate_card on services — JSON array of volume pricing tiers
  addColIfMissing('services', 'rate_card', 'TEXT');

  // Request/RFP board — reverse marketplace
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id              TEXT PRIMARY KEY,
        buyer_id        TEXT NOT NULL REFERENCES agents(id),
        title           TEXT NOT NULL,
        description     TEXT NOT NULL,
        budget_usdc     REAL NOT NULL,
        category        TEXT,
        delivery_hours  INTEGER,
        expires_at      TEXT NOT NULL,
        status          TEXT DEFAULT 'open',
        accepted_order_id TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_requests_buyer ON requests (buyer_id);
      CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);

      CREATE TABLE IF NOT EXISTS request_applications (
        id             TEXT PRIMARY KEY,
        request_id     TEXT NOT NULL REFERENCES requests(id),
        seller_id      TEXT NOT NULL REFERENCES agents(id),
        service_id     TEXT NOT NULL REFERENCES services(id),
        proposed_price REAL NOT NULL,
        message        TEXT,
        status         TEXT DEFAULT 'pending',
        created_at     TEXT DEFAULT (datetime('now')),
        UNIQUE (request_id, seller_id)
      );
      CREATE INDEX IF NOT EXISTS idx_req_app_request ON request_applications (request_id);
    `);
  } catch(e) { console.error('Migration warn (requests):', e.message); }

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

  // One-time migrations: set product_type for existing data
  try {
    sqlite.exec(`
      UPDATE services SET product_type = 'digital' WHERE file_id IS NOT NULL AND (product_type IS NULL OR product_type = 'ai_generated');
      UPDATE services SET product_type = 'subscription' WHERE sub_interval IS NOT NULL AND COALESCE(sub_price, 0) > 0 AND (product_type IS NULL OR product_type = 'ai_generated');
    `);
  } catch(e) { console.error('Migration warn:', e.message); }

  console.log('SQLite schema initialized');

  db = {
    type: 'sqlite',
    prepare: (sql) => sqlite.prepare(sql),
    transaction: (fn) => sqlite.transaction(fn)
  };
}

module.exports = db;
