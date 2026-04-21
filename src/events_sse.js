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

let started = false;
function startIndexer() {
  if (started) return;
  started = true;
  try {
    const provider = new ethers.JsonRpcProvider(RPC);
    const contract = new ethers.Contract(ESCROW_ADDRESS, ABI, provider);

    contract.on('EscrowCreated', (id, buyer, seller, amount, deadline, uri, ev) => {
      const e = { type: 'EscrowCreated', id: id.toString(), buyer, seller,
        amount: fmtAmt(amount), deliveryDeadline: Number(deadline), verificationURI: uri,
        block: ev.log.blockNumber, tx: ev.log.transactionHash };
      partiesCache.set(String(id), { buyer, seller });
      fanOut(e);
    });

    contract.on('Delivered', async (id, hash, deadline, ev) => {
      const p = await resolveParties(id, contract);
      fanOut({ type: 'Delivered', id: id.toString(), deliveryHash: hash,
        reviewDeadline: Number(deadline), ...p,
        block: ev.log.blockNumber, tx: ev.log.transactionHash });
    });

    contract.on('Released', async (id, toSeller, fee, ev) => {
      const p = await resolveParties(id, contract);
      fanOut({ type: 'Released', id: id.toString(), toSeller: fmtAmt(toSeller),
        fee: fmtAmt(fee), ...p, block: ev.log.blockNumber, tx: ev.log.transactionHash });
    });

    contract.on('Disputed', async (id, by, reason, ev) => {
      const p = await resolveParties(id, contract);
      fanOut({ type: 'Disputed', id: id.toString(), by, reason, ...p,
        block: ev.log.blockNumber, tx: ev.log.transactionHash });
    });

    contract.on('Cancelled', async (id, ev) => {
      const p = await resolveParties(id, contract);
      fanOut({ type: 'Cancelled', id: id.toString(), ...p,
        block: ev.log.blockNumber, tx: ev.log.transactionHash });
    });

    contract.on('Resolved', async (id, toBuyer, toSeller, fee, verdictHash, ev) => {
      const p = await resolveParties(id, contract);
      fanOut({ type: 'Resolved', id: id.toString(), toBuyer: fmtAmt(toBuyer),
        toSeller: fmtAmt(toSeller), fee: fmtAmt(fee), verdictHash, ...p,
        block: ev.log.blockNumber, tx: ev.log.transactionHash });
    });

    console.log(`[events-sse] indexer started, contract=${ESCROW_ADDRESS} rpc=${RPC.split('?')[0]}`);
  } catch (err) {
    console.error('[events-sse] indexer failed to start:', err.message);
  }
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
