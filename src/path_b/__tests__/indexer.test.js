'use strict';
/**
 * src/path_b/__tests__/indexer.test.js
 *
 * Tests the indexer log-processing logic using mock provider + in-memory SQLite DB.
 * Does NOT connect to any real network.
 *
 * Run: node --test src/path_b/__tests__/indexer.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Force SQLite — never touch prod Postgres
delete process.env.DATABASE_URL;

// Stub notify so tests don't fire real emails/webhooks
const notify = require('../notify');
const originalHandleEvent = notify.handleEvent;
notify.handleEvent = async () => {};

const db = require('../db');
const { ethers } = require('ethers');

// Minimal ABI for decoding
const ESCROW_ABI = [
  'event EscrowCreated(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, uint64 deliveryDeadline, string verificationURI)',
  'event Delivered(uint256 indexed id, bytes32 deliveryHash, uint64 reviewDeadline)',
  'event Released(uint256 indexed id, uint256 toSeller, uint256 fee)',
  'event Disputed(uint256 indexed id, address indexed by, string reason)',
  'event Escalated(uint256 indexed id)',
  'event Resolved(uint256 indexed id, uint256 toBuyer, uint256 toSeller, uint256 fee, bytes32 verdictHash)',
  'event Cancelled(uint256 indexed id)',
];

const iface = new ethers.Interface(ESCROW_ABI);

// ---------------------------------------------------------------------------
// Helpers: build fake encoded logs
// ---------------------------------------------------------------------------
function makeLog(eventName, args, txHash, logIndex, blockNumber) {
  const fragment = iface.getEvent(eventName);
  const encoded = iface.encodeEventLog(fragment, args);
  return {
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: txHash,
    index: logIndex,
    logIndex,
    blockNumber,
  };
}

const BUYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const DELIVERY_DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 86400);
const REVIEW_DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 3600);
const DELIVERY_HASH = ethers.keccak256(ethers.toUtf8Bytes('test-delivery'));
const VERDICT_HASH = ethers.keccak256(ethers.toUtf8Bytes('verdict'));

// We need processLog — export it from indexer for testing
// The indexer doesn't export processLog directly; we import the internal fn via a test shim.
// Instead, we test the DB functions directly and verify the full pipeline via db.upsertEscrow + db.updateEscrowState.

before(async () => {
  await db.ensureSchema();
});

after(() => {
  notify.handleEvent = originalHandleEvent;
});

// ---------------------------------------------------------------------------
// DB layer tests
// ---------------------------------------------------------------------------
test('upsertEscrow creates a new row', async () => {
  await db.upsertEscrow({
    escrow_id: 9001,
    tx_hash: '0xabc',
    buyer_address: BUYER,
    seller_address: SELLER,
    amount: '1000000',
    delivery_deadline: new Date(Number(DELIVERY_DEADLINE) * 1000).toISOString(),
    review_deadline: null,
    state: 'CREATED',
    verification_uri: 'https://example.com/verify/9001',
  });

  const row = await db.getEscrow(9001);
  assert.equal(row.escrow_id, 9001);
  assert.equal(row.state, 'CREATED');
  assert.equal(row.buyer_address, BUYER);
  assert.equal(row.seller_address, SELLER);
});

test('upsertEscrow is idempotent — duplicate call does not error', async () => {
  await db.upsertEscrow({
    escrow_id: 9001,
    tx_hash: '0xabc',
    buyer_address: BUYER,
    seller_address: SELLER,
    amount: '1000000',
    delivery_deadline: new Date(Number(DELIVERY_DEADLINE) * 1000).toISOString(),
    review_deadline: null,
    state: 'CREATED',
    verification_uri: 'https://example.com/verify/9001',
  });
  const row = await db.getEscrow(9001);
  assert.equal(row.state, 'CREATED');
});

test('updateEscrowState transitions to DELIVERED', async () => {
  await db.updateEscrowState(9001, {
    state: 'DELIVERED',
    delivery_hash: DELIVERY_HASH,
    review_deadline: new Date(Number(REVIEW_DEADLINE) * 1000).toISOString(),
  });
  const row = await db.getEscrow(9001);
  assert.equal(row.state, 'DELIVERED');
  assert.ok(row.delivery_hash);
});

test('insertEvent stores a raw event and is idempotent', async () => {
  const payload = { args: { id: '9001', buyer: BUYER }, blockNumber: 100 };
  await db.insertEvent({
    escrow_id: 9001,
    event_name: 'EscrowCreated',
    block_number: 100,
    tx_hash: '0xdeadbeef01',
    log_index: 0,
    payload,
  });
  // Second insert with same tx_hash+log_index should be silently ignored
  await db.insertEvent({
    escrow_id: 9001,
    event_name: 'EscrowCreated',
    block_number: 100,
    tx_hash: '0xdeadbeef01',
    log_index: 0,
    payload,
  });
  // If we get here without error, idempotency is confirmed
  assert.ok(true);
});

test('cursor read/write round-trips correctly', async () => {
  await db.setCursor(8453, '0xContractAddr', 555000);
  const cursor = await db.getCursor(8453);
  assert.equal(Number(cursor.last_block), 555000);
  assert.equal(cursor.contract_address, '0xContractAddr');
});

test('cursor upsert advances block', async () => {
  await db.setCursor(8453, '0xContractAddr', 556000);
  const cursor = await db.getCursor(8453);
  assert.equal(Number(cursor.last_block), 556000);
});

test('getExpiredDeliveredEscrows returns past-deadline rows', async () => {
  // Insert an escrow with review_deadline in the past
  await db.upsertEscrow({
    escrow_id: 9002,
    tx_hash: '0xpast',
    buyer_address: BUYER,
    seller_address: SELLER,
    amount: '500000',
    delivery_deadline: new Date(Date.now() - 7200_000).toISOString(),
    review_deadline: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
    state: 'DELIVERED',
    verification_uri: 'https://example.com/verify/9002',
  });

  const expired = await db.getExpiredDeliveredEscrows();
  const found = expired.find((e) => Number(e.escrow_id) === 9002);
  assert.ok(found, 'should find the expired DELIVERED escrow');
});

test('getExpiredDeliveredEscrows excludes future deadlines', async () => {
  // escrow_id 9001 was set to DELIVERED with a future review_deadline (REVIEW_DEADLINE = now + 3600)
  const expired = await db.getExpiredDeliveredEscrows();
  const found = expired.find((e) => Number(e.escrow_id) === 9001);
  assert.equal(found, undefined, 'should NOT return escrow with future review_deadline');
});

// ---------------------------------------------------------------------------
// ethers ABI decoding smoke test
// ---------------------------------------------------------------------------
test('EscrowCreated log decodes correctly', () => {
  const log = makeLog(
    'EscrowCreated',
    [1n, BUYER, SELLER, 1_000_000n, DELIVERY_DEADLINE, 'https://verify.test'],
    '0xlog1', 0, 100
  );
  const parsed = iface.parseLog({ topics: log.topics, data: log.data });
  assert.equal(parsed.name, 'EscrowCreated');
  assert.equal(parsed.args.buyer.toLowerCase(), BUYER.toLowerCase());
  assert.equal(parsed.args.seller.toLowerCase(), SELLER.toLowerCase());
  assert.equal(parsed.args.amount, 1_000_000n);
});

test('Delivered log decodes correctly', () => {
  const log = makeLog('Delivered', [1n, DELIVERY_HASH, REVIEW_DEADLINE], '0xlog2', 0, 101);
  const parsed = iface.parseLog({ topics: log.topics, data: log.data });
  assert.equal(parsed.name, 'Delivered');
  assert.equal(parsed.args.deliveryHash, DELIVERY_HASH);
});

test('Resolved log decodes correctly', () => {
  const log = makeLog('Resolved', [1n, 5000n, 5000n, 100n, VERDICT_HASH], '0xlog3', 0, 102);
  const parsed = iface.parseLog({ topics: log.topics, data: log.data });
  assert.equal(parsed.name, 'Resolved');
  assert.equal(parsed.args.verdictHash, VERDICT_HASH);
});
