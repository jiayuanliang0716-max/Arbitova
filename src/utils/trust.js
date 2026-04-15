'use strict';

/**
 * Trust score computation — v2 with TrustRank graph influence + temporal decay
 *
 * Two-layer score:
 *   Layer 1 (flat):  reputation + completion rate + rating + age - dispute penalty
 *   Layer 2 (graph): flat score weighted by network quality (who you trade with)
 *
 * TrustRank insight (from Google PageRank): a node's trustworthiness depends
 * not just on its own behavior, but on the reputation of its trading partners.
 * Completing trades with Elite agents signals higher quality than trading with New agents.
 *
 * Temporal decay: reputation events older than 90 days contribute at 50% weight,
 * older than 180 days at 25%. Recent behavior matters more.
 */

const { dbGet, dbAll } = require('../db/helpers');
const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

// TrustRank: graph influence weight on final score
const GRAPH_WEIGHT = 0.25;  // 25% of score comes from network quality
const FLAT_WEIGHT  = 0.75;  // 75% from own behavior

// Temporal decay thresholds
const DECAY_90D_FACTOR  = 0.5;   // events 90-180 days old → 50% weight
const DECAY_180D_FACTOR = 0.25;  // events >180 days old   → 25% weight

/**
 * Compute the flat trust score for an agent.
 * Composite score 0-100:
 *   reputation 30 + completion 25 + rating 25 + age 10 - disputes 20 + review_bonus 10
 */
async function computeFlatScore(agentId) {
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

  if (!a) return 0;

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

  const raw = repPts + compPts - dispPenalty + ratingPts + agePts + revBonus;
  return Math.min(Math.max(Math.round(raw), 0), 100);
}

/**
 * Compute TrustRank graph influence.
 *
 * Network multiplier = average reputation_score of counterparties
 * in successfully completed trades (normalized to 0-1 range).
 *
 * Logic: if you consistently trade with high-reputation agents and they
 * trust you enough to transact, that trust propagates to you.
 *
 * Returns a multiplier in range [0.8, 1.2]:
 *   - 0.8  if all counterparties are low-rep (< 20 score)
 *   - 1.0  if average counterparty rep is ~500 (neutral)
 *   - 1.2  if all counterparties are elite (> 800 score)
 */
async function computeGraphMultiplier(agentId) {
  try {
    // Get reputation of counterparties from completed orders (both as buyer and seller)
    const counterparties = await dbAll(
      `SELECT
         CASE WHEN o.buyer_id = ${p(1)} THEN o.seller_id ELSE o.buyer_id END AS counterparty_id,
         a.reputation_score,
         o.completed_at
       FROM orders o
       JOIN agents a ON a.id = (CASE WHEN o.buyer_id = ${p(2)} THEN o.seller_id ELSE o.buyer_id END)
       WHERE (o.buyer_id = ${p(3)} OR o.seller_id = ${p(4)})
         AND o.status = 'completed'
       ORDER BY o.completed_at DESC
       LIMIT 50`,
      [agentId, agentId, agentId, agentId]
    );

    if (!counterparties || counterparties.length === 0) return 1.0;

    const now = Date.now();

    // Apply temporal decay to counterparty trust contributions
    let weightedSum = 0;
    let totalWeight = 0;

    for (const cp of counterparties) {
      const rep = Math.max(parseInt(cp.reputation_score || 0), 0);
      const ageDays = cp.completed_at
        ? (now - new Date(cp.completed_at).getTime()) / 86400000
        : 365;

      // Temporal decay weight
      let timeWeight = 1.0;
      if (ageDays > 180) timeWeight = DECAY_180D_FACTOR;
      else if (ageDays > 90) timeWeight = DECAY_90D_FACTOR;

      weightedSum += rep * timeWeight;
      totalWeight += timeWeight;
    }

    const avgWeightedRep = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Normalize: reputation_score around 500 = neutral (multiplier 1.0)
    // Range: [0, 1000] → multiplier [0.8, 1.2]
    const normalized = Math.min(avgWeightedRep / 1000, 1.0);
    const multiplier = 0.8 + (normalized * 0.4);

    return Math.min(Math.max(multiplier, 0.8), 1.2);
  } catch (e) {
    return 1.0; // Fallback: neutral multiplier on error
  }
}

/**
 * Main: compute trust score for any agent.
 *
 * @param {string} agentId
 * @returns {Promise<{ score: number, level: string, flat_score: number, graph_multiplier: number }>}
 */
async function getTrustScore(agentId) {
  const [flatScore, graphMultiplier] = await Promise.all([
    computeFlatScore(agentId),
    computeGraphMultiplier(agentId),
  ]);

  // Blend: 75% flat behavior + 25% graph-influenced
  const blended = (flatScore * FLAT_WEIGHT) + (flatScore * graphMultiplier * GRAPH_WEIGHT);
  const score   = Math.min(Math.max(Math.round(blended), 0), 100);

  const level = score >= 90 ? 'Elite'
              : score >= 70 ? 'Trusted'
              : score >= 45 ? 'Rising'
              : 'New';

  return { score, level, flat_score: flatScore, graph_multiplier: Math.round(graphMultiplier * 100) / 100 };
}

module.exports = { getTrustScore };
