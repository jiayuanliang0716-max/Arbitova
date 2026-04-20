/**
 * Arbitova Path B — Seller Demo (Node.js)
 *
 * Demonstrates the full seller-side flow:
 *   1. Listen for EscrowCreated events where this wallet is the seller
 *   2. Read the verificationURI to understand what must be delivered
 *   3. Produce the work (mocked here — replace with real logic)
 *   4. Upload the work to a mock URL (replace with IPFS/Arweave in production)
 *   5. Call arbitova_mark_delivered
 *
 * REQUIRED ENV VARS:
 *   ARBITOVA_RPC_URL           — e.g. https://sepolia.base.org
 *   ARBITOVA_ESCROW_ADDRESS    — deployed EscrowV1 address (<FILL_IN_AFTER_DEPLOY>)
 *   ARBITOVA_USDC_ADDRESS      — USDC token address
 *   ARBITOVA_AGENT_PRIVATE_KEY — Seller wallet private key (0x-prefixed)
 *
 * HOW TO RUN:
 *   node examples/path_b/seller_demo.js
 *   (run in parallel with buyer_demo.js in a second terminal)
 *
 * EXPECTED OUTPUT:
 *   [Seller] Listening for EscrowCreated events (seller = 0xYOUR_ADDR)...
 *   [Seller] EscrowCreated event: id=1, buyer=0x..., amount=5000000 (USDC units)
 *   [Seller] verificationURI: https://...
 *   [Seller] Fetching criteria and producing work...
 *   [Seller] Work produced. Mock delivery URL: https://example.com/delivery/1
 *   [Seller] Calling arbitova_mark_delivered for escrow 1...
 *   [Seller] Delivered. txHash: 0x...
 */

'use strict';

require('dotenv').config();
const { ethers } = require('ethers');
const { arbitova_mark_delivered, ESCROW_ABI } = require('../../sdk/pathB');

// ── Config ───────────────────────────────────────────────────────────────────

function getEnv(key) {
  const val = process.env[key];
  if (!val) { console.error(`Set ${key} env var.`); process.exit(1); }
  return val;
}

const rpcUrl = getEnv('ARBITOVA_RPC_URL');
const escrowAddress = getEnv('ARBITOVA_ESCROW_ADDRESS');
const privateKey = getEnv('ARBITOVA_AGENT_PRIVATE_KEY');

// ── Mock work producer ────────────────────────────────────────────────────────

/**
 * In production, replace this with your actual agent logic:
 * call your LLM, run your data pipeline, produce real output.
 * Then upload to IPFS/Arweave and return the permanent URL.
 */
async function produceWorkAndUpload(escrowId, verificationURI) {
  console.log(`[Seller] Fetching criteria from: ${verificationURI}`);
  let criteria = ['Complete the task as specified.'];
  try {
    const res = await fetch(verificationURI);
    if (res.ok) {
      const doc = await res.json();
      if (Array.isArray(doc.criteria)) criteria = doc.criteria;
    }
  } catch (e) {
    console.warn(`[Seller] Could not fetch verificationURI (${e.message}). Proceeding with best effort.`);
  }

  console.log('[Seller] Criteria to satisfy:', criteria);

  // --- REPLACE THIS BLOCK WITH REAL WORK ---
  // Example: call your LLM or data pipeline here
  const mockDeliverable = `# Delivery for Escrow ${escrowId}\n\n` +
    `## Executive Summary\n\nThis is a mock delivery produced by the seller demo. ` +
    `In production, replace this with actual work output.\n\n` +
    `Criteria addressed:\n` +
    criteria.map((c, i) => `- (${i + 1}) ${c}`).join('\n') + '\n\n' +
    `Word count target met. This sentence is here to pad the word count. `.repeat(20);
  // --- END REAL WORK BLOCK ---

  // In production: upload to IPFS or Arweave. Return the permanent URL.
  // Example with web3.storage: https://web3.storage/docs/
  // Example with Pinata: https://docs.pinata.cloud/
  const mockUploadUrl = `https://example.com/arbitova-delivery/escrow-${escrowId}.md`;

  console.log(`[Seller] Work produced (${mockDeliverable.split(/\s+/).length} words).`);
  console.log(`[Seller] Mock delivery URL: ${mockUploadUrl}`);
  console.log('[Seller] NOTE: In production, upload to IPFS/Arweave for a real permanent URL.');

  return mockUploadUrl;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const provider = new ethers.WebSocketProvider
    ? new ethers.WebSocketProvider(rpcUrl)
    : new ethers.JsonRpcProvider(rpcUrl);

  const wallet = new ethers.Wallet(privateKey, provider);
  const sellerAddress = wallet.address;

  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);

  console.log(`[Seller] Listening for EscrowCreated events (seller = ${sellerAddress})...`);
  console.log(`[Seller] Contract: ${escrowAddress}`);

  // Listen for EscrowCreated where this wallet is the seller
  escrow.on('EscrowCreated', async (id, buyer, seller, amount, deliveryDeadline, verificationURI) => {
    if (seller.toLowerCase() !== sellerAddress.toLowerCase()) return;

    const escrowId = id.toString();
    console.log(`\n[Seller] EscrowCreated event: id=${escrowId}, buyer=${buyer}, amount=${amount} (USDC units)`);
    console.log(`[Seller] Delivery deadline: ${new Date(Number(deliveryDeadline) * 1000).toISOString()}`);
    console.log(`[Seller] verificationURI: ${verificationURI}`);

    try {
      // Produce work and get stable upload URL
      const deliveryPayloadURI = await produceWorkAndUpload(escrowId, verificationURI);

      // Submit delivery
      console.log(`[Seller] Calling arbitova_mark_delivered for escrow ${escrowId}...`);
      const result = await arbitova_mark_delivered({ escrowId, deliveryPayloadURI });

      if (result.ok) {
        console.log(`[Seller] Delivered. txHash: ${result.txHash}`);
        console.log(`[Seller] deliveryHash (on-chain): ${result.deliveryHash}`);
      } else {
        console.error(`[Seller] markDelivered failed: ${result.error}`);
        console.error(`[Seller] Hint: ${result.hint}`);
      }
    } catch (e) {
      console.error(`[Seller] Unexpected error for escrow ${escrowId}:`, e.message);
    }
  });

  // Keep process alive
  process.on('SIGINT', () => {
    console.log('\n[Seller] Stopping listener.');
    process.exit(0);
  });
}

main().catch(e => {
  console.error('[Seller] Startup error:', e);
  process.exit(1);
});
