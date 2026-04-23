// Arbitova — SSE event stream for EscrowV1 events.
//
// Subscribes to the 6 contract events via ethers and fans them out to
// connected clients filtered by address (buyer or seller involvement).
//
// Client contract (GET /events?address=0x...):
//   - Content-Type: text/event-stream
//   - Each message: `data: {json}\n\n`
//   - Heartbeat every 25s to defeat idle-proxy timeouts
//
// This module is non-critical — if the RPC is unreachable, the indexer
// silently idles and /events still serves (empty stream). The canonical
// source of truth is always the chain itself.

const { ethers } = require('ethers');

const RPC = process.env.ARBITOVA_EVENT_RPC
  || process.env.ALCHEMY_BASE_SEPOLIA_RPC
  || 'https://sepolia.base.org';
const ESCROW_ADDRESS = process.env.ARBITOVA_ESCROW_ADDRESS
  || '0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC';
const USDC_DECIMALS = 6;

const ABI = [
  'event EscrowCreated(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, uint64 deliveryDeadline, string verificationURI)',
  'event Delivered(uint256 indexed id, bytes32 deliveryHash, uint64 reviewDeadline)',
  'event Released(uint256 indexed id, uint256 toSeller, uint256 fee)',
  'event Disputed(uint256 indexed id, address by, string reason)',
  'event Cancelled(uint256 indexed id)',
  'event Resolved(uint256 indexed id, uint256 toBuyer, uint256 toSeller, uint256 feePaid, bytes32 verdictHash)',
  'function getEscrow(uint256 id) view returns (tuple(address buyer, address seller, uint256 amount, uint64 deliveryDeadline, uint64 reviewDeadline, uint64 reviewWindowSec, uint8 state, bytes32 deliveryHash, string verificationURI))',
];

// Per-address set of active response streams.
const subscribers = new Map(); // addr(lowercase) -> Set<res>
// Ring buffer of recent events (for new subscribers who want backfill).
const RECENT_MAX = 200;
const recent = []; // newest-last

// Cache: escrowId -> { buyer, seller } so single-indexed events (Delivered, Released, etc.) can also be routed.
const partiesCache = new Map();

function pushRecent(ev) {
  recent.push(ev);
  while (recent.length > RECENT_MAX) recent.shift();
}

function fanOut(ev) {
  pushRecent(ev);
  const targets = new Set();
  if (ev.buyer) targets.add(ev.buyer.toLowerCase());
  if (ev.seller) targets.add(ev.seller.toLowerCase());
  for (const addr of targets) {
    const set = subscribers.get(addr);
    if (!set) continue;
    const payload = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of set) {
      try { res.write(payload); } catch {}
    }
  }
}

async function resolveParties(id, contract) {
  const key = String(id);
  if (partiesCache.has(key)) return partiesCache.get(key);
  try {
    const e = await contract.getEscrow(BigInt(id));
    const parties = { buyer: e.buyer, seller: e.seller };
    partiesCache.set(key, parties);
    return parties;
  } catch {
    return { buyer: null, seller: null };
  }
}

function fmtAmt(raw) {
  try { return ethers.formatUnits(raw, USDC_DECIMALS); } catch { return String(raw); }
}

// Stateless block-polling indexer: calls eth_getLogs with an explicit
// (fromBlock, toBlock) window instead of contract.on(), which uses
// server-side filters that public RPC endpoints recycle every few minutes
// (producing spammy "filter not found" errors). Polling is resilient to
// RPC failures — one bad poll doesn't kill the indexer, it just retries.
const POLL_INTERVAL_MS = 5000;
const MAX_BATCH_BLOCKS = 500;          // cap per getLogs call
const STARTUP_BACKFILL_BLOCKS = 100;   // replay last ~100 blocks on boot

