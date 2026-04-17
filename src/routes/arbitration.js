'use strict';

/**
 * External Arbitration API
 *
 * Arbitova Arbitration API — Trust Layer for Agent Transactions
 *
 * Stateless (one-shot):
 *   POST /api/v1/arbitrate/external        — single arbitration call
 *   POST /api/v1/arbitrate/batch           — batch arbitration (up to 10)
 *   GET  /api/v1/arbitrate/verdicts        — public verdict feed
 *
 * Stateful (trust layer — register → evidence → trigger):
 *   POST /api/v1/arbitrate/register        — register transaction at start
 *   POST /api/v1/arbitrate/evidence        — submit evidence throughout
 *   POST /api/v1/arbitrate/trigger         — trigger arbitration (auto-pulls data)
 *   GET  /api/v1/arbitrate/transaction/:id — check status + evidence + verdict
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireApiKey } = require('../middleware/auth');
const { arbitrateDispute } = require('../arbitrate');
const { fire, EVENTS } = require('../webhooks');
const { dbAll, dbGet, dbRun } = require('../db/helpers');
const { EXTERNAL_ARB_RATE, creditPlatformFee } = require('../config/fees');

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

const router = express.Router();

/**
 * POST /api/v1/arbitrate/external
 *
 * Body:
 *   amount             number   - Disputed transaction value (USDC). Fee = amount * 5%
 *   escrow_provider    string   - 'paycrow' | 'kamiyo' | 'custom' | any string
 *   dispute_id         string   - Your internal dispute ID (for idempotency)
 *   requirements       string   - Original contract requirements
 *   delivery_evidence  string   - Seller's delivery evidence / content
 *   dispute_reason     string   - Buyer's dispute reason
 *   callback_url       string?  - Webhook URL to receive verdict (optional)
 *
 * Fee model (unbound):
 *   5% of `amount` is deducted from caller's Arbitova agent balance on verdict.
 *   Caller must pre-fund their Arbitova balance. Insufficient balance → 402.
 *   Tip: transactions bound via POST /orders only pay 2% on dispute — direct integration
 *   is the cheaper path for recurring use.
 */
