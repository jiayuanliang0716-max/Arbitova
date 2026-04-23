'use strict';
/**
 * src/path_b/arbiter.js
 *
 * AI arbitration service for Path B on-chain escrow.
 *
 * Flow:
 *   1. Fetch escrow record + verification_uri content + delivery_hash content
 *   2. Verify delivery content-hash against on-chain recorded hash (M-4).
 *      On mismatch, escalate to human review without calling the LLM.
 *   3. Build prompt from src/path_b/prompts/arbitration.md with every
 *      untrusted field wrapped in a breakout-safe XML region (M-3).
 *   4. Call Claude API (model claude-opus-4-7)
 *   5. Parse structured JSON verdict
 *   6a. If confidence >= 0.7 AND content hash did not mismatch → compute
 *       verdictHash, call resolve() on-chain
 *   6b. Otherwise → log for human review, do NOT resolve
 *   7. Store verdict JSON to path_b_verdicts/{escrowId}.json
 *
 * Defenses (ported 2026-04-24 from the now-deleted Path A arbitrate.js):
 *   M-3 — Prompt-injection defense via structural isolation. Every
 *         untrusted field is wrapped in <tag> … </tag> with closing-tag
 *         bytes inside the content escaped by a zero-width space so
 *         an attacker cannot break out of the tagged region. The system
 *         prompt (arbitration.md) tells the model that tagged regions
 *         are data-only.
 *   M-4 — Delivery content-hash verification. keccak256(content bytes)
 *         is compared to the on-chain delivery_hash. A mismatch is a
 *         hard escalation gate, independent of confidence. URI-only
 *         hashing (an older SDK mode) degrades to an advisory rather
 *         than a full verification because the URI is mutable.
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
// M-3: Structural prompt-injection defense
// ---------------------------------------------------------------------------

/**
 * Strip ASCII control characters and cap length. Retained from the
 * Path A defense — control characters have no legitimate use in party
 * claims or delivery payloads and some tokenizers mis-handle them.
 * Unlike the older version this does NOT pattern-match phrases: that
 * defense line is now structural (see wrapUntrusted).
 */
function sanitizeClaim(text) {
  if (text === null || text === undefined) return '(none)';
  return String(text)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .slice(0, 10_000);
}

/**
 * Wrap arbitrary untrusted content inside an XML region. The closing
 * tag bytes inside the content are escaped with a zero-width space
 * inserted between `<` and `/`, so the attacker cannot emit a literal
 * `</tag>` sequence that would close the region early.
 *
 * The zero-width space (U+200B) is not rendered by the tokenizer as
 * part of the tag syntax but remains visible in audit logs, so a
 * reviewer can still read the raw attacker payload verbatim.
 *
 * @param {string} tag   — alphanumeric + underscore tag name
 * @param {string} text  — arbitrary untrusted text
 * @returns {string}     — breakout-safe tagged region
 */
function wrapUntrusted(tag, text) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tag)) {
    throw new Error(`invalid tag name: ${tag}`);
  }
  const safe = sanitizeClaim(text)
    .replace(new RegExp(`</(${tag})\\b`, 'gi'), '<​/$1');
  return `<${tag}>\n${safe}\n</${tag}>`;
}

// ---------------------------------------------------------------------------
// M-4: Delivery content-hash verification
// ---------------------------------------------------------------------------

/**
 * Verify that the fetched delivery content matches the keccak256 hash
 * that was recorded on-chain at markDelivered time.
 *
 * Two acceptable hashing modes exist in the SDK surface:
 *   - content-mode: delivery_hash = keccak256(delivery_content_bytes)
 *   - uri-mode:     delivery_hash = keccak256(utf8_bytes(uri))
 *
 * Content-mode is a strong integrity proof. URI-mode is weaker — it
 * proves the seller committed to a URI but not that the content served
 * from that URI is unchanged; HTTP is mutable, IPFS gateway caches
 * drift, etc. We treat URI-mode as an advisory, not a full verification.
 *
 * @param {string} deliveryContent — bytes fetched from delivery URI
 * @param {string} deliveryUri     — URI that was committed on-chain
 * @param {string} recordedHash    — on-chain delivery_hash (0x-prefixed 32-byte hex)
 * @returns {object} {
 *   match:  true | false | null,
 *   mode:   'content' | 'uri-only' | 'mismatch' | 'none',
 *   recorded: string|null,
 *   recomputed_content: string,
 *   recomputed_uri: string|null,
 * }
 */
function verifyDeliveryContentHash(deliveryContent, deliveryUri, recordedHash) {
  const recorded = recordedHash && recordedHash !== '0x' && recordedHash !== ('0x' + '0'.repeat(64))
    ? recordedHash.toLowerCase()
    : null;
  const recomputedContent = ethers.keccak256(ethers.toUtf8Bytes(String(deliveryContent ?? '')));
  const recomputedUri = deliveryUri
    ? ethers.keccak256(ethers.toUtf8Bytes(deliveryUri))
    : null;

  if (!recorded) {
    return {
      match: null,
      mode: 'none',
      recorded: null,
      recomputed_content: recomputedContent,
      recomputed_uri: recomputedUri,
    };
  }
  if (recomputedContent.toLowerCase() === recorded) {
    return { match: true, mode: 'content', recorded, recomputed_content: recomputedContent, recomputed_uri: recomputedUri };
  }
  if (recomputedUri && recomputedUri.toLowerCase() === recorded) {
    return { match: true, mode: 'uri-only', recorded, recomputed_content: recomputedContent, recomputed_uri: recomputedUri };
  }
  return { match: false, mode: 'mismatch', recorded, recomputed_content: recomputedContent, recomputed_uri: recomputedUri };
}

