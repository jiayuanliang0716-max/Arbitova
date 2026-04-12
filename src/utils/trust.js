'use strict';

/**
 * Shared trust score computation.
 * Composite score 0-100:
 *   reputation 30 + completion 25 + rating 25 + age 10 - disputes 20 + review_bonus 10
 */

const { dbGet } = require('../db/helpers');
const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

/**
 * Compute trust score for any agent.
 * @param {string} agentId
 * @returns {Promise<{ score: number, level: string }>}
 */
async function getTrustScore(agentId) {
  const a = await dbGet(
    `SELECT a.reputation_score, a.created_at,
            COUNT(DISTINCT o_sell.id) AS total_sales,
            COUNT(DISTINCT CASE WHEN o_sell.status = 'completed' THEN o_sell.id END) AS completed_sales,
            COUNT(DISTINCT d.id) AS disputes,
            AVG(r.rating) AS avg_rating,
            COUNT(DISTINCT r.id) AS review_count
     FROM agents a
     LEFT JOIN orders o_sell ON o_sell.seller_id = a.id AND o_sell.status != 'refunded'
     LEFT JOIN disputes d ON d.order_id = o_sell.id AND d.status != 'resolved_for_seller'
     LEFT JOIN reviews r ON r.seller_id = a.id
     WHERE a.id = ${p(1)}
     GROUP BY a.id`,
    [agentId]
  );

  if (!a) return { score: 0, level: 'New' };

  const total     = parseInt(a.total_sales || 0);
  const completed = parseInt(a.completed_sales || 0);
  const disputed  = parseInt(a.disputes || 0);
  const rep       = parseInt(a.reputation_score || 0);
  const avgRating = parseFloat(a.avg_rating || 0);
  const numReviews= parseInt(a.review_count || 0);
  const ageDays   = Math.min((Date.now() - new Date(a.created_at).getTime()) / 86400000, 30);

  const completionRate = total > 0 ? completed / total : 0;
  const disputeRate    = total > 0 ? disputed / total : 0;

  const repPts      = Math.min(Math.max(rep, 0) / 200 * 30, 30);
  const compPts     = completionRate * 25;
  const dispPenalty = Math.min(disputeRate * 40, 20);
  const ratingPts   = numReviews > 0 ? (avgRating / 5) * 25 : 12.5;
  const agePts      = (ageDays / 30) * 10;
  const revBonus    = Math.min(numReviews * 0.5, 10);

  const raw   = repPts + compPts - dispPenalty + ratingPts + agePts + revBonus;
  const score = Math.min(Math.max(Math.round(raw), 0), 100);
  const level = score >= 90 ? 'Elite'
              : score >= 70 ? 'Trusted'
              : score >= 45 ? 'Rising'
              : 'New';

  return { score, level };
}

module.exports = { getTrustScore };
