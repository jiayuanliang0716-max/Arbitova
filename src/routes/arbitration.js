'use strict';

/**
 * External Arbitration API
 *
 * Allows third-party escrow providers (PayCrow, KAMIYO, custom)
 * to use Arbitova's N=3 AI arbitration as a service.
 *
 * POST /api/v1/arbitrate/external
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireApiKey } = require('../middleware/auth');
const { arbitrateDispute } = require('../arbitrate');
const { fire, EVENTS } = require('../webhooks');

const router = express.Router();

/**
 * POST /api/v1/arbitrate/external
 *
 * Body:
 *   escrow_provider    string   - 'paycrow' | 'kamiyo' | 'custom' | any string
 *   dispute_id         string   - Your internal dispute ID (for idempotency)
 *   requirements       string   - Original contract requirements
 *   delivery_evidence  string   - Seller's delivery evidence / content
 *   dispute_reason     string   - Buyer's dispute reason
 *   callback_url       string?  - Webhook URL to receive verdict (optional)
 *
 * Returns:
 *   {
 *     arbitration_id, winner, confidence, method, reasoning,
 *     votes, escalate_to_human, callback_scheduled
 *   }
 */
router.post('/external', requireApiKey, async (req, res, next) => {
  try {
    const {
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

    // Build synthetic order/dispute/delivery objects for the arbitration engine
    const syntheticOrder = {
      buyer_id:     '__external_buyer__',
      amount:       0,
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
      arbitration_id:   arbitrationId,
      dispute_id:       dispute_id || null,
      escrow_provider:  escrow_provider || null,
      winner:           verdict.winner,
      confidence:       verdict.confidence,
      method:           verdict.method,
      reasoning:        verdict.reasoning,
      votes:            verdict.votes,
      escalate_to_human: verdict.escalate_to_human,
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

    const results = await Promise.allSettled(disputes.map(async (d, idx) => {
      const { escrow_provider, dispute_id, requirements, delivery_evidence, dispute_reason, callback_url } = d;

      if (!requirements)      return { index: idx, dispute_id: dispute_id || null, error: 'requirements is required' };
      if (!delivery_evidence) return { index: idx, dispute_id: dispute_id || null, error: 'delivery_evidence is required' };
      if (!dispute_reason)    return { index: idx, dispute_id: dispute_id || null, error: 'dispute_reason is required' };

      const verdict = await arbitrateDispute({
        order: {
          buyer_id: '__external_buyer__',
          amount: 0,
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
        arbitration_id:    arbitrationId,
        dispute_id:        dispute_id || null,
        escrow_provider:   escrow_provider || null,
        winner:            verdict.winner,
        confidence:        verdict.confidence,
        method:            verdict.method,
        reasoning:         verdict.reasoning,
        votes:             verdict.votes,
        escalate_to_human: verdict.escalate_to_human,
        callback_scheduled: !!callback_url,
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

module.exports = router;
