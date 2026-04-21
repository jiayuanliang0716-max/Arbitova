// Smoke tests for @arbitova/sdk — these run without a live RPC.
// Verifies exports, constants, and that read-only client can be constructed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Arbitova, NETWORKS, STATES, ESCROW_ABI, ERC20_ABI } from '../src/index.js';

test('exports the expected top-level surface', () => {
  assert.equal(typeof Arbitova, 'function', 'Arbitova is a class');
  assert.equal(typeof Arbitova.fromPrivateKey, 'function');
  assert.equal(typeof Arbitova.fromWallet, 'function');
  assert.equal(typeof Arbitova.fromReadOnly, 'function');
  assert.equal(typeof Arbitova.keccakURI, 'function');
});

test('NETWORKS contains at least base-sepolia with valid shape', () => {
  assert.ok(NETWORKS['base-sepolia'], 'base-sepolia present');
  for (const [name, net] of Object.entries(NETWORKS)) {
    assert.match(net.escrow, /^0x[a-fA-F0-9]{40}$/, `${name}.escrow is an address`);
    assert.match(net.usdc, /^0x[a-fA-F0-9]{40}$/, `${name}.usdc is an address`);
    assert.equal(typeof net.chainId, 'number');
    assert.match(net.chainIdHex, /^0x[0-9a-f]+$/);
  }
});

test('STATES enum matches spec RFC order', () => {
  assert.deepEqual(STATES, ['CREATED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'RESOLVED', 'CANCELLED']);
});

test('ESCROW_ABI contains all required spec methods', () => {
  const joined = ESCROW_ABI.join(' ');
  for (const m of ['createEscrow', 'markDelivered', 'confirmDelivery', 'dispute', 'cancelIfNotDelivered', 'escalateIfExpired', 'getEscrow']) {
    assert.ok(joined.includes(m), `ABI contains ${m}`);
  }
});

test('ESCROW_ABI contains all required spec events', () => {
  const joined = ESCROW_ABI.join(' ');
  for (const e of ['EscrowCreated', 'Delivered', 'Released', 'Disputed', 'Cancelled', 'Resolved']) {
    assert.ok(joined.includes(`event ${e}`), `ABI contains event ${e}`);
  }
});

test('ERC20_ABI has approve/allowance/balanceOf', () => {
  const joined = ERC20_ABI.join(' ');
  for (const m of ['approve', 'allowance', 'balanceOf', 'decimals', 'symbol']) {
    assert.ok(joined.includes(m), `ERC20 ABI contains ${m}`);
  }
});

test('keccakURI returns bytes32 hex', () => {
  const h = Arbitova.keccakURI('ipfs://test');
  assert.match(h, /^0x[a-fA-F0-9]{64}$/);
});

test('fromReadOnly rejects unknown network', async () => {
  await assert.rejects(
    () => Arbitova.fromReadOnly({ network: 'polkadot' }),
    /Unknown network/,
  );
});

test('constructor throws helpful message when signer-only method called read-only', async () => {
  // Construct a minimal read-only client (no RPC hit needed for this test,
  // since requireSigner throws before any chain call).
  // We can't easily mock JsonRpcProvider without ethers; instead, just exercise
  // the requireSigner path by constructing the class directly.
  const { Arbitova: Cls } = await import('../src/index.js');
  const stub = Object.create(Cls.prototype);
  stub.signer = null;
  assert.throws(() => stub.requireSigner(), /Client is read-only/);
});
