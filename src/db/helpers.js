/**
 * 統一資料庫操作介面
 * 自動處理 SQLite（同步）和 PostgreSQL（非同步）的差異
 */

const db = require('./schema');

// 將 SQLite 的 is_active integer 統一成 boolean
function normalizeService(s) {
  if (!s) return null;
  return { ...s, is_active: s.is_active === 1 || s.is_active === true };
}

async function dbGet(sql, params = []) {
  if (db.type === 'pg') {
    const { rows } = await db.pool.query(sql, params);
    return rows[0] || null;
  }
  return db.prepare(sql).get(...params);
}

async function dbAll(sql, params = []) {
  if (db.type === 'pg') {
    const { rows } = await db.pool.query(sql, params);
    return rows;
  }
  return db.prepare(sql).all(...params);
}

async function dbRun(sql, params = []) {
  if (db.type === 'pg') {
    await db.pool.query(sql, params);
  } else {
    db.prepare(sql).run(...params);
  }
}

async function dbTransaction(fn) {
  if (db.type === 'pg') {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await fn({
        get: async (sql, params = []) => {
          const { rows } = await client.query(sql, params);
          return rows[0] || null;
        },
        run: (sql, params = []) => client.query(sql, params)
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } else {
    const tx = {
      run: async (sql, params = []) => { db.prepare(sql).run(...params); },
      get: async (sql, params = []) => db.prepare(sql).get(...params)
    };
    await fn(tx);
  }
}

module.exports = { dbGet, dbAll, dbRun, dbTransaction, normalizeService };
