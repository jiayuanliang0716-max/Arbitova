'use strict';

/**
 * velocity.js — Per-agent spending velocity limits
 *
 * Prevents a compromised or runaway agent from draining its balance
 * in a short window. Checked at order creation time.
 *
 * Limits (configurable via env):
 *   MAX_ORDERS_PER_HOUR  (default: 20)
 *   MAX_SPEND_PER_HOUR   (default: 1000 platform units)
 *   MAX_ORDERS_PER_DAY   (default: 100)
 *   MAX_SPEND_PER_DAY    (default: 5000 platform units)
 */

const { dbGet } = require('../db/helpers');

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

const LIMITS = {
  ordersPerHour: parseInt(process.env.MAX_ORDERS_PER_HOUR  || '20',   10),
  spendPerHour:  parseFloat(process.env.MAX_SPEND_PER_HOUR  || '1000'),
  ordersPerDay:  parseInt(process.env.MAX_ORDERS_PER_DAY   || '100',  10),
  spendPerDay:   parseFloat(process.env.MAX_SPEND_PER_DAY   || '5000'),
};

/**
 * Check whether agent has exceeded velocity limits for the given amount.
 * Call this before placing an order.
 *
 * @param {string} agentId
 * @param {number} amount - amount of the new order being placed
 * @returns {{ ok: boolean, reason?: string, limit?: object }}
 */
async function checkVelocity(agentId, amount) {
  try {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const dayAgo  = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [hourStats, dayStats] = await Promise.all([
      dbGet(
        `SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total
         FROM orders
         WHERE buyer_id = ${p(1)} AND created_at >= ${p(2)} AND status != 'refunded'`,
        [agentId, hourAgo]
      ),
      dbGet(
        `SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total
         FROM orders
         WHERE buyer_id = ${p(1)} AND created_at >= ${p(2)} AND status != 'refunded'`,
        [agentId, dayAgo]
      ),
    ]);

    const hCount = parseInt(hourStats?.cnt  || 0);
    const hSpend = parseFloat(hourStats?.total || 0);
    const dCount = parseInt(dayStats?.cnt   || 0);
    const dSpend = parseFloat(dayStats?.total || 0);

    if (hCount >= LIMITS.ordersPerHour) {
      return { ok: false, reason: `Hourly order limit reached (${LIMITS.ordersPerHour}/hr)`, code: 'velocity_order_hour' };
    }
    if (hSpend + amount > LIMITS.spendPerHour) {
      return { ok: false, reason: `Hourly spend limit reached (${LIMITS.spendPerHour}/hr)`, code: 'velocity_spend_hour' };
    }
    if (dCount >= LIMITS.ordersPerDay) {
      return { ok: false, reason: `Daily order limit reached (${LIMITS.ordersPerDay}/day)`, code: 'velocity_order_day' };
    }
    if (dSpend + amount > LIMITS.spendPerDay) {
      return { ok: false, reason: `Daily spend limit reached (${LIMITS.spendPerDay}/day)`, code: 'velocity_spend_day' };
    }

    return { ok: true };
  } catch (err) {
    // Non-fatal: if DB query fails, allow the request through
    console.error('[velocity] check error:', err.message);
    return { ok: true };
  }
}

module.exports = { checkVelocity, LIMITS };