router.post('/external', requireApiKey, async (req, res, next) => {
  try {
    const {
      amount,
      escrow_provider,
      dispute_id,
      requirements,
      delivery_evidence,
      dispute_reason,
      callback_url,
    } = req.body;

    if (!requirements)      return res.status(400).json({ error: 'requirements is required', code: 'MISSING_REQUIREMENTS' });
    if (!delivery_evidence) return res.status(400).json({ error: 'delivery_evidence is required', code: 'MISSING_DELIVERY' });
    if (!dispute_reason)    return res.status(400).json({ error: 'dispute_reason is required', code: 'MISSING_DISPUTE_REASON' });

    const amt = parseFloat(amount);
    if (!amt || amt <= 0 || Number.isNaN(amt)) {
      return res.status(400).json({ error: 'amount is required and must be > 0 (disputed transaction value in USDC)', code: 'MISSING_AMOUNT' });
    }
    const fee = parseFloat((amt * EXTERNAL_ARB_RATE).toFixed(6));

    // Pre-check caller's Arbitova balance
    const caller = await dbGet(`SELECT balance FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    if (!caller || parseFloat(caller.balance) < fee) {
      return res.status(402).json({
        error: 'Insufficient Arbitova balance for external arbitration fee',
        code: 'INSUFFICIENT_BALANCE',
        required_fee: fee,
        balance: parseFloat(caller?.balance || 0),
        hint: 'Top up your Arbitova balance or bind this transaction via POST /orders to pay only 2% on dispute.',
      });
    }

    // Build synthetic order/dispute/delivery objects for the arbitration engine
    const syntheticOrder = {
      buyer_id:     '__external_buyer__',
      amount:       amt,
      requirements: requirements,
      status:       'disputed',
      deadline:     new Date().toISOString(),
    };
    const syntheticService = {
      name:        `External (${escrow_provider || 'unknown'})`,
      description: requirements,
    };
    const syntheticDispute = {
      raised_by: '__external_buyer__',
      reason:    dispute_reason,
      evidence:  null,
    };
    const syntheticDelivery = {
      content:    delivery_evidence,
      created_at: new Date().toISOString(),
    };

    const verdict = await arbitrateDispute({
      order:    syntheticOrder,
      service:  syntheticService,
      dispute:  syntheticDispute,
      delivery: syntheticDelivery,
    });

    // Deduct fee from caller balance + credit platform_revenue
    await dbRun(`UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`, [fee, req.agent.id]);
    await creditPlatformFee(fee);

    const arbitrationId = uuidv4();

    // If caller provided a callback URL, fire webhook asynchronously
    let callback_scheduled = false;
    if (callback_url) {
      callback_scheduled = true;
      // Fire-and-forget webhook to caller's URL
      setImmediate(async () => {
        try {
          await fetch(callback_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'arbitration.completed',
              arbitration_id: arbitrationId,
              dispute_id: dispute_id || null,
              escrow_provider: escrow_provider || null,
              verdict,
            }),
          });
        } catch (e) {
          // Non-fatal — caller should also check the synchronous response
        }
      });
    }

    res.json({
      arbitration_id:         arbitrationId,
      dispute_id:             dispute_id || null,
      escrow_provider:        escrow_provider || null,
      amount:                 amt,
      fee:                    fee,
      fee_rate:               EXTERNAL_ARB_RATE,
      winner:                 verdict.winner,
      confidence:             verdict.confidence,
      method:                 verdict.method,
      reasoning:              verdict.reasoning,
      key_factors:            verdict.key_factors || [],
      dissent:                verdict.dissent || null,
      votes:                  verdict.votes,
      constitutional_shortcut: verdict.constitutional_shortcut || false,
      escalate_to_human:      verdict.escalate_to_human,
      callback_scheduled,
    });

  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/arbitrate/batch
 *
 * Run N=3 AI arbitration on up to 10 disputes in a single call (parallel).
 * Each item in `disputes` is a standalone dispute object identical to /external body.
 *
 * Body:
 *   {
 *     disputes: [
 *       { escrow_provider, dispute_id, requirements, delivery_evidence, dispute_reason, callback_url? },
 *       ...  (max 10)
 *     ]
 *   }
 *
 * Returns:
 *   { batch_size, succeeded, failed, results: [...] }
 */
router.post('/batch', requireApiKey, async (req, res, next) => {
  try {
    const { disputes } = req.body;
    if (!Array.isArray(disputes) || disputes.length === 0) {
      return res.status(400).json({ error: 'disputes must be a non-empty array' });
    }
    if (disputes.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 disputes per batch' });
    }

    // Pre-validate amounts and compute total fee
    const totalFee = disputes.reduce((sum, d) => {
      const a = parseFloat(d.amount);
      return sum + (a > 0 ? a * EXTERNAL_ARB_RATE : 0);
    }, 0);
    if (totalFee <= 0) {
      return res.status(400).json({ error: 'each dispute requires amount > 0 (disputed transaction value in USDC)', code: 'MISSING_AMOUNT' });
    }
    const caller = await dbGet(`SELECT balance FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    if (!caller || parseFloat(caller.balance) < totalFee) {
      return res.status(402).json({
        error: 'Insufficient Arbitova balance for external arbitration batch',
        code: 'INSUFFICIENT_BALANCE',
        required_fee: parseFloat(totalFee.toFixed(6)),
        balance: parseFloat(caller?.balance || 0),
      });
    }

    const results = await Promise.allSettled(disputes.map(async (d, idx) => {
      const { amount, escrow_provider, dispute_id, requirements, delivery_evidence, dispute_reason, callback_url } = d;

      if (!requirements)      return { index: idx, dispute_id: dispute_id || null, error: 'requirements is required' };
      if (!delivery_evidence) return { index: idx, dispute_id: dispute_id || null, error: 'delivery_evidence is required' };
      if (!dispute_reason)    return { index: idx, dispute_id: dispute_id || null, error: 'dispute_reason is required' };
      const amt = parseFloat(amount);
      if (!amt || amt <= 0) return { index: idx, dispute_id: dispute_id || null, error: 'amount > 0 required' };
      const fee = parseFloat((amt * EXTERNAL_ARB_RATE).toFixed(6));

      const verdict = await arbitrateDispute({
        order: {
          buyer_id: '__external_buyer__',
          amount: amt,
          requirements,
          status: 'disputed',
          deadline: new Date().toISOString(),
        },
        service: {
          name: `External (${escrow_provider || 'unknown'})`,
          description: requirements,
        },
        dispute: {
          raised_by: '__external_buyer__',
          reason: dispute_reason,
          evidence: null,
        },
        delivery: {
          content: delivery_evidence,
          created_at: new Date().toISOString(),
        },
      });

      const arbitrationId = uuidv4();

      // Deduct this verdict's fee from caller balance + credit platform_revenue
      await dbRun(`UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`, [fee, req.agent.id]);
      await creditPlatformFee(fee);

      if (callback_url) {
        setImmediate(async () => {
          try {
            await fetch(callback_url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                event: 'arbitration.completed',
                arbitration_id: arbitrationId,
                dispute_id: dispute_id || null,
                escrow_provider: escrow_provider || null,
                verdict,
              }),
            });
          } catch (e) { /* non-fatal */ }
        });
      }

      return {
        index: idx,
        arbitration_id:         arbitrationId,
        dispute_id:             dispute_id || null,
        escrow_provider:        escrow_provider || null,
        amount:                 amt,
        fee:                    fee,
        winner:                 verdict.winner,
        confidence:             verdict.confidence,
        method:                 verdict.method,
        reasoning:              verdict.reasoning,
        key_factors:            verdict.key_factors || [],
        dissent:                verdict.dissent || null,
        votes:                  verdict.votes,
        constitutional_shortcut: verdict.constitutional_shortcut || false,
        escalate_to_human:      verdict.escalate_to_human,
        callback_scheduled:     !!callback_url,
      };
    }));

    const summary = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return { index: i, error: r.reason?.message || 'Unknown error' };
    });

    const succeeded = summary.filter(r => !r.error).length;
    res.json({
      batch_size: disputes.length,
      succeeded,
      failed: disputes.length - succeeded,
      results: summary,
    });
  } catch (err) {
    next(err);
  }
});

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
      // Format: "votes: buyer(95%), buyer(92%), buyer(95%)" or "buyer(82%), seller(74%), buyer(79%)"
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

