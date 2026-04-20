/**
 * Arbitova Path B — Buyer Demo (Node.js)
 *
 * Demonstrates the full buyer-side flow:
 *   1. Create an on-chain escrow (locks USDC into EscrowV1)
 *   2. Poll for the Delivered event from the seller
 *   3. Fetch delivery payload and verification criteria
 *   4. Check every criterion
 *   5. Confirm if all pass, or dispute with specific reason if any fail
 *
 * REQUIRED ENV VARS:
 *   ARBITOVA_RPC_URL           — e.g. https://sepolia.base.org or https://mainnet.base.org
 *   ARBITOVA_ESCROW_ADDRESS    — deployed EscrowV1 address (<FILL_IN_AFTER_DEPLOY>)
 *   ARBITOVA_USDC_ADDRESS      — USDC token address
 *                                Sepolia: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
 *                                Mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *   ARBITOVA_AGENT_PRIVATE_KEY — Buyer wallet private key (0x-prefixed)
 *   SELLER_ADDRESS             — Seller Ethereum address
 *
 * HOW TO RUN:
 *   node examples/path_b/buyer_demo.js
 *
 * EXPECTED OUTPUT:
 *   [Buyer] Creating escrow for 5 USDC with seller 0xSELLER...
 *   [Buyer] Escrow created. ID: 1, txHash: 0x...
 *   [Buyer] Polling for Delivered event on escrow 1...
 *   [Buyer] Delivered event received. deliveryHash: 0x...
 *   [Buyer] Fetching verification criteria from https://...
 *   [Buyer] Fetching delivery payload from https://...
 *   [Buyer] Checking criterion 1: "word count >= 500" ... PASS
 *   [Buyer] Checking criterion 2: "includes summary section" ... PASS
 *   [Buyer] All criteria passed. Confirming delivery.
 *   [Buyer] Delivery confirmed. txHash: 0x...
 *
 *   (or if a criterion fails)
 *   [Buyer] Criterion 2 FAILED: spec requires summary section, not found in delivery.
 *   [Buyer] Disputing escrow 1. Reason: "Criterion 2 not met: ..."
 *   [Buyer] Dispute submitted. txHash: 0x...
 */

'use strict';

require('dotenv').config();
const { ethers } = require('ethers');
const {
  arbitova_create_escrow,
  arbitova_confirm_delivery,
  arbitova_dispute,
  arbitova_get_escrow,
  ESCROW_ABI,
} = require('../../sdk/pathB');

// ── Config ───────────────────────────────────────────────────────────────────

const SELLER_ADDRESS = process.env.SELLER_ADDRESS;
if (!SELLER_ADDRESS) {
  console.error('Set SELLER_ADDRESS env var to the seller Ethereum address.');
  process.exit(1);
}

// A sample verification criteria document.
// In production, upload this JSON to IPFS or a stable URL before creating the escrow.
const MOCK_VERIFICATION_URI = 'https://raw.githubusercontent.com/jiayuanliang0716-max/Arbitova/main/examples/path_b/sample_criteria.json';