// ---------------------------------------------------------------------------
// Fetch remote content (verification URI or delivery URI)
// ---------------------------------------------------------------------------
async function fetchContent(uri) {
  if (!uri) return '(no content provided)';
  try {
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
// Build prompt from template — every untrusted field is wrapped.
// ---------------------------------------------------------------------------
function buildPrompt(escrow, verificationContent, deliveryContent, disputeReason, hashCheck) {
  const template = fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8');
  const hashNote = hashCheck && hashCheck.match === true
    ? (hashCheck.mode === 'content'
        ? 'VERIFIED — keccak256(delivery bytes) matches on-chain hash.'
        : 'ADVISORY — the on-chain hash was of the URI only, not the content. Content integrity cannot be proven from the chain.')
    : hashCheck && hashCheck.match === false
      ? 'MISMATCH — delivery content hash does NOT match what was recorded on-chain. Treat delivery as untrusted.'
      : 'NO_HASH — no delivery hash was recorded on-chain for this escrow.';

  return template
    .replace('{{ESCROW_ID}}', String(escrow.escrow_id))
    .replace('{{AMOUNT}}', String(escrow.amount))
    .replace('{{BUYER_ADDRESS}}', escrow.buyer_address)
    .replace('{{SELLER_ADDRESS}}', escrow.seller_address)
    .replace('{{VERIFICATION_URI_CONTENT}}', wrapUntrusted('verification_criteria', verificationContent))
    .replace('{{DELIVERY_HASH}}', escrow.delivery_hash || '(none)')
    .replace('{{DELIVERY_HASH_CHECK}}', hashNote)
    .replace('{{DELIVERY_CONTENT}}', wrapUntrusted('delivery_evidence', deliveryContent))
    .replace('{{DISPUTE_REASON}}', wrapUntrusted('dispute_reason', disputeReason || '(no reason recorded)'));
}

// ---------------------------------------------------------------------------
// Parse Claude response
// ---------------------------------------------------------------------------
function parseVerdict(text) {
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

  const [verificationContent, deliveryContent] = await Promise.all([
    fetchContent(escrow.verification_uri),
    fetchContent(escrow.delivery_payload_uri || null),
  ]);

  // M-4 hash gate: if the on-chain hash doesn't match the fetched
  // content, we do not trust the delivery. Skip the LLM call and
  // escalate for human review. Saves API $ and makes the gate
  // unambiguous: "content drifted" is not a verdict an LLM can fix.
  const hashCheck = verifyDeliveryContentHash(
    deliveryContent,
    escrow.delivery_payload_uri || null,
    escrow.delivery_hash
  );

  if (hashCheck.match === false) {
    console.warn(
      `[arbiter] hash mismatch for escrow #${escrow.escrow_id} — recorded=${hashCheck.recorded} recomputed_content=${hashCheck.recomputed_content}`
    );
    const stub = {
      escrowId: escrow.escrow_id,
      escalated: true,
      escalation_reason: 'delivery_content_hash_mismatch',
      hash_check: hashCheck,
      message: 'Delivery content does not match the on-chain delivery_hash; escalated to human review without LLM call.',
    };
    saveVerdict(escrow.escrow_id, stub);
    await db.updateEscrowState(escrow.escrow_id, {
      verdict_hash: 'HASH_MISMATCH_NEEDS_REVIEW',
    });
    return { humanReview: true, escalationReason: 'delivery_content_hash_mismatch', hashCheck };
  }

  const prompt = buildPrompt(escrow, verificationContent, deliveryContent, null, hashCheck);

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
  verdict.hash_check = hashCheck;
  const verdictHash = computeVerdictHash(verdict);
  verdict.verdictHash = verdictHash;

  saveVerdict(escrow.escrow_id, verdict);

  if (verdict.confidence < CONFIDENCE_THRESHOLD) {
    console.warn(
      `[arbiter] confidence ${verdict.confidence} < ${CONFIDENCE_THRESHOLD} for escrow #${escrow.escrow_id} — flagging for human review`
    );
    await db.updateEscrowState(escrow.escrow_id, {
      verdict_hash: verdictHash + '_NEEDS_REVIEW',
    });
    return { humanReview: true, verdict };
  }

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

  await db.updateEscrowState(escrow.escrow_id, {
    verdict_hash: verdictHash,
    resolved_buyer_bps: verdict.buyerBps,
    resolved_seller_bps: verdict.sellerBps,
    state: txHash ? 'RESOLVED' : escrow.state,
  });

  return { verdict, verdictHash, txHash };
}

module.exports = {
  triggerArbitration,
  buildPrompt,
  parseVerdict,
  computeVerdictHash,
  fetchContent,
  sanitizeClaim,
  wrapUntrusted,
  verifyDeliveryContentHash,
};
