// Unit tests for @arbitova/x402-adapter.
// These tests stub out ethers contracts so they run without a chain.
// E2E tests against Sepolia live in scripts/ (see spec deliverables).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEscrow, parseEscrowHeader } from '../src/index.js';

const ESCROW_ADDR = '0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC';

function makeResponse({ status = 200, headers = {}, body = '' } = {}) {
  return new Response(body, { status, headers });
}

function stubContract(target, { parseLog } = {}) {
  return {
    target,
    approve: async () => ({ wait: async () => ({ status: 1 }) }),
    createEscrow: async () => ({
      wait: async () => ({
        status: 1,
        hash: '0xabc',
        logs: [{ topics: [], data: '0x' }],
      }),
    }),
    confirmDelivery: async () => ({ wait: async () => ({ status: 1 }) }),
    dispute: async () => ({ wait: async () => ({ status: 1 }) }),
    interface: {
      parseLog:
        parseLog ??
        (() => ({
          name: 'EscrowCreated',
          args: { id: 42n },
        })),
    },
  };
}

test('parseEscrowHeader parses "<address>@<chainId>"', () => {
  const parsed = parseEscrowHeader(`${ESCROW_ADDR}@84532`);
  assert.equal(parsed.address, ESCROW_ADDR);
  assert.equal(parsed.chainId, 84532);
});

test('parseEscrowHeader rejects malformed input', () => {
  assert.throws(() => parseEscrowHeader('not-a-header'));
  assert.throws(() => parseEscrowHeader(`${ESCROW_ADDR}@abc`));
  assert.throws(() => parseEscrowHeader(ESCROW_ADDR));
});

test('withEscrow passes through non-402 responses untouched', async () => {
  const baseFetch = async () => makeResponse({ status: 200, body: 'ok' });
  const wrapped = withEscrow(baseFetch, {
    signer: { /* unused on pass-through */ },
  });
  const res = await wrapped('https://example.test');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('withEscrow returns raw 402 when server did not opt in', async () => {
  const baseFetch = async () =>
    makeResponse({
      status: 402,
      headers: { 'x-402-price': '0.10 USDC', 'x-402-to': ESCROW_ADDR },
    });
  const wrapped = withEscrow(baseFetch, { signer: {} });
  const res = await wrapped('https://example.test');
  assert.equal(res.status, 402);
});

test('withEscrow throws on opt-in 402 when contracts not configured', async () => {
  const baseFetch = async () =>
    makeResponse({
      status: 402,
      headers: {
        'x-402-price': '0.10 USDC',
        'x-402-to': ESCROW_ADDR,
        'x-arbitova-escrow': `${ESCROW_ADDR}@84532`,
      },
    });
  const wrapped = withEscrow(baseFetch, { signer: {} });
  await assert.rejects(() => wrapped('https://example.test'), /escrow contracts/);
});

test('withEscrow opens an escrow on opt-in 402 and retries the request', async () => {
  let callCount = 0;
  const calls = [];
  const baseFetch = async (url, init) => {
    calls.push({ url, init });
    callCount += 1;
    if (callCount === 1) {
      return makeResponse({
        status: 402,
        headers: {
          'x-402-price': '0.10 USDC',
          'x-402-to': ESCROW_ADDR,
          'x-arbitova-escrow': `${ESCROW_ADDR}@84532`,
        },
      });
    }
    return makeResponse({ status: 200, body: 'delivered' });
  };

  const usdc = stubContract('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  const escrow = stubContract(ESCROW_ADDR);

  let createdEvent = null;
  const wrapped = withEscrow(baseFetch, {
    signer: {},
    usdc,
    escrow,
    onEscrowCreated: (ev) => { createdEvent = ev; },
  });

  const res = await wrapped('https://example.test');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'delivered');
  assert.equal(callCount, 2, 'baseFetch should be called twice (402 then retry)');
  assert.equal(wrapped.lastEscrowId, 42n);
  assert.ok(createdEvent, 'onEscrowCreated should fire');
  assert.equal(createdEvent.id, 42n);

  // Retry must carry the escrow ref header so the seller knows.
  const retry = calls[1];
  const retryHeaders = new Headers(retry.init?.headers || {});
  assert.equal(retryHeaders.get('x-arbitova-escrow-ref'), `${ESCROW_ADDR}:42`);
});

test('withEscrow.confirmLast calls confirmDelivery with the last id', async () => {
  let confirmedId = null;
  const escrow = {
    ...stubContract(ESCROW_ADDR),
    confirmDelivery: async (id) => {
      confirmedId = id;
      return { wait: async () => ({ status: 1 }) };
    },
  };
  const usdc = stubContract('0x036CbD53842c5426634e7929541eC2318f3dCF7e');

  const baseFetch = async () =>
    makeResponse({
      status: 402,
      headers: {
        'x-402-price': '100000', // raw 6-decimal base units
        'x-402-to': ESCROW_ADDR,
        'x-arbitova-escrow': `${ESCROW_ADDR}@84532`,
      },
    });

  const wrapped = withEscrow(async (url, init) => {
    const count = ++wrapped._count || (wrapped._count = 1);
    if (count === 1) return baseFetch(url, init);
    return makeResponse({ status: 200 });
  }, { signer: {}, usdc, escrow });

  await wrapped('https://example.test');
  await wrapped.confirmLast();
  assert.equal(confirmedId, 42n);
});

test('withEscrow rejects escrow contract mismatch', async () => {
  const otherEscrow = stubContract('0x1111111111111111111111111111111111111111');
  const usdc = stubContract('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  const baseFetch = async () =>
    makeResponse({
      status: 402,
      headers: {
        'x-402-price': '0.10 USDC',
        'x-402-to': ESCROW_ADDR,
        'x-arbitova-escrow': `${ESCROW_ADDR}@84532`,
      },
    });
  const wrapped = withEscrow(baseFetch, {
    signer: {},
    usdc,
    escrow: otherEscrow,
  });
  await assert.rejects(() => wrapped('https://example.test'), /mismatch/i);
});
