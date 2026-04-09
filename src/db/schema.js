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
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        api_key     TEXT UNIQUE NOT NULL,
        owner_email TEXT,
        balance     NUMERIC DEFAULT 100.0,
        escrow      NUMERIC DEFAULT 0.0,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS services (
        id             TEXT PRIMARY KEY,
        agent_id       TEXT NOT NULL REFERENCES agents(id),
        name           TEXT NOT NULL,
        description    TEXT,
        price          NUMERIC NOT NULL,
        delivery_hours INTEGER DEFAULT 24,
        is_active      BOOLEAN DEFAULT TRUE,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS orders (
        id           TEXT PRIMARY KEY,
        buyer_id     TEXT NOT NULL REFERENCES agents(id),
        seller_id    TEXT NOT NULL REFERENCES agents(id),
        service_id   TEXT NOT NULL REFERENCES services(id),
        status       TEXT DEFAULT 'paid',
        amount       NUMERIC NOT NULL,
        requirements TEXT,
        deadline     TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
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
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );
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
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      api_key     TEXT UNIQUE NOT NULL,
      owner_email TEXT,
      balance     REAL DEFAULT 100.0,
      escrow      REAL DEFAULT 0.0,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS services (
      id             TEXT PRIMARY KEY,
      agent_id       TEXT NOT NULL REFERENCES agents(id),
      name           TEXT NOT NULL,
      description    TEXT,
      price          REAL NOT NULL,
      delivery_hours INTEGER DEFAULT 24,
      is_active      INTEGER DEFAULT 1,
      created_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id           TEXT PRIMARY KEY,
      buyer_id     TEXT NOT NULL REFERENCES agents(id),
      seller_id    TEXT NOT NULL REFERENCES agents(id),
      service_id   TEXT NOT NULL REFERENCES services(id),
      status       TEXT DEFAULT 'paid',
      amount       REAL NOT NULL,
      requirements TEXT,
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
      created_at  TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );
  `);

  console.log('SQLite schema initialized');

  db = {
    type: 'sqlite',
    prepare: (sql) => sqlite.prepare(sql),
    transaction: (fn) => sqlite.transaction(fn)
  };
}

module.exports = db;
