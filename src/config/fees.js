/**
 * Canonical Arbitova fee rates.
 *
 * Source of truth for every settlement / dispute path.
 * These match the public pricing page — any change here must be reflected
 * on /pricing.html in the same commit.
 *
 * Do NOT redeclare these constants anywhere else in the codebase.
 */

const SETTLEMENT_FEE_RATE = 0.005;  // 0.5% — charged to seller on successful settlement
const DISPUTE_FEE_RATE    = 0.02;   // 2%   — charged to losing party after dispute resolution (bound transactions)

// Legacy aliases kept for backwards-compat while callers migrate.
// Prefer SETTLEMENT_FEE_RATE / DISPUTE_FEE_RATE in new code.
const RELEASE_FEE_RATE  = SETTLEMENT_FEE_RATE;
const PLATFORM_FEE_RATE = SETTLEMENT_FEE_RATE;

/**
 * Credit a fee into the platform_revenue singleton row.
 *
 * Call this from every settlement/dispute path that computes a fee.
 * No-ops on fee <= 0. Safe to call multiple times (each call adds).
 */
async function creditPlatformFee(fee) {
  const amount = parseFloat(fee);
  if (!amount || amount <= 0 || Number.isNaN(amount)) return;

  const { dbRun } = require('../db/helpers');
  const isPostgres = !!process.env.DATABASE_URL;
  const p = (n) => isPostgres ? `$${n}` : '?';
  const now = isPostgres ? 'NOW()' : "datetime('now')";

  await dbRun(
    `UPDATE platform_revenue SET balance = balance + ${p(1)}, total_earned = total_earned + ${p(2)}, updated_at = ${now} WHERE id = 'singleton'`,
    [amount, amount]
  );
}

// Reverse a previously-credited fee. Used only when an appeal overturns a
// verdict that had already charged the platform fee (seller-wins -> buyer-wins).
async function debitPlatformFee(fee) {
  const amount = parseFloat(fee);
  if (!amount || amount <= 0 || Number.isNaN(amount)) return;

  const { dbRun } = require('../db/helpers');
  const isPostgres = !!process.env.DATABASE_URL;
  const p = (n) => isPostgres ? `$${n}` : '?';
  const now = isPostgres ? 'NOW()' : "datetime('now')";

  await dbRun(
    `UPDATE platform_revenue SET balance = balance - ${p(1)}, total_earned = total_earned - ${p(2)}, updated_at = ${now} WHERE id = 'singleton'`,
    [amount, amount]
  );
}

module.exports = {
  SETTLEMENT_FEE_RATE,
  DISPUTE_FEE_RATE,
  RELEASE_FEE_RATE,
  PLATFORM_FEE_RATE,
  creditPlatformFee,
  debitPlatformFee,
};
