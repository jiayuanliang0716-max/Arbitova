'use strict';

/**
 * worker.js — Background job runner (separate from HTTP server)
 *
 * Run independently:  node src/worker.js
 * Render:             add a second service with start command "node src/worker.js"
 *
 * Jobs:
 *  - Every 10 min : expire overdue 'paid' orders (refund buyer)
 *  - Every 30 min : auto-confirm delivered orders not touched after 48h
 *  - Every 30 min : SLA auto-arbitrate — disputed orders past deadline
 *  - Every hour   : subscription billing
 *  - Daily 02:00  : reconciliation + idempotency key cleanup
 */

require('./db/schema'); // initialize DB connection

const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { dbAll, dbGet, dbRun } = require('./db/helpers');
const { arbitrateDispute } = require('./arbitrate');
const { SETTLEMENT_FEE_RATE, DISPUTE_FEE_RATE, creditPlatformFee } = require('./config/fees');

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';
const REP_DISPUTE_PENALTY = 20;

// ── 1. Expire overdue 'paid' orders every 10 min ────────────────────────────
cron.schedule('*/10 * * * *', async () => {
  try {
    const now = new Date().toISOString();
    const expired = await dbAll(
      `SELECT * FROM orders WHERE status = 'paid' AND deadline < ${p(1)}`,
      [now]
    );
    for (const order of expired) {
      await dbRun(
        `UPDATE agents SET balance = balance + ${p(1)}, escrow = escrow - ${p(2)} WHERE id = ${p(3)}`,
        [order.amount, order.amount, order.buyer_id]
      );
      const nowExpr = isPostgres ? 'NOW()' : "datetime('now')";
      await dbRun(
        `UPDATE orders SET status = 'refunded', completed_at = ${nowExpr} WHERE id = ${p(1)}`,
        [order.id]
      );
    }
    if (expired.length > 0) console.log(`[worker] expired orders refunded: ${expired.length}`);
  } catch (err) {
    console.error('[worker] order expiry error:', err.message);
  }
});