async function dispatchEvent(parsed, log, contract) {
  const { name, args } = parsed;
  const meta = { block: log.blockNumber, tx: log.transactionHash };
  switch (name) {
    case 'EscrowCreated': {
      const [id, buyer, seller, amount, deadline, uri] = args;
      partiesCache.set(String(id), { buyer, seller });
      fanOut({ type: 'EscrowCreated', id: id.toString(), buyer, seller,
        amount: fmtAmt(amount), deliveryDeadline: Number(deadline),
        verificationURI: uri, ...meta });
      break;
    }
    case 'Delivered': {
      const [id, hash, deadline] = args;
      const p = await resolveParties(id, contract);
      fanOut({ type: 'Delivered', id: id.toString(), deliveryHash: hash,
        reviewDeadline: Number(deadline), ...p, ...meta });
      break;
    }
    case 'Released': {
      const [id, toSeller, fee] = args;
      const p = await resolveParties(id, contract);
      fanOut({ type: 'Released', id: id.toString(),
        toSeller: fmtAmt(toSeller), fee: fmtAmt(fee), ...p, ...meta });
      break;
    }
    case 'Disputed': {
      const [id, by, reason] = args;
      const p = await resolveParties(id, contract);
      fanOut({ type: 'Disputed', id: id.toString(), by, reason, ...p, ...meta });
      break;
    }
    case 'Cancelled': {
      const [id] = args;
      const p = await resolveParties(id, contract);
      fanOut({ type: 'Cancelled', id: id.toString(), ...p, ...meta });
      break;
    }
    case 'Resolved': {
      const [id, toBuyer, toSeller, fee, verdictHash] = args;
      const p = await resolveParties(id, contract);
      fanOut({ type: 'Resolved', id: id.toString(),
        toBuyer: fmtAmt(toBuyer), toSeller: fmtAmt(toSeller),
        fee: fmtAmt(fee), verdictHash, ...p, ...meta });
      break;
    }
  }
}

let started = false;
function startIndexer() {
  if (started) return;
  started = true;

  let provider, contract;
  try {
    provider = new ethers.JsonRpcProvider(RPC);
    contract = new ethers.Contract(ESCROW_ADDRESS, ABI, provider);
  } catch (err) {
    console.error('[events-sse] provider init failed:', err.message);
    started = false;
    return;
  }

  let lastProcessed = null;
  let errStreak = 0;

  async function poll() {
    try {
      const current = await provider.getBlockNumber();
      if (lastProcessed === null) {
        lastProcessed = Math.max(0, current - STARTUP_BACKFILL_BLOCKS);
        console.log(`[events-sse] indexer started, contract=${ESCROW_ADDRESS} rpc=${RPC.split('?')[0]} fromBlock=${lastProcessed}`);
      }
      if (current <= lastProcessed) { errStreak = 0; return; }

      const fromBlock = lastProcessed + 1;
      const toBlock = Math.min(current, lastProcessed + MAX_BATCH_BLOCKS);

      const logs = await provider.getLogs({
        address: ESCROW_ADDRESS, fromBlock, toBlock,
      });

      for (const log of logs) {
        try {
          const parsed = contract.interface.parseLog(log);
          if (parsed) await dispatchEvent(parsed, log, contract);
        } catch { /* skip malformed / unknown-topic log */ }
      }

      lastProcessed = toBlock;
      errStreak = 0;
    } catch (err) {
      errStreak++;
      // Log first failure + every 12th (~1 min of errors at 5s poll) to avoid spam.
      if (errStreak === 1 || errStreak % 12 === 0) {
        console.warn(`[events-sse] poll failed (${errStreak}x): ${err.message}`);
      }
    }
  }

  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

function sseHandler(req, res) {
  const addr = String(req.query.address || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) {
    return res.status(400).json({ error: 'address query param required (0x...40 hex)' });
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // defeat nginx buffering
  });
  res.flushHeaders?.();

  // Hello
  res.write(`: connected to arbitova events for ${addr}\n\n`);

  // Backfill from recent ring buffer (no persistence — best effort)
  const backfill = recent.filter((e) =>
    (e.buyer && e.buyer.toLowerCase() === addr) ||
    (e.seller && e.seller.toLowerCase() === addr));
  for (const e of backfill) {
    try { res.write(`data: ${JSON.stringify({ ...e, _backfill: true })}\n\n`); } catch {}
  }

  // Register
  if (!subscribers.has(addr)) subscribers.set(addr, new Set());
  subscribers.get(addr).add(res);

  // Heartbeat
  const hb = setInterval(() => {
    try { res.write(': hb\n\n'); } catch {}
  }, 25_000);

  const cleanup = () => {
    clearInterval(hb);
    const set = subscribers.get(addr);
    if (set) { set.delete(res); if (set.size === 0) subscribers.delete(addr); }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);

  startIndexer();
}

module.exports = { sseHandler, startIndexer };
