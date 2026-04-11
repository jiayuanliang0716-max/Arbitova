'use strict';

/**
 * webhooks.js — Outbound webhook dispatcher for Arbitova
 *
 * Usage:
 *   const { fire, EVENTS } = require('./webhooks');
 *   await fire([buyerId, sellerId], EVENTS.ORDER_COMPLETED, { order_id, amount, ... });
 *
 * Each registered webhook that subscribes to the event receives a signed POST request.
 * Failed deliveries are retried up to MAX_RETRIES times with exponential backoff.
 * All attempts are logged to webhook_deliveries table.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { dbAll, dbRun } = require('./db/helpers');

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 5000, 15000];
const REQUEST_TIMEOUT_MS = 10000;

const EVENTS = {
  ORDER_CREATED:        'order.created',
  ORDER_DELIVERED:      'order.delivered',
  ORDER_COMPLETED:      'order.completed',
  ORDER_REFUNDED:       'order.refunded',
  ORDER_DISPUTED:       'order.disputed',
  ORDER_CANCELLED:      'order.cancelled',
  ORDER_TIP_RECEIVED:   'order.tip_received',
  ORDER_DEADLINE_EXTENDED: 'order.deadline_extended',
  DISPUTE_RESOLVED:     'dispute.resolved',
  DISPUTE_APPEALED:     'dispute.appealed',
  VERIFICATION_PASSED:  'verification.passed',
  VERIFICATION_FAILED:  'verification.failed',
  MESSAGE_RECEIVED:     'message.received',
};

// Build HMAC-SHA256 signature for a payload string
function sign(payloadStr, secret) {
  return 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(payloadStr)
    .digest('hex');
}

// Attempt a single HTTP delivery; returns true on success
async function attempt(webhook, deliveryId, event, payloadStr) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Arbitova-Signature': sign(payloadStr, webhook.secret),
        'X-Arbitova-Event':     event,
        'X-Arbitova-Delivery':  deliveryId,
      },
      body: payloadStr,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0 };
  }
}

// Deliver one webhook with retries; logs every attempt
async function deliver(webhook, event, data) {
  const isPostgres = !!process.env.DATABASE_URL;
  const p = (n) => isPostgres ? `$${n}` : '?';
  const now = () => isPostgres ? 'NOW()' : "datetime('now')";

  const deliveryId = uuidv4();
  const payloadStr = JSON.stringify({
    event,
    delivery_id: deliveryId,
    timestamp:   new Date().toISOString(),
    data,
  });

  let lastStatus = 0;

  for (let i = 0; i < MAX_RETRIES; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[i - 1]));

    const result = await attempt(webhook, deliveryId, event, payloadStr);
    lastStatus = result.status;

    if (result.ok) {
      await dbRun(
        `INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, response_code, attempts, status, delivered_at)
         VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},'delivered',${now()})`,
        [deliveryId, webhook.id, event, payloadStr, result.status, i + 1]
      ).catch(() => {});
      await dbRun(
        `UPDATE webhooks SET last_triggered_at = ${now()} WHERE id = ${p(1)}`,
        [webhook.id]
      ).catch(() => {});
      return;
    }
  }

  // All retries exhausted
  await dbRun(
    `INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, response_code, attempts, status)
     VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},'failed')`,
    [deliveryId, webhook.id, event, payloadStr, lastStatus, MAX_RETRIES]
  ).catch(() => {});

  console.error(`[webhooks] delivery failed after ${MAX_RETRIES} attempts → ${webhook.url} (${event})`);
}

/**
 * Fire an event to all matching webhooks for the given agent IDs.
 * Non-blocking — returns immediately, deliveries happen in background.
 *
 * @param {string|string[]} agentIds  - One or more agent IDs (buyer + seller both notified)
 * @param {string}          event     - One of EVENTS.*
 * @param {object}          data      - Event payload
 */
async function fire(agentIds, event, data) {
  const ids = (Array.isArray(agentIds) ? agentIds : [agentIds]).filter(Boolean);
  if (!ids.length) return;

  try {
    const isPostgres = !!process.env.DATABASE_URL;
    const p = (n) => isPostgres ? `$${n}` : '?';

    for (const agentId of ids) {
      const rows = await dbAll(
        `SELECT * FROM webhooks WHERE agent_id = ${p(1)} AND is_active = ${isPostgres ? 'true' : '1'}`,
        [agentId]
      );

      for (const wh of rows) {
        const events = typeof wh.events === 'string' ? JSON.parse(wh.events) : wh.events;
        if (events.includes(event) || events.includes('*')) {
          // Fire and forget — don't await
          deliver(wh, event, data).catch(err =>
            console.error('[webhooks] unhandled delivery error:', err.message)
          );
        }
      }
    }
  } catch (err) {
    console.error('[webhooks] fire error:', err.message);
  }
}

module.exports = { fire, EVENTS, sign };