// ── 2. Auto-confirm delivered orders after 48h every 30 min ─────────────────
cron.schedule('*/30 * * * *', async () => {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const nowExpr = isPostgres ? 'NOW()' : "datetime('now')";

    const stale = await dbAll(
      `SELECT o.* FROM orders o
       JOIN deliveries d ON d.order_id = o.id
       WHERE o.status = 'delivered' AND d.delivered_at < ${p(1)}`,
      [cutoff]
    );
    for (const order of stale) {
      const fee = parseFloat(order.amount) * SETTLEMENT_FEE_RATE;
      const sellerReceives = parseFloat(order.amount) - fee;
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.buyer_id]);
      await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
      await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${nowExpr} WHERE id = ${p(1)}`, [order.id]);
      await creditPlatformFee(fee);
    }
    if (stale.length > 0) console.log(`[worker] auto-confirmed ${stale.length} stale delivered orders`);
  } catch (err) {
    console.error('[worker] auto-confirm error:', err.message);
  }
});

// ── 3. SLA auto-arbitrate — disputed orders past deadline (P3-4) ────────────
// If an order is 'disputed' AND its deadline has passed, automatically trigger
// AI arbitration so the escrow is not locked indefinitely.
cron.schedule('*/30 * * * *', async () => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return;

    const now = new Date().toISOString();
    const nowExpr = isPostgres ? 'NOW()' : "datetime('now')";

    const overdueDisputed = await dbAll(
      `SELECT o.* FROM orders o
       WHERE o.status = 'disputed' AND o.deadline < ${p(1)}`,
      [now]
    );

    for (const order of overdueDisputed) {
      try {
        const [dispute, service, delivery] = await Promise.all([
          dbGet(`SELECT * FROM disputes WHERE order_id = ${p(1)} AND status = 'open'`, [order.id]),
          dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [order.service_id]),
          dbGet(`SELECT * FROM deliveries WHERE order_id = ${p(1)}`, [order.id]),
        ]);

        if (!dispute) continue;

        const verdict = await arbitrateDispute({ order, service, dispute, delivery });
        const { winner, reasoning, confidence, votes, escalate_to_human } = verdict;

        if (escalate_to_human) {
          // Queue for human review
          const reviewId = uuidv4();
          await dbRun(`UPDATE orders SET status = 'under_review' WHERE id = ${p(1)}`, [order.id]);
          await dbRun(
            `INSERT INTO human_review_queue
               (id, order_id, dispute_id, ai_votes, ai_reasoning, ai_confidence, escalation_reason)
             VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)})`,
            [reviewId, order.id, dispute.id, JSON.stringify(votes), reasoning, confidence, 'SLA expired + low AI confidence']
          );
          console.log(`[worker] SLA escalated to human review: order=${order.id} review=${reviewId}`);
          continue;
        }

        const loserId = winner === 'buyer' ? order.seller_id : order.buyer_id;

        if (winner === 'buyer') {
          await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)}, balance = balance + ${p(2)} WHERE id = ${p(3)}`, [order.amount, order.amount, order.buyer_id]);
          await dbRun(`UPDATE orders SET status = 'refunded', completed_at = ${nowExpr} WHERE id = ${p(1)}`, [order.id]);
        } else {
          const fee = parseFloat(order.amount) * DISPUTE_FEE_RATE;
          const sellerReceives = parseFloat(order.amount) - fee;
          await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.buyer_id]);
          await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
          await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${nowExpr} WHERE id = ${p(1)}`, [order.id]);
          await creditPlatformFee(fee);
        }

        const votesSummary = votes.map(v => `${v.winner}(${(v.confidence*100).toFixed(0)}%)`).join(', ');
        const resolution = `[SLA Auto-Arbitration N=3 | votes: ${votesSummary} | confidence: ${(confidence*100).toFixed(0)}%] ${reasoning}`;
        await dbRun(
          `UPDATE disputes SET status = 'resolved', resolution = ${p(1)}, resolved_at = ${nowExpr} WHERE id = ${p(2)}`,
          [resolution, dispute.id]
        );

        // Reputation penalty on loser
        await dbRun(
          `UPDATE agents SET reputation_score = COALESCE(reputation_score, 0) - ${p(1)} WHERE id = ${p(2)}`,
          [REP_DISPUTE_PENALTY, loserId]
        );
        await dbRun(
          `INSERT INTO reputation_history (agent_id, delta, reason, order_id) VALUES (${p(1)},${p(2)},${p(3)},${p(4)})`,
          [loserId, -REP_DISPUTE_PENALTY, 'sla_auto_arbitration_lost', order.id]
        );

        console.log(`[worker] SLA auto-arbitrated order=${order.id} winner=${winner} confidence=${(confidence*100).toFixed(0)}%`);
      } catch (e) {
        console.error(`[worker] SLA arbitration failed for order ${order.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[worker] SLA auto-arbitrate error:', err.message);
  }
});

// ── 4. Daily reconciliation at 02:00 UTC ────────────────────────────────────
cron.schedule('0 2 * * *', async () => {
  try {
    const nowExpr = isPostgres ? 'NOW()' : "datetime('now')";
    const [escrowSum, ordersSum] = await Promise.all([
      dbAll('SELECT COALESCE(SUM(escrow), 0) as total FROM agents', []),
      dbAll(`SELECT COALESCE(SUM(amount), 0) as total FROM orders WHERE status IN ('paid', 'delivered', 'disputed', 'under_review')`, []),
    ]);

    const escrowTotal = parseFloat(escrowSum[0]?.total || 0);
    const ordersTotal = parseFloat(ordersSum[0]?.total || 0);
    const delta = Math.abs(escrowTotal - ordersTotal);

    if (delta > 0.01) {
      console.error(`[reconciliation] MISMATCH: escrow_sum=${escrowTotal} orders_sum=${ordersTotal} delta=${delta.toFixed(6)}`);
    } else {
      console.log(`[reconciliation] OK: escrow=${escrowTotal} orders_in_flight=${ordersTotal}`);
    }

    // Purge expired idempotency keys
    await dbAll(`DELETE FROM idempotency_keys WHERE expires_at < ${nowExpr}`, []).catch(() => {});
  } catch (err) {
    console.error('[worker] reconciliation error:', err.message);
  }
});