// =============================================================================
// Stateful Arbitration API — Trust Layer for External Transactions
//
// Flow:
//   1. POST /arbitrate/register    — both parties agree to Arbitova protection
//   2. POST /arbitrate/evidence    — submit evidence throughout the transaction
//   3. POST /arbitrate/trigger     — trigger arbitration (auto-pulls all evidence)
//
// Also:
//   GET  /arbitrate/transaction/:id — check transaction status + evidence
// =============================================================================

/**
 * POST /api/v1/arbitrate/register
 *
 * Register a transaction for Arbitova protection at the START of a deal.
 * Both parties are recorded. Evidence can be submitted throughout.
 * When a dispute arises, all recorded data is automatically available.
 *
 * Body:
 *   buyer_ref        string   - Buyer identifier (their system's ID, wallet, etc.)
 *   seller_ref       string   - Seller identifier
 *   requirements     string   - What the buyer expects (contract terms)
 *   amount           number?  - Transaction value (optional)
 *   currency         string?  - Currency code (default: USDC)
 *   metadata         object?  - Any extra context (service name, deadline, etc.)
 */
router.post('/register', requireApiKey, async (req, res, next) => {
  try {
    const { buyer_ref, seller_ref, requirements, amount, currency, metadata } = req.body;

    if (!buyer_ref)     return res.status(400).json({ error: 'buyer_ref is required' });
    if (!seller_ref)    return res.status(400).json({ error: 'seller_ref is required' });
    if (!requirements)  return res.status(400).json({ error: 'requirements is required' });
    if (buyer_ref === seller_ref) {
      return res.status(400).json({ error: 'buyer_ref and seller_ref must be different' });
    }

    const txId = uuidv4();
    const metaStr = metadata ? JSON.stringify(metadata) : null;

    await dbRun(
      `INSERT INTO arbitration_transactions
         (id, api_key_owner, buyer_ref, seller_ref, amount, currency, requirements, metadata)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)})`,
      [txId, req.agent.id, buyer_ref, seller_ref, amount || null, currency || 'USDC', requirements, metaStr]
    );

    res.status(201).json({
      transaction_id: txId,
      status: 'active',
      buyer_ref,
      seller_ref,
      requirements,
      amount: amount || null,
      currency: currency || 'USDC',
      message: 'Transaction registered. Both parties are now protected by Arbitova. Submit evidence with POST /arbitrate/evidence.',
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/v1/arbitrate/evidence
 *
 * Submit evidence for a registered transaction.
 * Can be called multiple times by either party throughout the transaction.
 *
 * Body:
 *   transaction_id   string   - The registered transaction ID
 *   submitted_by     string   - Who is submitting (buyer_ref or seller_ref)
 *   role             string   - 'buyer' | 'seller'
 *   evidence_type    string   - 'delivery' | 'communication' | 'requirement_change' |
 *                                'partial_delivery' | 'complaint' | 'other'
 *   content          string   - The evidence content
 *   metadata         object?  - Extra context
 */
router.post('/evidence', requireApiKey, async (req, res, next) => {
  try {
    const { transaction_id, submitted_by, role, evidence_type, content, metadata } = req.body;

    if (!transaction_id) return res.status(400).json({ error: 'transaction_id is required' });
    if (!submitted_by)   return res.status(400).json({ error: 'submitted_by is required' });
    if (!role || !['buyer', 'seller'].includes(role)) {
      return res.status(400).json({ error: 'role must be "buyer" or "seller"' });
    }
    if (!evidence_type)  return res.status(400).json({ error: 'evidence_type is required' });
    if (!content)        return res.status(400).json({ error: 'content is required' });

    const validTypes = ['delivery', 'communication', 'requirement_change', 'partial_delivery', 'complaint', 'other'];
    if (!validTypes.includes(evidence_type)) {
      return res.status(400).json({ error: `evidence_type must be one of: ${validTypes.join(', ')}` });
    }

    // Verify transaction exists and belongs to this API key owner
    const tx = await dbGet(
      `SELECT * FROM arbitration_transactions WHERE id = ${p(1)} AND api_key_owner = ${p(2)}`,
      [transaction_id, req.agent.id]
    );
    if (!tx) return res.status(404).json({ error: 'Transaction not found or access denied' });
    if (tx.status !== 'active') {
      return res.status(400).json({ error: `Transaction is ${tx.status}, cannot submit evidence` });
    }

    // Verify submitted_by matches either buyer_ref or seller_ref
    if (submitted_by !== tx.buyer_ref && submitted_by !== tx.seller_ref) {
      return res.status(400).json({
        error: 'submitted_by must match either buyer_ref or seller_ref of the transaction',
      });
    }

    const evidenceId = uuidv4();
    const metaStr = metadata ? JSON.stringify(metadata) : null;

    await dbRun(
      `INSERT INTO arbitration_evidence
         (id, transaction_id, submitted_by, role, evidence_type, content, metadata)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)})`,
      [evidenceId, transaction_id, submitted_by, role, evidence_type, content, metaStr]
    );

    // Update transaction timestamp
    const now = isPostgres ? 'NOW()' : "datetime('now')";
    await dbRun(
      `UPDATE arbitration_transactions SET updated_at = ${now} WHERE id = ${p(1)}`,
      [transaction_id]
    );

    // Count evidence so far
    const countRow = await dbGet(
      `SELECT COUNT(*) as cnt FROM arbitration_evidence WHERE transaction_id = ${p(1)}`,
      [transaction_id]
    );

    res.status(201).json({
      evidence_id: evidenceId,
      transaction_id,
      submitted_by,
      role,
      evidence_type,
      total_evidence: parseInt(countRow?.cnt || 1),
      message: 'Evidence recorded. It will be automatically included if arbitration is triggered.',
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/v1/arbitrate/trigger
 *
 * Trigger AI arbitration for a registered transaction.
 * Automatically pulls ALL recorded evidence — no need to re-submit anything.
 *
 * Body:
 *   transaction_id   string   - The registered transaction ID
 *   dispute_reason   string   - Why arbitration is being triggered
 *   raised_by        string   - Who is raising the dispute (buyer_ref or seller_ref)
 */
router.post('/trigger', requireApiKey, async (req, res, next) => {
  try {
    const { transaction_id, dispute_reason, raised_by } = req.body;

    if (!transaction_id) return res.status(400).json({ error: 'transaction_id is required' });
    if (!dispute_reason) return res.status(400).json({ error: 'dispute_reason is required' });
    if (!raised_by)      return res.status(400).json({ error: 'raised_by is required' });

    // Load transaction
    const tx = await dbGet(
      `SELECT * FROM arbitration_transactions WHERE id = ${p(1)} AND api_key_owner = ${p(2)}`,
      [transaction_id, req.agent.id]
    );
    if (!tx) return res.status(404).json({ error: 'Transaction not found or access denied' });
    if (tx.status === 'arbitrated') {
      // Return existing verdict
      const existing = await dbGet(
        `SELECT * FROM arbitration_verdicts WHERE transaction_id = ${p(1)}`,
        [transaction_id]
      );
      if (existing) {
        return res.json({
          transaction_id,
          status: 'already_arbitrated',
          verdict: {
            verdict_id: existing.id,
            winner: existing.winner,
            confidence: parseFloat(existing.confidence),
            method: existing.method,
            reasoning: existing.reasoning,
            key_factors: typeof existing.key_factors === 'string' ? JSON.parse(existing.key_factors) : existing.key_factors,
            dissent: existing.dissent,
            votes: typeof existing.votes === 'string' ? JSON.parse(existing.votes) : existing.votes,
            escalate_to_human: !!existing.escalate_to_human,
          },
          message: 'This transaction has already been arbitrated.',
        });
      }
    }
    if (tx.status !== 'active') {
      return res.status(400).json({ error: `Transaction is ${tx.status}, cannot trigger arbitration` });
    }

    // Verify raised_by matches
    if (raised_by !== tx.buyer_ref && raised_by !== tx.seller_ref) {
      return res.status(400).json({
        error: 'raised_by must match either buyer_ref or seller_ref',
      });
    }

    // Load all evidence
    const allEvidence = await dbAll(
      `SELECT * FROM arbitration_evidence WHERE transaction_id = ${p(1)} ORDER BY created_at ASC`,
      [transaction_id]
    );

    // Build delivery evidence from seller submissions
    const sellerEvidence = allEvidence
      .filter(e => e.role === 'seller')
      .map(e => e.content)
      .join('\n---\n');

    // Build buyer evidence
    const buyerEvidence = allEvidence
      .filter(e => e.role === 'buyer')
      .map(e => e.content)
      .join('\n---\n');

    // Parse metadata
    const txMeta = tx.metadata
      ? (typeof tx.metadata === 'string' ? JSON.parse(tx.metadata) : tx.metadata)
      : {};

    // Build synthetic objects for the arbitration engine
    const syntheticOrder = {
      buyer_id:     tx.buyer_ref,
      amount:       tx.amount || 0,
      requirements: tx.requirements,
      status:       'disputed',
      deadline:     txMeta.deadline || new Date().toISOString(),
      created_at:   tx.created_at,
    };
    const syntheticService = {
      name:        txMeta.service_name || 'External Transaction',
      description: tx.requirements,
    };
    const syntheticDispute = {
      raised_by:   raised_by,
      reason:      dispute_reason,
      evidence:    buyerEvidence || null,
      created_at:  new Date().toISOString(),
    };
    const syntheticDelivery = sellerEvidence
      ? { content: sellerEvidence, created_at: allEvidence.find(e => e.role === 'seller')?.created_at || new Date().toISOString() }
      : null;

    // Run arbitration
    const verdict = await arbitrateDispute({
      order:    syntheticOrder,
      service:  syntheticService,
      dispute:  syntheticDispute,
      delivery: syntheticDelivery,
    });

    // Store verdict
    const verdictId = uuidv4();
    const keyFactorsStr = JSON.stringify(verdict.key_factors || []);
    const votesStr = JSON.stringify(verdict.votes || []);

    await dbRun(
      `INSERT INTO arbitration_verdicts
         (id, transaction_id, winner, confidence, method, reasoning, key_factors, dissent, votes, escalate_to_human)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)})`,
      [verdictId, transaction_id, verdict.winner, verdict.confidence, verdict.method,
       verdict.reasoning, keyFactorsStr, verdict.dissent || null, votesStr,
       isPostgres ? verdict.escalate_to_human : (verdict.escalate_to_human ? 1 : 0)]
    );

    // Update transaction status
    const now = isPostgres ? 'NOW()' : "datetime('now')";
    await dbRun(
      `UPDATE arbitration_transactions SET status = 'arbitrated', verdict_id = ${p(1)}, updated_at = ${now} WHERE id = ${p(2)}`,
      [verdictId, transaction_id]
    );

    res.json({
      transaction_id,
      verdict_id: verdictId,
      status: 'arbitrated',
      evidence_used: allEvidence.length,
      verdict: {
        winner:                 verdict.winner,
        confidence:             verdict.confidence,
        method:                 verdict.method,
        reasoning:              verdict.reasoning,
        key_factors:            verdict.key_factors || [],
        dissent:                verdict.dissent || null,
        votes:                  verdict.votes,
        constitutional_shortcut: verdict.constitutional_shortcut || false,
        escalate_to_human:      verdict.escalate_to_human,
      },
      message: `Arbitration complete. Winner: ${verdict.winner} (confidence: ${(verdict.confidence * 100).toFixed(0)}%). ${allEvidence.length} pieces of evidence were automatically analyzed.`,
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/v1/arbitrate/transaction/:id
 *
 * Get full status of a registered transaction, including all evidence and verdict.
 */
router.get('/transaction/:id', requireApiKey, async (req, res, next) => {
  try {
    const tx = await dbGet(
      `SELECT * FROM arbitration_transactions WHERE id = ${p(1)} AND api_key_owner = ${p(2)}`,
      [req.params.id, req.agent.id]
    );
    if (!tx) return res.status(404).json({ error: 'Transaction not found or access denied' });

    const evidence = await dbAll(
      `SELECT id, submitted_by, role, evidence_type, content, created_at
       FROM arbitration_evidence WHERE transaction_id = ${p(1)} ORDER BY created_at ASC`,
      [tx.id]
    );

    let verdict = null;
    if (tx.verdict_id) {
      const v = await dbGet(
        `SELECT * FROM arbitration_verdicts WHERE id = ${p(1)}`,
        [tx.verdict_id]
      );
      if (v) {
        verdict = {
          verdict_id: v.id,
          winner: v.winner,
          confidence: parseFloat(v.confidence),
          method: v.method,
          reasoning: v.reasoning,
          key_factors: typeof v.key_factors === 'string' ? JSON.parse(v.key_factors) : v.key_factors,
          dissent: v.dissent,
          votes: typeof v.votes === 'string' ? JSON.parse(v.votes) : v.votes,
          escalate_to_human: !!v.escalate_to_human,
          created_at: v.created_at,
        };
      }
    }

    const meta = tx.metadata
      ? (typeof tx.metadata === 'string' ? JSON.parse(tx.metadata) : tx.metadata)
      : null;

    res.json({
      transaction_id: tx.id,
      status: tx.status,
      buyer_ref: tx.buyer_ref,
      seller_ref: tx.seller_ref,
      requirements: tx.requirements,
      amount: tx.amount ? parseFloat(tx.amount) : null,
      currency: tx.currency,
      metadata: meta,
      evidence_count: evidence.length,
      evidence,
      verdict,
      created_at: tx.created_at,
      updated_at: tx.updated_at,
    });
  } catch (err) { next(err); }
});

module.exports = router;
