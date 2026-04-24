'use strict';
/**
 * src/user_accumulation/chainIndexer.js
 *
 * Lightweight in-process EscrowV1 event poller. Unlike src/path_b/indexer.js
 * (which requires a paid Render worker), this runs inside the existing web
 * service on a setInterval. Scope is intentionally narrow: it emits wallet-
 * scoped rows into user_events/user_entities for the signal-heavy events
 * (EscrowCreated buyer+seller, Disputed disputer) — nothing else. Escrow
 * state mutation is still the path_b indexer's job.
 *
 * Env vars (all optional — indexer no-ops if any required one is missing):
 *   USER_ACCUM_CHAIN_INDEXER=1       — feature flag (required)
 *   BASE_RPC_URL=https://sepolia.base.org
 *   ESCROW_V1_ADDRESS=0x...
 *   INDEXER_CHAIN_ID=84532
 *   INDEXER_START_BLOCK=0            — ignored once a cursor row exists
 *   INDEXER_POLL_MINUTES=5
 *   INDEXER_BATCH_BLOCKS=1000
 */

const { ethers } = require('ethers');
const { dbGet, dbRun, p } = require('../db/helpers');
const db = require('../db/schema');
const accumDb = require('./db');

const isPg = () => db.type === 'pg';

const ESCROW_ABI = [
  'event EscrowCreated(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, uint64 deliveryDeadline, string verificationURI)',
  'event Disputed(uint256 indexed id, address indexed by, string reason)',
];

let _running = false;
let _intervalHandle = null;

function nowIso() {
  return new Date().toISOString();
}

async function getCursor(chainId) {
  return dbGet(
    `SELECT * FROM user_accum_chain_cursor WHERE chain_id = ${p(1)}`,
    [chainId]
  );
}

async function setCursor(chainId, contractAddress, lastBlock) {
  if (isPg()) {
    await dbRun(
      `INSERT INTO user_accum_chain_cursor (chain_id, contract_address, last_block, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (chain_id) DO UPDATE SET last_block = $3, updated_at = $4`,
      [chainId, contractAddress, lastBlock, nowIso()]
    );
  } else {
    await dbRun(
      `INSERT OR REPLACE INTO user_accum_chain_cursor (chain_id, contract_address, last_block, updated_at)
       VALUES (?,?,?,?)`,
      [chainId, contractAddress, lastBlock, nowIso()]
    );
  }
}

function eventTypeFor(chainId, eventName) {
  const isMainnet = chainId === 8453;
  if (eventName === 'EscrowCreated') {
    return isMainnet ? 'escrow_create_mainnet' : 'escrow_create_sepolia';
  }
  if (eventName === 'Disputed') {
    return isMainnet ? 'escrow_disputed_mainnet' : 'escrow_disputed_sepolia';
  }
  return null;
}

// Explicit heat overrides for event_types that are not in HEAT_POINTS.
// EscrowCreated already maps to escrow_create_sepolia / _mainnet in db.HEAT_POINTS,
// but Disputed does not — give it mainnet=150, sepolia=25 (disputes are a strong
// engagement signal but not definitive that the disputer is a real user).
function heatPointsFor(chainId, eventName) {
  const isMainnet = chainId === 8453;
  if (eventName === 'Disputed') return isMainnet ? 150 : 25;
  return undefined; // fall through to HEAT_POINTS table
}

async function handleEscrowCreated(log, iface, chainId) {
  const parsed = iface.parseLog({ topics: log.topics, data: log.data });
  if (!parsed) return 0;
  const escrowId = Number(parsed.args.id);
  const buyer = String(parsed.args.buyer).toLowerCase();
  const seller = String(parsed.args.seller).toLowerCase();
  const event_type = eventTypeFor(chainId, 'EscrowCreated');
  let written = 0;

  for (const role of [{ addr: buyer, label: 'buyer' }, { addr: seller, label: 'seller' }]) {
    if (!/^0x[0-9a-f]{40}$/.test(role.addr)) continue;
    const evt = {
      event_type,
      wallet: role.addr,
      path: null,
      metadata: {
        chain_id: chainId,
        escrow_id: escrowId,
        role: role.label,
        tx_hash: log.transactionHash,
        block_number: Number(log.blockNumber),
        source: 'chain_indexer',
      },
    };
    const heat = await accumDb.insertEvent(evt);
    await accumDb.resolveAndUpsertEntity(evt, heat);
    written += 1;
  }
  return written;
}

