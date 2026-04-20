'use strict';
/**
 * src/path_b/arbiter.js
 *
 * AI arbitration service for Path B on-chain escrow.
 *
 * Flow:
 *   1. Fetch escrow record + verification_uri content + delivery_hash content
 *   2. Build prompt from src/path_b/prompts/arbitration.md
 *   3. Call Claude API (model claude-opus-4-7)
 *   4. Parse structured JSON verdict
 *   5a. If confidence >= 0.7 → compute verdictHash, call resolve() on-chain
 *   5b. If confidence < 0.7 → log for human review, do NOT resolve
 *   6. Store verdict JSON to path_b_verdicts/{escrowId}.json
 *
 * Env vars:
 *   ANTHROPIC_API_KEY   — Claude API key
 *   BASE_RPC_URL        — JSON-RPC endpoint
 *   ESCROW_V1_ADDRESS   — deployed contract
 *   CHAIN_ID            — network
 *   PATH_B_ARBITER_KEY  — private key of the on-chain arbiter role
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { ethers } = require('ethers');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

const VERDICT_DIR = path.resolve(__dirname, '../../path_b_verdicts');
const PROMPT_TEMPLATE_PATH = path.resolve(__dirname, 'prompts/arbitration.md');
const CONFIDENCE_THRESHOLD = 0.7;

const ESCROW_ABI = [
  'function resolve(uint256 id, uint16 buyerBps, uint16 sellerBps, bytes32 verdictHash) external',
];

// ---------------------------------------------------------------------------
// Fetch remote content (verification URI or delivery URI)
// ---------------------------------------------------------------------------
async function fetchContent(uri) {
  if (!uri) return '(no content provided)';
  try {
    // IPFS gateway fallback
    const url = uri.startsWith('ipfs://')
      ? uri.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/')
      : uri;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return `(HTTP ${res.status} fetching ${uri})`;
    return await res.text();
  } catch (err) {
    return `(fetch error: ${err.message})`;
  }
}

// ---------------------------------------------------------------------------
// Build prompt from template
// ---------------------------------------------------------------------------
function buildPrompt(escrow, verificationContent, deliveryContent, disputeReason) {
  const template = fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8');
  return template
    .replace('{{ESCROW_ID}}', String(escrow.escrow_id))
    .replace('{{AMOUNT}}', String(escrow.amount))
    .replace('{{BUYER_ADDRESS}}', escrow.buyer_address)
    .replace('{{SELLER_ADDRESS}}', escrow.seller_address)
    .replace('{{VERIFICATION_URI_CONTENT}}', verificationContent)
    .replace('{{DELIVERY_HASH}}', escrow.delivery_hash || '(none)')
    .replace('{{DELIVERY_CONTENT}}', deliveryContent)
    .replace('{{DISPUTE_REASON}}', disputeReason || '(no reason recorded)');
}

// ---------------------------------------------------------------------------
// Parse Claude response
// ---------------------------------------------------------------------------
function parseVerdict(text) {
  // Strip any accidental markdown fences
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const verdict = JSON.parse(cleaned);

  if (typeof verdict.buyerBps !== 'number' || typeof verdict.sellerBps !== 'number') {
    throw new Error('verdict missing buyerBps / sellerBps');
  }
  if (verdict.buyerBps + verdict.sellerBps !== 10_000) {
    throw new Error(`bps sum ${verdict.buyerBps + verdict.sellerBps} != 10000`);
  }
  if (typeof verdict.confidence !== 'number') {
    throw new Error('verdict missing confidence');
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Save verdict to disk for audit trail
// ---------------------------------------------------------------------------
function saveVerdict(escrowId, verdict) {
  fs.mkdirSync(VERDICT_DIR, { recursive: true });
  const filePath = path.join(VERDICT_DIR, `${escrowId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(verdict, null, 2), 'utf8');
  console.log(`[arbiter] verdict saved to ${filePath}`);
  return filePath;
}

// ---------------------------------------------------------------------------
// Compute verdictHash = keccak256 of canonical JSON
// ---------------------------------------------------------------------------
function computeVerdictHash(verdict) {
  const canonical = JSON.stringify({
    escrowId: verdict.escrowId,
    buyerBps: verdict.buyerBps,
    sellerBps: verdict.sellerBps,
    reasoning: verdict.reasoning,
    confidence: verdict.confidence,
  });
  return ethers.keccak256(ethers.toUtf8Bytes(canonical));
}

// ---------------------------------------------------------------------------
// On-chain resolve
// ---------------------------------------------------------------------------
async function resolveOnChain(escrowId, buyerBps, sellerBps, verdictHash) {
  const rpcUrl = process.env.BASE_RPC_URL;
  const contractAddress = process.env.ESCROW_V1_ADDRESS;
  const chainId = parseInt(process.env.CHAIN_ID || '8453', 10);
  const arbiterKey = process.env.PATH_B_ARBITER_KEY;

  if (!rpcUrl || !contractAddress || !arbiterKey) {
    console.warn('[arbiter] on-chain resolve skipped — env vars missing');
    return null;
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const signer = new ethers.Wallet(arbiterKey, provider);
  const contract = new ethers.Contract(contractAddress, ESCROW_ABI, signer);

  let txHash;
  try {
    const tx = await contract.resolve(escrowId, buyerBps, sellerBps, verdictHash);
    console.log(`[arbiter] resolve tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[arbiter] resolved escrow #${escrowId} in block ${receipt.blockNumber}`);
    txHash = tx.hash;
  } finally {
    provider.destroy();
  }
  return txHash;
}

// ---------------------------------------------------------------------------
// Main: trigger arbitration for a given escrow record
// ---------------------------------------------------------------------------
async function triggerArbitration(escrow) {
  console.log(`[arbiter] starting arbitration for escrow #${escrow.escrow_id}`);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Fetch off-chain content
  const [verificationContent, deliveryContent] = await Promise.all([
    fetchContent(escrow.verification_uri),
    fetchContent(escrow.delivery_payload_uri || null),
  ]);

  const prompt = buildPrompt(escrow, verificationContent, deliveryContent, null);

  // Call Claude
  const message = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseText = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  console.log(`[arbiter] Claude response for escrow #${escrow.escrow_id}:`, responseText);

  let verdict;
  try {
    verdict = parseVerdict(responseText);
  } catch (err) {
    console.error(`[arbiter] failed to parse verdict for escrow #${escrow.escrow_id}:`, err.message);
    console.error('[arbiter] raw response:', responseText);
    return { error: 'parse_failed', raw: responseText };
  }

  verdict.escrowId = escrow.escrow_id;
  const verdictHash = computeVerdictHash(verdict);
  verdict.verdictHash = verdictHash;

  saveVerdict(escrow.escrow_id, verdict);

  if (verdict.confidence < CONFIDENCE_THRESHOLD) {
    console.warn(
      `[arbiter] confidence ${verdict.confidence} < ${CONFIDENCE_THRESHOLD} for escrow #${escrow.escrow_id} — flagging for human review`
    );
    // Update local record to flag it
    await db.updateEscrowState(escrow.escrow_id, {
      verdict_hash: verdictHash + '_NEEDS_REVIEW',
    });
    return { humanReview: true, verdict };
  }

  // Resolve on-chain
  let txHash = null;
  try {
    txHash = await resolveOnChain(
      escrow.escrow_id,
      verdict.buyerBps,
      verdict.sellerBps,
      verdictHash
    );
  } catch (err) {
    console.error(`[arbiter] on-chain resolve failed for escrow #${escrow.escrow_id}:`, err.message);
  }

  // Update DB
  await db.updateEscrowState(escrow.escrow_id, {
    verdict_hash: verdictHash,
    resolved_buyer_bps: verdict.buyerBps,
    resolved_seller_bps: verdict.sellerBps,
    state: txHash ? 'RESOLVED' : escrow.state,
  });

  return { verdict, verdictHash, txHash };
}

module.exports = { triggerArbitration, buildPrompt, parseVerdict, computeVerdictHash, fetchContent };
