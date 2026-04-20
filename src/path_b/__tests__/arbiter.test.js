'use strict';
/**
 * src/path_b/__tests__/arbiter.test.js
 *
 * Tests the arbitration AI service with a mocked Claude API.
 * Does NOT call the real Claude API or any on-chain RPC.
 *
 * Run: node --test src/path_b/__tests__/arbiter.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

delete process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/sdk before requiring arbiter
// ---------------------------------------------------------------------------
const mockMessages = { create: null };
const anthropicMock = function () { return { messages: mockMessages }; };
require.cache[require.resolve('@anthropic-ai/sdk')] = {
  id: require.resolve('@anthropic-ai/sdk'),
  filename: require.resolve('@anthropic-ai/sdk'),
  loaded: true,
  exports: anthropicMock,
  children: [],
  parent: null,
  paths: [],
};

// ---------------------------------------------------------------------------
// Mock fetch for URI content retrieval
// ---------------------------------------------------------------------------
global.fetch = async (url) => ({
  ok: true,
  status: 200,
  text: async () => `Content from ${url}`,
});

// ---------------------------------------------------------------------------
// Mock DB update to avoid touching real DB in these unit tests
// ---------------------------------------------------------------------------
const db = require('../db');
const dbUpdates = [];
db.updateEscrowState = async (id, updates) => { dbUpdates.push({ id, updates }); };

// Load arbiter AFTER mocks are in place
const arbiter = require('../arbiter');

// ---------------------------------------------------------------------------
// Patch the internal resolveOnChain to avoid real ethers/RPC calls.
// We expose it via a module-level override by monkey-patching after require.
// Since resolveOnChain is not exported, we inject via process.env sentinel
// and intercept at the ethers.JsonRpcProvider constructor level using a shim.
// ---------------------------------------------------------------------------
// Simpler approach: override module's internal via dynamic require re-export trick.
// Instead, we track on-chain calls by watching db.updateEscrowState for state:'RESOLVED'.
// The arbiter calls resolveOnChain only for high-confidence verdicts.
// We also set PATH_B_ARBITER_KEY to an intentionally bad value to trigger the
// "env vars missing" skip path — but we want to test the FULL path.
//
// Best approach: export resolveOnChain from arbiter as a named export for testability.
// Since we can't modify arbiter (spec says no), we instead test via side effects:
//   - High confidence: dbUpdates contains state:'RESOLVED' or txHash is non-null
//   - We accept that the actual RPC call will fail (no real node) and verify
//     that the arbiter handles it gracefully and still writes the verdict file.

const VERDICT_DIR = path.resolve(__dirname, '../../../path_b_verdicts');

function mockClaudeResponse(verdict) {
  mockMessages.create = async () => ({
    content: [{ type: 'text', text: JSON.stringify(verdict) }],
  });
}

before(async () => {
  await db.ensureSchema();
  // Set env vars — RPC will fail gracefully since there's no real node
  process.env.BASE_RPC_URL = 'https://mock.rpc.invalid';
  process.env.ESCROW_V1_ADDRESS = '0x' + '1'.repeat(40);
  process.env.CHAIN_ID = '8453';
  process.env.PATH_B_ARBITER_KEY = '0x' + 'a'.repeat(64);
  process.env.ANTHROPIC_API_KEY = 'sk-mock';
});

const escrow = {
  escrow_id: 5001,
  buyer_address: '0x' + 'B'.repeat(40),
  seller_address: '0x' + 'A'.repeat(40),
  amount: '2000000',
  state: 'DISPUTED',
  verification_uri: 'https://example.com/verify/5001',
  delivery_hash: '0x' + 'd'.repeat(64),
  delivery_payload_uri: 'https://example.com/delivery/5001',
  buyer_email: 'buyer@example.com',
  seller_email: 'seller@example.com',
  verdict_hash: null,
  resolved_buyer_bps: null,
  resolved_seller_bps: null,
};

// ---------------------------------------------------------------------------
// Unit tests — pure functions
// ---------------------------------------------------------------------------
test('parseVerdict: valid JSON with correct bps sum succeeds', () => {
  const v = arbiter.parseVerdict(JSON.stringify({
    buyerBps: 3000, sellerBps: 7000, reasoning: 'Delivery met criteria.', confidence: 0.9,
  }));
  assert.equal(v.buyerBps, 3000);
  assert.equal(v.sellerBps, 7000);
  assert.equal(v.confidence, 0.9);
});

test('parseVerdict: bps not summing to 10000 throws', () => {
  assert.throws(() => {
    arbiter.parseVerdict(JSON.stringify({ buyerBps: 3000, sellerBps: 6000, reasoning: 'Test.', confidence: 0.8 }));
  }, /10000/);
});

test('parseVerdict: strips markdown fences', () => {
  const raw = '```json\n{"buyerBps":5000,"sellerBps":5000,"reasoning":"Fair","confidence":0.85}\n```';
  const v = arbiter.parseVerdict(raw);
  assert.equal(v.buyerBps, 5000);
});

test('parseVerdict: missing confidence throws', () => {
  assert.throws(() => {
    arbiter.parseVerdict(JSON.stringify({ buyerBps: 5000, sellerBps: 5000, reasoning: 'ok' }));
  }, /confidence/);
});

test('computeVerdictHash: deterministic output', () => {
  const verdict = { escrowId: 1, buyerBps: 5000, sellerBps: 5000, reasoning: 'Fair.', confidence: 0.9 };
  const h1 = arbiter.computeVerdictHash(verdict);
  const h2 = arbiter.computeVerdictHash(verdict);
  assert.equal(h1, h2);
  assert.ok(h1.startsWith('0x'));
});

test('computeVerdictHash: different verdicts produce different hashes', () => {
  const v1 = { escrowId: 1, buyerBps: 5000, sellerBps: 5000, reasoning: 'Fair.', confidence: 0.9 };
  const v2 = { escrowId: 1, buyerBps: 3000, sellerBps: 7000, reasoning: 'Seller wins.', confidence: 0.9 };
  assert.notEqual(arbiter.computeVerdictHash(v1), arbiter.computeVerdictHash(v2));
});

test('buildPrompt: injects all escrow fields into template', () => {
  const prompt = arbiter.buildPrompt(
    escrow,
    'Must deliver a working REST API.',
    'Here is the API endpoint: https://api.test',
    'API returns 500 errors.'
  );
  assert.ok(prompt.includes('5001'), 'escrow ID');
  assert.ok(prompt.includes('2000000'), 'amount');
  assert.ok(prompt.includes('API returns 500 errors'), 'dispute reason');
  assert.ok(prompt.includes('Must deliver a working REST API'), 'verification content');
  assert.ok(prompt.includes('Here is the API endpoint'), 'delivery content');
});

// ---------------------------------------------------------------------------
// Integration-style tests (mock Claude, accept graceful RPC failure)
// ---------------------------------------------------------------------------
test('triggerArbitration: high-confidence verdict saves verdict file', async () => {
  dbUpdates.length = 0;
  mockClaudeResponse({
    buyerBps: 2000, sellerBps: 8000, reasoning: 'Seller met all criteria.', confidence: 0.95,
  });

  const result = await arbiter.triggerArbitration(escrow);

  // Should NOT be human review
  assert.ok(!result.humanReview, 'should not flag for human review');
  assert.equal(result.verdict.buyerBps, 2000);
  assert.equal(result.verdict.sellerBps, 8000);

  // Verdict file must be saved
  const verdictFile = path.join(VERDICT_DIR, '5001.json');
  assert.ok(fs.existsSync(verdictFile), 'verdict file should exist');
  const saved = JSON.parse(fs.readFileSync(verdictFile, 'utf8'));
  assert.equal(saved.buyerBps, 2000);
  assert.ok(saved.verdictHash, 'verdict file should include hash');

  // DB update should have been called (resolve state or verdict_hash)
  const upd = dbUpdates.find((u) => u.id === 5001);
  assert.ok(upd, 'DB should have been updated for escrow 5001');
});

test('triggerArbitration: low-confidence verdict flags for human review, no resolve tx', async () => {
  dbUpdates.length = 0;
  mockClaudeResponse({
    buyerBps: 5000, sellerBps: 5000, reasoning: 'Evidence is ambiguous.', confidence: 0.5,
  });

  const result = await arbiter.triggerArbitration({ ...escrow, escrow_id: 5002 });

  assert.ok(result.humanReview === true, 'should flag for human review');
  // txHash must NOT be set (no on-chain call for low confidence)
  assert.ok(!result.txHash, 'txHash should be absent for low-confidence path');

  // DB update should contain _NEEDS_REVIEW marker
  const upd = dbUpdates.find((u) => u.id === 5002 && u.updates && u.updates.verdict_hash);
  assert.ok(upd, 'should update DB');
  assert.ok(String(upd.updates.verdict_hash).includes('NEEDS_REVIEW'), 'verdict_hash should flag review');
});

test('triggerArbitration: malformed Claude response returns error', async () => {
  mockMessages.create = async () => ({
    content: [{ type: 'text', text: 'This is not JSON at all, sorry!' }],
  });

  const result = await arbiter.triggerArbitration({ ...escrow, escrow_id: 5003 });
  assert.equal(result.error, 'parse_failed', 'should return parse_failed');
  assert.ok(result.raw, 'should include raw response');
});

test('fetchContent: handles IPFS URI conversion via cloudflare gateway', async () => {
  global.fetch = async (url) => ({ ok: true, status: 200, text: async () => `got ${url}` });
  const content = await arbiter.fetchContent('ipfs://QmTestHash123');
  assert.ok(content.includes('cloudflare-ipfs.com'), 'should use IPFS gateway');
  assert.ok(content.includes('QmTestHash123'));
});

test('fetchContent: handles null URI gracefully', async () => {
  const content = await arbiter.fetchContent(null);
  assert.ok(content.includes('no content'));
});

test('fetchContent: handles fetch error gracefully', async () => {
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const content = await arbiter.fetchContent('https://unreachable.test');
  assert.ok(content.includes('fetch error'));
  // Restore
  global.fetch = async (url) => ({ ok: true, status: 200, text: async () => `Content from ${url}` });
});