async function handleDisputed(log, iface, chainId) {
  const parsed = iface.parseLog({ topics: log.topics, data: log.data });
  if (!parsed) return 0;
  const escrowId = Number(parsed.args.id);
  const by = String(parsed.args.by).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(by)) return 0;
  const evt = {
    event_type: eventTypeFor(chainId, 'Disputed'),
    wallet: by,
    path: null,
    heat_points: heatPointsFor(chainId, 'Disputed'),
    metadata: {
      chain_id: chainId,
      escrow_id: escrowId,
      reason: String(parsed.args.reason || '').slice(0, 500),
      tx_hash: log.transactionHash,
      block_number: Number(log.blockNumber),
      source: 'chain_indexer',
    },
  };
  const heat = await accumDb.insertEvent(evt);
  await accumDb.resolveAndUpsertEntity(evt, heat);
  return 1;
}

async function runOnce() {
  const rpcUrl = process.env.BASE_RPC_URL;
  const contractAddress = process.env.ESCROW_V1_ADDRESS;
  const chainId = parseInt(process.env.INDEXER_CHAIN_ID || '84532', 10);
  const startBlockEnv = process.env.INDEXER_START_BLOCK;
  const batchBlocks = parseInt(process.env.INDEXER_BATCH_BLOCKS || '1000', 10);

  if (!rpcUrl || !contractAddress) {
    return { skipped: 'missing BASE_RPC_URL or ESCROW_V1_ADDRESS' };
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const iface = new ethers.Interface(ESCROW_ABI);
  const contract = new ethers.Contract(contractAddress, ESCROW_ABI, provider);

  const latestBlock = await provider.getBlockNumber();
  const cursor = await getCursor(chainId);

  let fromBlock;
  if (cursor) {
    fromBlock = Number(cursor.last_block) + 1;
  } else if (startBlockEnv) {
    fromBlock = parseInt(startBlockEnv, 10);
  } else {
    // No cursor, no env — don't scan the whole chain. Start ~100k blocks back
    // (≈2 days on Base). If the contract's real deploy is older, set
    // INDEXER_START_BLOCK explicitly to catch earlier activity.
    fromBlock = Math.max(0, latestBlock - 100_000);
  }

  if (fromBlock > latestBlock) {
    return { chainId, fromBlock, latestBlock, processed: 0, note: 'up to date' };
  }

  // Process one batch per call — keeps any single run bounded.
  const toBlock = Math.min(fromBlock + batchBlocks - 1, latestBlock);

  const createdLogs = await contract.queryFilter('EscrowCreated', fromBlock, toBlock);
  const disputedLogs = await contract.queryFilter('Disputed', fromBlock, toBlock);

  let walletsWritten = 0;
  for (const log of createdLogs) {
    try {
      walletsWritten += await handleEscrowCreated(log, iface, chainId);
    } catch (e) {
      console.error('[chainIndexer] handleEscrowCreated error:', e.message);
    }
  }
  for (const log of disputedLogs) {
    try {
      walletsWritten += await handleDisputed(log, iface, chainId);
    } catch (e) {
      console.error('[chainIndexer] handleDisputed error:', e.message);
    }
  }

  await setCursor(chainId, contractAddress, toBlock);

  return {
    chainId,
    fromBlock,
    toBlock,
    latestBlock,
    createdLogs: createdLogs.length,
    disputedLogs: disputedLogs.length,
    walletsWritten,
  };
}

function start() {
  if (process.env.USER_ACCUM_CHAIN_INDEXER !== '1') {
    console.log('[chainIndexer] disabled (set USER_ACCUM_CHAIN_INDEXER=1 to enable)');
    return;
  }
  if (_intervalHandle) return;
  _running = true;

  const pollMinutes = Math.max(1, parseInt(process.env.INDEXER_POLL_MINUTES || '5', 10));
  const intervalMs = pollMinutes * 60 * 1000;

  const tick = async () => {
    if (!_running) return;
    try {
      const result = await runOnce();
      console.log('[chainIndexer]', JSON.stringify(result));
    } catch (e) {
      console.error('[chainIndexer] tick error:', e.message);
    }
  };

  // Fire once on boot so catch-up starts immediately, then schedule.
  setTimeout(tick, 5_000);
  _intervalHandle = setInterval(tick, intervalMs);
  console.log(`[chainIndexer] started — polling every ${pollMinutes}min`);
}

function stop() {
  _running = false;
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

module.exports = { start, stop, runOnce, getCursor, setCursor };