// Simulated criteria (matches what would be at MOCK_VERIFICATION_URI).
const CRITERIA = [
  { id: 1, text: 'word count >= 500' },
  { id: 2, text: 'includes an executive summary section' },
  { id: 3, text: 'output is in valid JSON or Markdown format' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

/**
 * Naive criterion checker. In production, use your LLM or structured evaluator.
 */
function checkCriterion(criterion, deliveryText) {
  if (criterion.text.includes('word count')) {
    const match = criterion.text.match(/>=\s*(\d+)/);
    if (match) {
      const required = parseInt(match[1], 10);
      const actual = deliveryText.trim().split(/\s+/).length;
      return { pass: actual >= required, observed: `word count = ${actual}` };
    }
  }
  if (criterion.text.includes('executive summary')) {
    const found = /executive summary/i.test(deliveryText);
    return { pass: found, observed: found ? 'section found' : 'section absent' };
  }
  if (criterion.text.includes('JSON or Markdown')) {
    const isJson = deliveryText.trim().startsWith('{') || deliveryText.trim().startsWith('[');
    const isMd = deliveryText.includes('#') || deliveryText.includes('**');
    const pass = isJson || isMd;
    return { pass, observed: pass ? 'valid format' : 'unrecognized format' };
  }
  // Unknown criterion: treat as uncertain — safer to dispute
  return { pass: false, observed: 'criterion unknown, cannot verify automatically' };
}

/**
 * Poll getEscrow until status = DELIVERED (1), or timeout.
 */
async function pollForDelivery(escrowId, maxWaitSeconds = 300) {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  while (Date.now() < deadline) {
    const state = await arbitova_get_escrow({ escrowId: String(escrowId) });
    if (!state.ok) {
      console.error('[Buyer] Error fetching escrow:', state.error);
      await sleep(10000);
      continue;
    }
    if (state.status === 'DELIVERED') return state;
    if (['CONFIRMED', 'DISPUTED', 'CANCELLED', 'RESOLVED'].includes(state.status)) {
      throw new Error(`Escrow already in terminal state: ${state.status}`);
    }
    console.log(`[Buyer] Status: ${state.status}. Waiting for seller to deliver...`);
    await sleep(10000);
  }
  throw new Error(`Timed out waiting for delivery after ${maxWaitSeconds}s`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[Buyer] Creating escrow for 5 USDC with seller ${SELLER_ADDRESS}...`);

  const createResult = await arbitova_create_escrow({
    seller: SELLER_ADDRESS,
    amount: 5,
    deliveryWindowHours: 24,
    reviewWindowHours: 24,
    verificationURI: MOCK_VERIFICATION_URI,
  });

  if (!createResult.ok) {
    console.error('[Buyer] Failed to create escrow:', createResult.error);
    console.error('[Buyer] Hint:', createResult.hint);
    process.exit(1);
  }

  const escrowId = createResult.escrowId;
  console.log(`[Buyer] Escrow created. ID: ${escrowId}, txHash: ${createResult.txHash}`);
  console.log(`[Buyer] Polling for Delivered event on escrow ${escrowId}...`);

  let escrowState;
  try {
    escrowState = await pollForDelivery(escrowId);
  } catch (e) {
    console.error('[Buyer] Polling failed:', e.message);
    process.exit(1);
  }

  console.log(`[Buyer] Escrow is DELIVERED. deliveryHash: ${escrowState.deliveryHash}`);

  // In production: the delivery payload URI is communicated by the seller off-chain
  // or derived from an event. Here we use a placeholder.
  const deliveryPayloadURI = process.env.DELIVERY_PAYLOAD_URI || 'https://example.com/delivery-placeholder';

  // Step 1: fetch verification criteria
  console.log(`[Buyer] Fetching verification criteria from ${escrowState.verificationURI}`);
  let criteria = CRITERIA; // Use local fallback for demo
  try {
    const doc = await fetchJson(escrowState.verificationURI);
    if (Array.isArray(doc.criteria)) {
      criteria = doc.criteria.map((text, i) => ({ id: i + 1, text }));
    }
  } catch (e) {
    console.warn(`[Buyer] Could not fetch verificationURI (${e.message}). Using demo criteria.`);
  }

  // Step 2: fetch delivery payload
  console.log(`[Buyer] Fetching delivery payload from ${deliveryPayloadURI}`);
  let deliveryText = '';
  try {
    deliveryText = await fetchText(deliveryPayloadURI);
  } catch (e) {
    console.error(`[Buyer] Cannot fetch delivery payload: ${e.message}`);
    const disputeReason = `deliveryPayloadURI is unreachable: ${deliveryPayloadURI}. Cannot verify delivery.`;
    console.log(`[Buyer] Disputing escrow ${escrowId}. Reason: "${disputeReason}"`);
    const dr = await arbitova_dispute({ escrowId: String(escrowId), reason: disputeReason });
    console.log(dr.ok ? `[Buyer] Dispute submitted. txHash: ${dr.txHash}` : `[Buyer] Dispute failed: ${dr.error}`);
    return;
  }

  // Step 3: check each criterion
  const failures = [];
  for (const criterion of criteria) {
    const { pass, observed } = checkCriterion(criterion, deliveryText);
    const status = pass ? 'PASS' : 'FAIL';
    console.log(`[Buyer] Checking criterion ${criterion.id}: "${criterion.text}" ... ${status} (${observed})`);
    if (!pass) {
      failures.push({ criterion, observed });
    }
  }

  // Step 4: confirm or dispute
  if (failures.length === 0) {
    console.log('[Buyer] All criteria passed. Confirming delivery.');
    const confirmResult = await arbitova_confirm_delivery({ escrowId: String(escrowId) });
    if (confirmResult.ok) {
      console.log(`[Buyer] Delivery confirmed. txHash: ${confirmResult.txHash}`);
    } else {
      console.error('[Buyer] Confirm failed:', confirmResult.error);
    }
  } else {
    const reasonParts = failures.map(
      f => `Criterion ${f.criterion.id} not met: spec="${f.criterion.text}", observed="${f.observed}"`
    );
    const disputeReason = reasonParts.join('. ');
    console.log(`[Buyer] ${failures.length} criterion/criteria failed. Disputing escrow ${escrowId}.`);
    console.log(`[Buyer] Reason: "${disputeReason}"`);
    const disputeResult = await arbitova_dispute({ escrowId: String(escrowId), reason: disputeReason });
    if (disputeResult.ok) {
      console.log(`[Buyer] Dispute submitted. txHash: ${disputeResult.txHash}`);
    } else {
      console.error('[Buyer] Dispute failed:', disputeResult.error);
    }
  }
}

main().catch(e => {
  console.error('[Buyer] Unhandled error:', e);
  process.exit(1);
});
