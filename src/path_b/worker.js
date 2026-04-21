'use strict';
/**
 * src/path_b/worker.js
 *
 * Auto-escalate worker: every 5 minutes, scan for DELIVERED escrows whose
 * review_deadline has passed and call escalateIfExpired(escrowId) on-chain.
 *
 * Env vars:
 *   BASE_RPC_URL        — JSON-RPC endpoint
 *   ESCROW_V1_ADDRESS   — deployed EscrowV1 address
 *   CHAIN_ID            — 8453 or 84532
 *   PATH_B_SIGNER_KEY   — private key of the platform signer
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { ethers } = require('ethers');
const db = require('./db');

const POLL_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes

const ESCROW_ABI = [
  'function escalateIfExpired(uint256 id) external',
];

// Custom errors the contract may revert with if already escalated / wrong state
const ALREADY_HANDLED_PATTERNS = [
  /WrongState/i,
  /already/i,
  /execution reverted/i,
];

function isAlreadyHandledRevert(err) {
  const msg = err.message || '';
  return ALREADY_HANDLED_PATTERNS.some((re) => re.test(msg));
}

async function runOnce(contract) {
  const expired = await db.getExpiredDeliveredEscrows();
  if (!expired.length) {
    console.log('[worker] no expired DELIVERED escrows');
    return;
  }

  console.log(`[worker] found ${expired.length} expired DELIVERED escrow(s)`);
  for (const escrow of expired) {
    try {
      console.log(`[worker] escalating escrow #${escrow.escrow_id}`);
      const tx = await contract.escalateIfExpired(escrow.escrow_id);
      console.log(`[worker] tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`[worker] escalated escrow #${escrow.escrow_id} in block ${receipt.blockNumber}`);
    } catch (err) {
      if (isAlreadyHandledRevert(err)) {
        console.log(`[worker] escrow #${escrow.escrow_id} already escalated — marking ok`);
        // Update local state so we don't attempt again
        await db.updateEscrowState(escrow.escrow_id, { state: 'DISPUTED' });
      } else {
        console.error(`[worker] failed to escalate escrow #${escrow.escrow_id}:`, err.message);
      }
    }
  }
}

let _timer = null;

async function runWorker() {
  const rpcUrl = process.env.BASE_RPC_URL;
  const contractAddress = process.env.ESCROW_V1_ADDRESS;
  const chainId = parseInt(process.env.CHAIN_ID || '8453', 10);
  const signerKey = process.env.PATH_B_SIGNER_KEY;

  if (!rpcUrl || !contractAddress || !signerKey) {
    throw new Error('BASE_RPC_URL, ESCROW_V1_ADDRESS, and PATH_B_SIGNER_KEY must be set');
  }

  await db.ensureSchema();

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const signer = new ethers.Wallet(signerKey, provider);
  const contract = new ethers.Contract(contractAddress, ESCROW_ABI, signer);

  console.log(`[worker] starting — signer=${signer.address}`);

  const tick = async () => {
    try {
      await runOnce(contract);
    } catch (err) {
      console.error('[worker] tick error:', err.message);
    }
    _timer = setTimeout(tick, POLL_INTERVAL_MS);
  };

  await tick();
}

function stopWorker() {
  if (_timer) clearTimeout(_timer);
  _timer = null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  runWorker().catch((err) => {
    console.error('[worker] fatal:', err);
    process.exit(1);
  });
  process.on('SIGINT', () => { stopWorker(); process.exit(0); });
  process.on('SIGTERM', () => { stopWorker(); process.exit(0); });
}

module.exports = { runWorker, stopWorker, runOnce };