// ── 6. Moltbook auto-reply every 30 min ─────────────────────────────────────
const repliedCommentIds = new Set();

cron.schedule('*/30 * * * *', async () => {
  if (!process.env.MOLTBOOK_API_KEY || !process.env.ANTHROPIC_API_KEY) return;

  const BASE = 'https://www.moltbook.com/api/v1';
  const headers = {
    'Authorization': `Bearer ${process.env.MOLTBOOK_API_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const postsRes = await fetch(`${BASE}/agents/arbitova/posts`, { headers });
    if (!postsRes.ok) { console.error('[moltbook] failed to fetch posts:', postsRes.status); return; }
    const { posts = [] } = await postsRes.json();

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    for (const post of posts.slice(0, 10)) {
      const commentsRes = await fetch(`${BASE}/posts/${post.id}/comments`, { headers });
      if (!commentsRes.ok) continue;
      const { comments = [] } = await commentsRes.json();

      for (const comment of comments) {
        if (repliedCommentIds.has(comment.id)) continue;
        if (comment.author === 'arbitova') { repliedCommentIds.add(comment.id); continue; }

        const alreadyReplied = comments.some(
          c => c.parent_id === comment.id && c.author === 'arbitova'
        );
        if (alreadyReplied) { repliedCommentIds.add(comment.id); continue; }

        const msg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `You are Arbitova, an AI agent providing trust infrastructure for A2A (agent-to-agent) transactions — escrow, verification, and arbitration.\n\nPost: "${post.title || post.content}"\nComment: "${comment.content}"\n\nWrite a concise, helpful reply (1-3 sentences) as Arbitova. Stay on topic.`,
          }],
        });

        const replyText = msg.content[0].text;

        const postRes = await fetch(`${BASE}/posts/${post.id}/comments`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: replyText, parent_id: comment.id }),
        });

        repliedCommentIds.add(comment.id);
        if (!postRes.ok) {
          console.error(`[moltbook] failed to post reply:`, postRes.status);
          continue;
        }

        const postData = await postRes.json();
        console.log(`[moltbook] replied to comment ${comment.id} on post ${post.id}`);

        // Solve verification challenge if present
        const verification = postData?.comment?.verification;
        if (verification?.verification_code && verification?.challenge_text) {
          try {
            const solveMsg = await client.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 20,
              messages: [{
                role: 'user',
                content: `Solve this math problem and respond with ONLY the number to 2 decimal places (e.g. "36.00"). No other text.\n\nProblem: ${verification.challenge_text}`,
              }],
            });
            const answer = solveMsg.content[0].text.trim();
            const verifyRes = await fetch(`${BASE}/verify`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ verification_code: verification.verification_code, answer }),
            });
            const verifyData = await verifyRes.json();
            if (verifyData.success) {
              console.log(`[moltbook] verified comment ${postData.comment.id} answer=${answer}`);
            } else {
              console.error(`[moltbook] verification failed for comment ${postData.comment.id}: ${verifyData.message}`);
            }
          } catch (verifyErr) {
            console.error(`[moltbook] verification error:`, verifyErr.message);
          }
        }

        await new Promise(r => setTimeout(r, 1000));
      }
    }
  } catch (err) {
    console.error('[moltbook] auto-reply error:', err.message);
  }
});

console.log('[worker] Arbitova background worker started');
