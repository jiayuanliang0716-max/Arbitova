// @arbitova/x402-adapter — wrap x402 with EscrowV1
//
// Design: the adapter wraps a fetch-like function. When a server
// returns 402 with an `X-Arbitova-Escrow: <address>@<chain>` header,
// the adapter opens an escrow on that contract instead of sending a
// direct transfer. If the header is absent, it falls through to the
// underlying x402 handler (user-provided) or returns the 402 as-is.
//
// Non-goals:
//   - Holding keys. Signer is caller-supplied.
//   - Parsing x402 price fields that aren't USDC on the configured
//     chain. Mismatches throw so callers don't silently lose money.
//   - Auto-confirmation. Callers must explicitly confirm or dispute
//     via the returned handle.

import { ethers } from 'ethers';
import { ESCROW_ABI, ERC20_ABI, STATES } from '@arbitova/sdk/constants';

export const ESCROW_HEADER = 'x-arbitova-escrow';
export const DELIVERY_WINDOW_HEADER = 'x-arbitova-delivery-window';
export const X402_PRICE_HEADER = 'x-402-price';
export const X402_TO_HEADER = 'x-402-to';

const DEFAULT_REVIEW_WINDOW = 86400; // 24h
const DEFAULT_DELIVERY_WINDOW = 86400;

/**
 * Wrap a fetch-like function with Arbitova escrow on 402 responses.
 *
 * @param {Function} baseFetch - fetch-like(url, init) returning Response.
 * @param {object}   opts
 * @param {ethers.Signer}   opts.signer           - Signer for buyer.
 * @param {ethers.Contract} [opts.usdc]           - Pre-bound USDC contract.
 * @param {string}          [opts.usdcAddress]    - Or address; contract is built.
 * @param {ethers.Contract} [opts.escrow]         - Pre-bound EscrowV1 contract.
 * @param {string}          [opts.escrowAddress]  - Or address; contract is built.
 * @param {number} [opts.defaultReviewWindow]     - seconds.
 * @param {number} [opts.defaultDeliveryWindow]   - seconds.
 * @param {Function} [opts.verificationUri]       - (request) => string; default: keccak-ish placeholder.
 * @param {Function} [opts.onEscrowCreated]       - ({id, txHash, seller, amount}) => void.
 * @returns {Function & { confirmLast, disputeLast, lastEscrowId }}
 */
export function withEscrow(baseFetch, opts) {
  if (typeof baseFetch !== 'function') {
    throw new TypeError('withEscrow: baseFetch must be a function');
  }
  if (!opts || !opts.signer) {
    throw new TypeError('withEscrow: opts.signer is required');
  }

  const signer = opts.signer;
  const usdc =
    opts.usdc ||
    (opts.usdcAddress
      ? new ethers.Contract(opts.usdcAddress, ERC20_ABI, signer)
      : null);
  const escrow =
    opts.escrow ||
    (opts.escrowAddress
      ? new ethers.Contract(opts.escrowAddress, ESCROW_ABI, signer)
      : null);

  const reviewWindow = BigInt(opts.defaultReviewWindow ?? DEFAULT_REVIEW_WINDOW);
  const deliveryWindowDefault = BigInt(opts.defaultDeliveryWindow ?? DEFAULT_DELIVERY_WINDOW);
  const verificationUri = opts.verificationUri ?? defaultVerificationUri;
  const onEscrowCreated = opts.onEscrowCreated;

  let lastEscrowId = null;

  async function wrapped(url, init) {
    const first = await baseFetch(url, init);

    if (first.status !== 402) return first;

    const escrowHeader = first.headers.get(ESCROW_HEADER);
    if (!escrowHeader) {
      // No opt-in — caller gets the raw 402 and can handle x402 normally.
      return first;
    }

    if (!escrow || !usdc) {
      throw new Error(
        'withEscrow: server requested escrow but adapter was not given usdc/escrow contracts'
      );
    }

    const parsed = parseEscrowHeader(escrowHeader);
    assertEscrowMatches(parsed, escrow);

    const price = parsePrice(first.headers.get(X402_PRICE_HEADER));
    const seller = requireAddress(first.headers.get(X402_TO_HEADER), 'x-402-to');
    const deliveryWindow = parseDeliveryWindow(
      first.headers.get(DELIVERY_WINDOW_HEADER),
      deliveryWindowDefault
    );
    const verifURI = await Promise.resolve(verificationUri({ url, init }));

    // Approve + create escrow. Both happen with the caller's signer.
    const approveTx = await usdc.approve(escrow.target, price);
    await approveTx.wait();

    const createTx = await escrow.createEscrow(
      seller,
      price,
      deliveryWindow,
      reviewWindow,
      verifURI
    );
    const receipt = await createTx.wait();
    const id = extractEscrowIdFromReceipt(receipt, escrow);

    lastEscrowId = id;
    if (typeof onEscrowCreated === 'function') {
      onEscrowCreated({ id, txHash: receipt.hash, seller, amount: price });
    }

    // Second call: re-request with escrow reference header so the seller
    // sees the buyer has locked funds and can return the real response.
    const retryInit = addEscrowRefHeader(init, { id, contract: escrow.target });
    return baseFetch(url, retryInit);
  }

  wrapped.confirmLast = async function confirmLast(id = lastEscrowId) {
    if (id == null) throw new Error('confirmLast: no escrow id known');
    const tx = await escrow.confirmDelivery(id);
    return tx.wait();
  };

  wrapped.disputeLast = async function disputeLast({ reason, id = lastEscrowId } = {}) {
    if (id == null) throw new Error('disputeLast: no escrow id known');
    if (typeof reason !== 'string' || !reason.length) {
      throw new Error('disputeLast: reason (string) is required');
    }
    const tx = await escrow.dispute(id, reason);
    return tx.wait();
  };

  Object.defineProperty(wrapped, 'lastEscrowId', {
    get: () => lastEscrowId,
  });

  return wrapped;
}

