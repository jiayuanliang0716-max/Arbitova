'use strict';
/**
 * src/path_b/notify.js
 *
 * Notification service for Path B on-chain escrow events.
 * Called by the indexer after each event is written to the DB.
 *
 * Responsibilities:
 *   - Send email to buyer / seller via Brevo (reuses BREVO_SMTP_* env)
 *   - POST JSON webhook to agent's webhook_url (agents table by wallet_address)
 *   - Trigger arbitration AI on Disputed / Escalated
 *   - Log all delivery attempts to path_b_notifications table
 */

const { dbGet } = require('../db/helpers');
const { p } = require('../db/helpers');
const db = require('./db');
const mailer = require('./mailer');

const RETRY_DELAYS_MS = [2_000, 8_000, 30_000]; // 3 attempts

// ---------------------------------------------------------------------------
// Webhook delivery with retry
// ---------------------------------------------------------------------------
async function deliverWebhook(webhookUrl, payload, retries = RETRY_DELAYS_MS) {
  for (let attempt = 0; attempt <= retries.length; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true, status: res.status };
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt < retries.length) {
        await new Promise((r) => setTimeout(r, retries[attempt]));
      } else {
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Lookup agent webhook URL by wallet address
// ---------------------------------------------------------------------------
async function getAgentWebhookUrl(walletAddress) {
  if (!walletAddress) return null;
  const agent = await dbGet(
    `SELECT settings FROM agents WHERE wallet_address = ${p(1)}`,
    [walletAddress.toLowerCase()]
  ).catch(() => null);
  if (!agent) return null;
  try {
    const settings = typeof agent.settings === 'string'
      ? JSON.parse(agent.settings)
      : (agent.settings || {});
    return settings.webhook_url || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Notification helpers
// ---------------------------------------------------------------------------
async function notifyEmail(escrow, recipient, eventName, subject, body) {
  if (!recipient) return;
  const notifId = await db.insertNotification({
    escrow_id: escrow.escrow_id,
    event_name: eventName,
    channel: 'email',
    recipient,
  });
  try {
    await mailer.sendMail({ to: recipient, subject, text: body });
    await db.updateNotification(notifId, {
      status: 'delivered',
      sent_at: new Date().toISOString(),
      attempt_count: 1,
    });
  } catch (err) {
    await db.updateNotification(notifId, {
      status: 'failed',
      last_error: err.message,
      attempt_count: 1,
    });
    console.error(`[notify] email to ${recipient} failed:`, err.message);
  }
}

async function notifyWebhook(escrow, walletAddress, eventName, payload) {
  const webhookUrl = await getAgentWebhookUrl(walletAddress);
  if (!webhookUrl) return;
  const notifId = await db.insertNotification({
    escrow_id: escrow.escrow_id,
    event_name: eventName,
    channel: 'webhook',
    recipient: webhookUrl,
  });
  try {
    await deliverWebhook(webhookUrl, payload);
    await db.updateNotification(notifId, {
      status: 'delivered',
      sent_at: new Date().toISOString(),
      attempt_count: 1,
    });
  } catch (err) {
    await db.updateNotification(notifId, {
      status: 'failed',
      last_error: err.message,
      attempt_count: RETRY_DELAYS_MS.length + 1,
    });
    console.error(`[notify] webhook to ${webhookUrl} failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Event → notification mapping
// ---------------------------------------------------------------------------
async function handleEvent(eventName, escrow, args) {
  const reviewHours = escrow.review_deadline
    ? Math.round((new Date(escrow.review_deadline) - Date.now()) / 3_600_000)
    : 0;

  const basePayload = {
    event: eventName,
    escrowId: escrow.escrow_id,
    buyerAddress: escrow.buyer_address,
    sellerAddress: escrow.seller_address,
    amountUsdc: escrow.amount,
    state: escrow.state,
    verificationUri: escrow.verification_uri,
    timestamp: new Date().toISOString(),
  };

  switch (eventName) {
    case 'EscrowCreated': {
      const subject = `[Arbitova] Escrow #${escrow.escrow_id} created`;
      const body =
        `An escrow has been created.\n\n` +
        `Escrow ID: ${escrow.escrow_id}\n` +
        `Amount: ${escrow.amount} USDC (atomic units)\n` +
        `Delivery deadline: ${escrow.delivery_deadline}\n` +
        `Verification criteria: ${escrow.verification_uri}\n`;
      await notifyEmail(escrow, escrow.buyer_email, eventName, subject, body);
      await notifyEmail(escrow, escrow.seller_email, eventName, subject, body);
      await notifyWebhook(escrow, escrow.buyer_address, eventName, basePayload);
      await notifyWebhook(escrow, escrow.seller_address, eventName, basePayload);
      break;
    }

    case 'Delivered': {
      const subject = `[Arbitova] Escrow #${escrow.escrow_id} — delivery marked, please verify`;
      const body =
        `The seller has marked delivery for escrow #${escrow.escrow_id}.\n\n` +
        `Delivery hash: ${escrow.delivery_hash}\n` +
        `Please verify delivery within ~${reviewHours} hour(s).\n` +
        `If you take no action, auto-arbitration will start after the review deadline.\n\n` +
        `Verification criteria: ${escrow.verification_uri}\n`;
      await notifyEmail(escrow, escrow.buyer_email, eventName, subject, body);
      await notifyWebhook(escrow, escrow.buyer_address, eventName, {
        ...basePayload,
        deliveryHash: escrow.delivery_hash,
        reviewDeadline: escrow.review_deadline,
        reviewHoursRemaining: reviewHours,
        message: 'Please verify delivery or the escrow will auto-escalate to arbitration.',
      });
      break;
    }

    case 'Released': {
      const subject = `[Arbitova] Escrow #${escrow.escrow_id} released`;
      const body = `Escrow #${escrow.escrow_id} has been confirmed and funds released to the seller.\n`;
      await notifyEmail(escrow, escrow.buyer_email, eventName, subject, body);
      await notifyEmail(escrow, escrow.seller_email, eventName, subject, body);
      await notifyWebhook(escrow, escrow.buyer_address, eventName, basePayload);
      await notifyWebhook(escrow, escrow.seller_address, eventName, basePayload);
      break;
    }

    case 'Disputed': {
      const reason = args && args.reason ? String(args.reason) : '(no reason provided)';
      const subject = `[Arbitova] Escrow #${escrow.escrow_id} disputed`;
      const body =
        `A dispute has been raised for escrow #${escrow.escrow_id}.\n\n` +
        `Reason: ${reason}\n` +
        `Arbitration will begin shortly. You will be notified of the verdict.\n`;
      await notifyEmail(escrow, escrow.buyer_email, eventName, subject, body);
      await notifyEmail(escrow, escrow.seller_email, eventName, subject, body);
      await notifyWebhook(escrow, escrow.buyer_address, eventName, { ...basePayload, reason });
      await notifyWebhook(escrow, escrow.seller_address, eventName, { ...basePayload, reason });
      // Trigger AI arbitration
      const arbiter = require('./arbiter');
      arbiter.triggerArbitration(escrow).catch((e) =>
        console.error('[notify] arbiter trigger failed:', e.message)
      );
      break;
    }

    case 'Escalated': {
      const subject = `[Arbitova] Escrow #${escrow.escrow_id} — auto-arbitration started`;
      const bodyBuyer =
        `Review deadline passed for escrow #${escrow.escrow_id}.\n` +
        `Auto-arbitration has started. You will be notified of the verdict.\n`;
      const bodySeller =
        `Review deadline passed for escrow #${escrow.escrow_id}.\n` +
        `Arbitration is underway. You will be notified of the verdict.\n`;
      await notifyEmail(escrow, escrow.buyer_email, eventName, subject, bodyBuyer);
      await notifyEmail(escrow, escrow.seller_email, eventName, subject, bodySeller);
      await notifyWebhook(escrow, escrow.buyer_address, eventName, basePayload);
      await notifyWebhook(escrow, escrow.seller_address, eventName, basePayload);
      const arbiter = require('./arbiter');
      arbiter.triggerArbitration(escrow).catch((e) =>
        console.error('[notify] arbiter trigger failed:', e.message)
      );
      break;
    }

    case 'Resolved': {
      const subject = `[Arbitova] Escrow #${escrow.escrow_id} — verdict issued`;
      const body =
        `Escrow #${escrow.escrow_id} has been resolved.\n\n` +
        `Buyer allocation: ${escrow.resolved_buyer_bps ?? '?'} bps\n` +
        `Seller allocation: ${escrow.resolved_seller_bps ?? '?'} bps\n` +
        `Verdict hash: ${escrow.verdict_hash}\n`;
      await notifyEmail(escrow, escrow.buyer_email, eventName, subject, body);
      await notifyEmail(escrow, escrow.seller_email, eventName, subject, body);
      await notifyWebhook(escrow, escrow.buyer_address, eventName, {
        ...basePayload,
        verdictHash: escrow.verdict_hash,
        resolvedBuyerBps: escrow.resolved_buyer_bps,
        resolvedSellerBps: escrow.resolved_seller_bps,
      });
      await notifyWebhook(escrow, escrow.seller_address, eventName, {
        ...basePayload,
        verdictHash: escrow.verdict_hash,
        resolvedBuyerBps: escrow.resolved_buyer_bps,
        resolvedSellerBps: escrow.resolved_seller_bps,
      });
      break;
    }

    case 'Cancelled': {
      const subject = `[Arbitova] Escrow #${escrow.escrow_id} cancelled`;
      const body = `Escrow #${escrow.escrow_id} has been cancelled and funds returned to the buyer.\n`;
      await notifyEmail(escrow, escrow.buyer_email, eventName, subject, body);
      await notifyEmail(escrow, escrow.seller_email, eventName, subject, body);
      break;
    }

    default:
      console.log(`[notify] no handler for event ${eventName}`);
  }
}

module.exports = { handleEvent, deliverWebhook, notifyEmail, notifyWebhook };
