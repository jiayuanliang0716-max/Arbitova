// Arbitova — Demo Seller Bot.
//
// Listens for EscrowCreated events targeting DEMO_SELLER_ADDR and
// automatically calls markDelivered after a short random delay, so a
// user with one wallet can test the full flow end-to-end without needing
// a real counterparty.
//
// Enabled only when DEMO_SELLER_ENABLED=1 AND DEMO_SELLER_PK is set —
// both guards are required so prod never auto-delivers by accident.
//
// Guardrails:
//   - Only responds if seller === DEMO_SELLER_ADDR (case-insensitive)
//   - Only responds if amount <= DEMO_MAX_USDC (default 10 USDC)
//   - Per-buyer rate limit: <= 3 escrows / hour (in-memory, resets on boot)
//   - Random jitter 30–90s before delivering (feels like a real seller)
//   - Idempotent: tracks handled escrow ids in-memory; never deliver twice

const { ethers } = require('ethers');

const ENABLED = process.env.DEMO_SELLER_ENABLED === '1';
const PK = process.env.DEMO_SELLER_PK;
const ADDR = (process.env.DEMO_SELLER_ADDR || '').toLowerCase();
const MAX_USDC = Number(process.env.DEMO_MAX_USDC || '10');
const RPC = process.env.ARBITOVA_EVENT_RPC
  || process.env.ALCHEMY_BASE_SEPOLIA_RPC
  || 'https://sepolia.base.org';
const ESCROW_ADDRESS = process.env.ARBITOVA_ESCROW_ADDRESS
  || '0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC';

const USDC_DECIMALS = 6;

const ABI = [
  'event EscrowCreated(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, uint64 deliveryDeadline, string verificationURI)',
  'function markDelivered(uint256 id, bytes32 deliveryHash)',
  'function getEscrow(uint256 id) view returns (tuple(address buyer, address seller, uint256 amount, uint64 deliveryDeadline, uint64 reviewDeadline, uint64 reviewWindowSec, uint8 state, bytes32 deliveryHash, string verificationURI))',
];

// Per-buyer rate limit: addr(lower) -> [timestampsMs...]
const buyerHits = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_MAX = 3;

// Handled escrow ids (string) — never process same id twice
const handled = new Set();

function ratePeek(buyerLower) {
  const now = Date.now();
  const arr = (buyerHits.get(buyerLower) || []).filter((t) => now - t < RATE_WINDOW_MS);
  buyerHits.set(buyerLower, arr);
  return arr.length;
}

function rateBump(buyerLower) {
  const now = Date.now();
  const arr = buyerHits.get(buyerLower) || [];
  arr.push(now);
  buyerHits.set(buyerLower, arr);
}

function jitterMs() {
  // 30–90s
  return 30_000 + Math.floor(Math.random() * 60_000);
}

function fmtAmt(raw) {
  try { return ethers.formatUnits(raw, USDC_DECIMALS); } catch { return String(raw); }
}

let started = false;
function startDemoSellerBot() {
  if (started) return;
  if (!ENABLED) {
    console.log('[demo-seller] disabled (set DEMO_SELLER_ENABLED=1 to enable)');
    return;
  }
  if (!PK || !ADDR) {
    console.log('[demo-seller] missing DEMO_SELLER_PK or DEMO_SELLER_ADDR — bot not started');
    return;
  }
  started = true;

  try {
    const provider = new ethers.JsonRpcProvider(RPC);
    const signer = new ethers.Wallet(PK, provider);
    const contract = new ethers.Contract(ESCROW_ADDRESS, ABI, signer);

    const signerAddr = signer.address.toLowerCase();
    if (signerAddr !== ADDR) {
      console.error(`[demo-seller] ABORT: DEMO_SELLER_PK (${signerAddr}) does not match DEMO_SELLER_ADDR (${ADDR})`);
      started = false;
      return;
    }

    console.log(`[demo-seller] started — listening for escrows to ${ADDR} up to ${MAX_USDC} USDC on ${ESCROW_ADDRESS}`);

    contract.on('EscrowCreated', async (id, buyer, seller, amount, _deadline, _uri, _ev) => {
      try {
        const idStr = id.toString();
        const sellerLower = String(seller).toLowerCase();
        const buyerLower = String(buyer).toLowerCase();

        if (sellerLower !== ADDR) return;
        if (handled.has(idStr)) return;

        const amtHuman = Number(fmtAmt(amount));
        if (!(amtHuman > 0) || amtHuman > MAX_USDC) {
          console.log(`[demo-seller] skip #${idStr}: amount ${amtHuman} outside [0, ${MAX_USDC}]`);
          return;
        }

        const hits = ratePeek(buyerLower);
        if (hits >= RATE_MAX) {
          console.log(`[demo-seller] rate-limit #${idStr}: buyer ${buyerLower} has ${hits} in last hour`);
          return;
        }

        handled.add(idStr);
        rateBump(buyerLower);

        const delay = jitterMs();
        console.log(`[demo-seller] escrow #${idStr} (${amtHuman} USDC from ${buyerLower}) — delivering in ${Math.round(delay / 1000)}s`);

        setTimeout(async () => {
          try {
            // Re-check state: only deliver if still CREATED (state 0)
            const e = await contract.getEscrow(BigInt(idStr));
            if (Number(e.state) !== 0) {
              console.log(`[demo-seller] skip #${idStr}: state=${e.state} (not CREATED)`);
              return;
            }
            const uri = `demo://echo/${idStr}`;
            const hash = ethers.keccak256(ethers.toUtf8Bytes(uri));
            const tx = await contract.markDelivered(BigInt(idStr), hash, { gasLimit: 150000n });
            const r = await tx.wait();
            console.log(`[demo-seller] delivered #${idStr} uri=${uri} tx=${r.hash}`);
          } catch (err) {
            handled.delete(idStr);
            console.error(`[demo-seller] deliver failed #${idStr}:`, err.message);
          }
        }, delay);
      } catch (err) {
        console.error('[demo-seller] handler error:', err.message);
      }
    });
  } catch (err) {
    console.error('[demo-seller] failed to start:', err.message);
    started = false;
  }
}

module.exports = { startDemoSellerBot };
