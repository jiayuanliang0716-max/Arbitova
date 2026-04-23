'use strict';

/**
 * Arbitration routes — Path B
 *
 * Only GET /verdicts remains. All Path A endpoints (external, batch,
 * register, evidence, trigger, transaction/:id) were removed in the
 * 2026-04-24 Path B cleanup paired with Python SDK arbitova 2.5.4,
 * which removed external_arbitrate(). Arbitration in Path B is
 * resolved on-chain by the arbiter calling EscrowV1.resolve().
 */

const express = require('express');
const { dbAll } = require('../db/helpers');

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

const router = express.Router();

/**
 * GET /api/v1/arbitrate/verdicts
 *
 * Public feed of anonymized AI arbitration verdicts.
 * No auth required — this is a transparency / trust-building page.
 *
 * Query params:
 *   limit   int   max cases to return (default 50, max 200)
 *   winner  str   filter: 'buyer' | 'seller'
 *   page    int   pagination (0-indexed)
 */
router.get('/verdicts', async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset = (parseInt(req.query.page) || 0) * limit;
    const winner = req.query.winner; // optional filter

    // Pull AI-arbitrated disputes (resolution starts with [AI Arbitration)
    let query = `
      SELECT
        d.id          AS dispute_id,
        d.reason      AS dispute_reason,
        d.resolution,
        d.created_at  AS raised_at,
        d.resolved_at,
        o.amount,
        o.requirements,
        s.name        AS service_name,
        s.category
      FROM disputes d
      JOIN orders o ON o.id = d.order_id
      LEFT JOIN services s ON s.id = o.service_id
      WHERE d.status = 'resolved'
        AND d.resolution LIKE '%[AI Arbitration%'
    `;
    const params = [];

    // Winner is determined by vote majority in format "buyer(X%), buyer(X%), seller(X%)"
    // Filter applied post-fetch since winner is parsed from votes string
    const filterWinner = (winner === 'buyer' || winner === 'seller') ? winner : null;

    query += ` ORDER BY d.resolved_at DESC LIMIT ${p(params.length + 1)} OFFSET ${p(params.length + 2)}`;
    params.push(limit, offset);

    const rows = await dbAll(query, params);

    // Parse stored resolution string back into structured fields
    // Format: "[AI Arbitration N=3 | votes: buyer(82%), seller(74%) | avg confidence: 82%] reasoning..."
    const allVerdicts = rows.map((row, idx) => {
      const res_str = row.resolution || '';

      // Extract winner from votes majority
      let caseWinner = null;
      const votesSection = res_str.match(/votes:\s*([^\|]+)/);
      if (votesSection) {
        const buyerCount  = (votesSection[1].match(/buyer\(/g)  || []).length;
        const sellerCount = (votesSection[1].match(/seller\(/g) || []).length;
        if (buyerCount > sellerCount)  caseWinner = 'buyer';
        if (sellerCount > buyerCount)  caseWinner = 'seller';
      }

      // Extract confidence
      let confidence = null;
      const confMatch = res_str.match(/avg confidence:\s*(\d+)%/);
      if (confMatch) confidence = parseInt(confMatch[1]) / 100;

      // Extract votes summary
      let votes = [];
      const votesMatch = res_str.match(/votes:\s*([^\]]+)/);
      if (votesMatch) {
        votes = votesMatch[1].split(',').map(v => v.trim()).filter(Boolean);
      }

      // Extract reasoning (everything after the closing bracket)
      let reasoning = '';
      const reasoningMatch = res_str.match(/\]\s*(.+)$/s);
      if (reasoningMatch) reasoning = reasoningMatch[1].trim().slice(0, 400);

      // Anonymize amount into a range
      const amount = parseFloat(row.amount || 0);
      let amount_range = '$0–$1';
      if (amount >= 50)  amount_range = '$50+';
      else if (amount >= 10) amount_range = '$10–$50';
      else if (amount >= 5)  amount_range = '$5–$10';
      else if (amount >= 1)  amount_range = '$1–$5';

      // Classify dispute type from reason text
      const reason_lower = (row.dispute_reason || '').toLowerCase();
      let dispute_type = 'general';
      if (reason_lower.includes('incomplete') || reason_lower.includes('partial'))  dispute_type = 'incomplete_delivery';
      else if (reason_lower.includes('format') || reason_lower.includes('csv') || reason_lower.includes('json')) dispute_type = 'format_mismatch';
      else if (reason_lower.includes('late') || reason_lower.includes('deadline')) dispute_type = 'deadline_violation';
      else if (reason_lower.includes('quality') || reason_lower.includes('superficial')) dispute_type = 'quality_dispute';
      else if (reason_lower.includes('section') || reason_lower.includes('missing')) dispute_type = 'missing_sections';
      else if (reason_lower.includes('refund') || reason_lower.includes('no actual')) dispute_type = 'no_delivery';
      else if (reason_lower.includes('wrong') || reason_lower.includes('reverse') || reason_lower.includes('entirely')) dispute_type = 'spec_mismatch';
      else if (reason_lower.includes('architecture') || reason_lower.includes('expected')) dispute_type = 'scope_dispute';

      return {
        case_number:   offset + idx + 1,
        dispute_type,
        winner:        caseWinner,
        confidence,
        votes,
        reasoning,
        amount_range,
        service_category: row.category || 'general',
        raised_at:     row.raised_at,
        resolved_at:   row.resolved_at,
      };
    });

    // Apply winner filter post-parse (since winner is derived from votes string)
    const verdicts = filterWinner
      ? allVerdicts.filter(v => v.winner === filterWinner)
      : allVerdicts;

    // Aggregate stats — count all AI-arbitrated disputes, parse winner from votes
    const statsRows = await dbAll(
      `SELECT resolution FROM disputes WHERE status = 'resolved' AND resolution LIKE '%[AI Arbitration%'`,
      []
    ).catch(() => []);

    let buyer_wins = 0, seller_wins = 0;
    for (const r of statsRows) {
      const vs = (r.resolution || '').match(/votes:\s*([^\|]+)/);
      if (!vs) continue;
      const b = (vs[1].match(/buyer\(/g)  || []).length;
      const s = (vs[1].match(/seller\(/g) || []).length;
      if (b > s) buyer_wins++;
      else if (s > b) seller_wins++;
    }

    res.json({
      total:       statsRows.length,
      buyer_wins,
      seller_wins,
      page:        parseInt(req.query.page) || 0,
      limit,
      verdicts,
    });
  } catch (err) { next(err); }
});

module.exports = router;