/** @internal */
export function parseEscrowHeader(raw) {
  // Format: "<address>@<chainId>"
  const m = /^(0x[a-fA-F0-9]{40})@(\d+)$/.exec(raw.trim());
  if (!m) {
    throw new Error(`Invalid ${ESCROW_HEADER} header: ${raw}`);
  }
  return { address: ethers.getAddress(m[1]), chainId: Number(m[2]) };
}

function assertEscrowMatches(parsed, escrow) {
  const targetAddr = ethers.getAddress(escrow.target);
  if (parsed.address !== targetAddr) {
    throw new Error(
      `Escrow contract mismatch: server advertised ${parsed.address}, adapter configured for ${targetAddr}`
    );
  }
}

function parsePrice(raw) {
  if (!raw) throw new Error(`Missing ${X402_PRICE_HEADER} header on 402 response`);
  // Accept: "0.10 USDC" or "100000"  (raw base units)
  const trimmed = raw.trim();
  const sep = trimmed.indexOf(' ');
  if (sep === -1) {
    // Raw base units.
    return BigInt(trimmed);
  }
  const amountStr = trimmed.slice(0, sep);
  const symbol = trimmed.slice(sep + 1).trim().toUpperCase();
  if (symbol !== 'USDC' && symbol !== 'MUSDC') {
    throw new Error(`withEscrow: unsupported price currency ${symbol}`);
  }
  // USDC has 6 decimals.
  return ethers.parseUnits(amountStr, 6);
}

function parseDeliveryWindow(raw, fallback) {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${DELIVERY_WINDOW_HEADER} header: ${raw}`);
  }
  return BigInt(Math.floor(n));
}

function requireAddress(raw, name) {
  if (!raw) throw new Error(`Missing ${name} header on 402 response`);
  return ethers.getAddress(raw.trim());
}

function defaultVerificationUri({ url }) {
  // Deterministic placeholder the seller can recompute to match.
  return `x402:${url}`;
}

function addEscrowRefHeader(init, { id, contract }) {
  const headers = new Headers(init?.headers || {});
  headers.set('x-arbitova-escrow-ref', `${contract}:${id.toString()}`);
  return { ...(init || {}), headers };
}

function extractEscrowIdFromReceipt(receipt, escrowContract) {
  const iface = escrowContract.interface;
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === 'EscrowCreated') {
        return parsed.args.id;
      }
    } catch {
      // Not our event — ignore.
    }
  }
  throw new Error('withEscrow: EscrowCreated event not found in receipt');
}

export { STATES };
