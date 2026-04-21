#!/usr/bin/env node
'use strict';
/**
 * src/path_b/indexer.js
 *
 * Polls EscrowV1 events from Base (or Base Sepolia) and writes to the local DB.
 * Intended to run as a separate process; NOT imported by the Path A Express app.
 *
 * Env vars (from src/path_b/.env or process.env):
 *   BASE_RPC_URL        — e.g. https://mainnet.base.org
 *   ESCROW_V1_ADDRESS   — deployed contract address
 *   CHAIN_ID            — 8453 (mainnet) or 84532 (sepolia)
 *   START_BLOCK         — block to start indexing from (first deploy block)
 */

const path = require('path');
// Load path_b-specific env without polluting Path A
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { ethers } = require('ethers');
const db = require('./db');
const notify = require('./notify');

// ---------------------------------------------------------------------------
// ABI — only the event fragments we need
// ---------------------------------------------------------------------------
const ESCROW_ABI = [
  'event EscrowCreated(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, uint64 deliveryDeadline, string verificationURI)',
  'event Delivered(uint256 indexed id, bytes32 deliveryHash, uint64 reviewDeadline)',
  'event Released(uint256 indexed id, uint256 toSeller, uint256 fee)',
  'event Disputed(uint256 indexed id, address indexed by, string reason)',
  'event Escalated(uint256 indexed id)',
  'event Resolved(uint256 indexed id, uint256 toBuyer, uint256 toSeller, uint256 fee, bytes32 verdictHash)',
  'event Cancelled(uint256 indexed id)',
  'event ArbiterChanged(address oldArbiter, address newArbiter)',
  'event FeeRecipientChanged(address oldRecipient, address newRecipient)',
  'event ReleaseFeeChanged(uint16 oldBps, uint16 newBps)',
  'event ResolveFeeChanged(uint16 oldBps, uint16 newBps)',
];

const BATCH_SIZE = 1000; // blocks per fetch
const POLL_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;

let _running = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withBackoff(fn, label) {
  let delay = 2000;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      console.error(`[indexer] ${label} error: ${err.message} — retry in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Event → DB mapping
// ---------------------------------------------------------------------------
function tsFromSeconds(sec) {
  return new Date(Number(sec) * 1000).toISOString();
}

async function processLog(contract, log, iface) {
  const parsed = iface.parseLog({ topics: log.topics, data: log.data });
  if (!parsed) return;

  const name = parsed.name;
  const args = parsed.args;
  const escrowIdRaw = args[0]; // first arg is always `id` for escrow events
  const escrowId = typeof escrowIdRaw === 'bigint' ? Number(escrowIdRaw) : null;

  // Insert raw event (idempotent — UNIQUE constraint on tx_hash+log_index)
  await db.insertEvent({
    escrow_id: escrowId ?? 0,
    event_name: name,
    block_number: Number(log.blockNumber),
    tx_hash: log.transactionHash,
    log_index: log.index ?? log.logIndex ?? 0,
    payload: {
      args: Object.fromEntries(
        Object.keys(args).filter((k) => isNaN(k)).map((k) => [k, String(args[k])])
      ),
      blockNumber: Number(log.blockNumber),
    },
  });

  // Config-only events (no escrow row to update)
  if (['ArbiterChanged','FeeRecipientChanged','ReleaseFeeChanged','ResolveFeeChanged'].includes(name)) {
    console.log(`[indexer] config event ${name} at block ${log.blockNumber}`);
    return;
  }

  // Map event → escrow state mutation
  switch (name) {
    case 'EscrowCreated': {
      await db.upsertEscrow({
        escrow_id: Number(args.id),
        tx_hash: log.transactionHash,
        buyer_address: args.buyer,
        seller_address: args.seller,
        amount: args.amount.toString(),
        delivery_deadline: tsFromSeconds(args.deliveryDeadline),
        review_deadline: null,
        state: 'CREATED',
        verification_uri: args.verificationURI,
      });
      break;
    }
    case 'Delivered': {
      await db.updateEscrowState(Number(args.id), {
        state: 'DELIVERED',
        delivery_hash: args.deliveryHash,
        review_deadline: tsFromSeconds(args.reviewDeadline),
      });
      break;
    }
    case 'Released': {
      await db.updateEscrowState(Number(args.id), { state: 'RELEASED' });
      break;
    }
    case 'Disputed': {
      await db.updateEscrowState(Number(args.id), { state: 'DISPUTED' });
      break;
    }
    case 'Escalated': {
      await db.updateEscrowState(Number(args.id), { state: 'DISPUTED' });
      break;
    }
    case 'Resolved': {
      await db.updateEscrowState(Number(args.id), {
        state: 'RESOLVED',
        verdict_hash: args.verdictHash,
      });
      break;
    }
    case 'Cancelled': {
      await db.updateEscrowState(Number(args.id), { state: 'CANCELLED' });
      break;
    }
  }

  console.log(`[indexer] processed ${name} escrow=${escrowId} block=${log.blockNumber}`);

  // Fire notifications asynchronously — do not block the indexer loop
  const escrow = escrowId ? await db.getEscrow(escrowId) : null;
  if (escrow) {
    notify.handleEvent(name, escrow, args).catch((e) =>
      console.error('[indexer] notify error:', e.message)
    );
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function runIndexer() {
  const rpcUrl = process.env.BASE_RPC_URL;
  const contractAddress = process.env.ESCROW_V1_ADDRESS;
  const chainId = parseInt(process.env.CHAIN_ID || '8453', 10);
  const startBlock = parseInt(process.env.START_BLOCK || '0', 10);

  if (!rpcUrl || !contractAddress) {
    throw new Error('BASE_RPC_URL and ESCROW_V1_ADDRESS must be set');
  }

  await db.ensureSchema();

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const iface = new ethers.Interface(ESCROW_ABI);
  const contract = new ethers.Contract(contractAddress, ESCROW_ABI, provider);

  console.log(`[indexer] starting — chain=${chainId} contract=${contractAddress}`);
  _running = true;

  while (_running) {
    await withBackoff(async () => {
      const cursor = await db.getCursor(chainId);
      const fromBlock = cursor ? Number(cursor.last_block) + 1 : startBlock;

      const latestBlock = await provider.getBlockNumber();
      if (fromBlock > latestBlock) {
        await sleep(POLL_INTERVAL_MS);
        return;
      }

      const toBlock = Math.min(fromBlock + BATCH_SIZE - 1, latestBlock);

      console.log(`[indexer] fetching blocks ${fromBlock}–${toBlock}`);
      const logs = await contract.queryFilter('*', fromBlock, toBlock);

      for (const log of logs) {
        await processLog(contract, log, iface);
      }

      await db.setCursor(chainId, contractAddress, toBlock);
      console.log(`[indexer] cursor advanced to ${toBlock}`);
    }, 'poll');

    await sleep(POLL_INTERVAL_MS);
  }
}

function stopIndexer() {
  _running = false;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
if (require.main === module) {
  runIndexer().catch((err) => {
    console.error('[indexer] fatal:', err);
    process.exit(1);
  });

  process.on('SIGINT', () => { stopIndexer(); process.exit(0); });
  process.on('SIGTERM', () => { stopIndexer(); process.exit(0); });
}

module.exports = { runIndexer, stopIndexer };
