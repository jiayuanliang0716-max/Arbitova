'use strict';
/**
 * src/path_b/__tests__/notify.test.js
 *
 * Tests the notification service by mocking mailer and fetch.
 *
 * Run: node --test src/path_b/__tests__/notify.test.js
 */

const { test, before, mock } = require('node:test');
const assert = require('node:assert/strict');

delete process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Mock mailer before requiring notify
// ---------------------------------------------------------------------------
const mailer = require('../mailer');
const sentEmails = [];
mailer.sendMail = async (opts) => { sentEmails.push(opts); return {}; };

// ---------------------------------------------------------------------------
// Mock fetch (webhook delivery)
// ---------------------------------------------------------------------------
const webhookCalls = [];
global.fetch = async (url, opts) => {
  webhookCalls.push({ url, body: JSON.parse(opts.body) });
  return { ok: true, status: 200 };
};

// ---------------------------------------------------------------------------
// Mock arbiter (avoid triggering AI during notification tests)
// ---------------------------------------------------------------------------
const arbiterMock = { triggerArbitration: async () => ({ mocked: true }) };
// We override via module mock below in relevant tests

const db = require('../db');
const { dbGet } = require('../../db/helpers');

// Patch dbGet to return a fake agent with webhook_url in settings
const originalDbGet = require('../../db/helpers').dbGet;

// ---------------------------------------------------------------------------
// Shared escrow fixture
// ---------------------------------------------------------------------------
const escrow = {
  escrow_id: 7001,
  buyer_address: '0xBBBB',
  seller_address: '0xSSSSS',
  amount: '1000000',
  state: 'CREATED',
  delivery_deadline: new Date(Date.now() + 86400_000).toISOString(),
  review_deadline: new Date(Date.now() + 3600_000).toISOString(),
  verification_uri: 'https://example.com/verify',
  delivery_hash: '0xdeliveryhash',
  buyer_email: 'buyer@example.com',
  seller_email: 'seller@example.com',
  verdict_hash: null,
  resolved_buyer_bps: null,
  resolved_seller_bps: null,
};

before(async () => {
  await db.ensureSchema();
  // Ensure escrow exists in DB for notifications that call db.insertNotification
  await db.upsertEscrow(escrow);
});

// ---------------------------------------------------------------------------
// Helper: reset arrays between tests
// ---------------------------------------------------------------------------
function clearCaptures() {
  sentEmails.length = 0;
  webhookCalls.length = 0;
}

// ---------------------------------------------------------------------------
// Load notify AFTER mocks are set up
// ---------------------------------------------------------------------------
const notify = require('../notify');

// Override arbiter require inside notify at runtime by patching the module cache
// (arbiter is lazy-required inside handleEvent to avoid circular deps)
require.cache[require.resolve('../arbiter')] = {
  id: require.resolve('../arbiter'),
  filename: require.resolve('../arbiter'),
  loaded: true,
  exports: arbiterMock,
  children: [],
  parent: null,
  paths: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test('EscrowCreated → emails buyer and seller', async () => {
  clearCaptures();
  await notify.handleEvent('EscrowCreated', escrow, {});
  const recipients = sentEmails.map((e) => e.to);
  assert.ok(recipients.includes('buyer@example.com'), 'buyer should receive email');
  assert.ok(recipients.includes('seller@example.com'), 'seller should receive email');
});

test('Delivered → emails buyer only', async () => {
  clearCaptures();
  await notify.handleEvent('Delivered', { ...escrow, state: 'DELIVERED' }, {});
  const recipients = sentEmails.map((e) => e.to);
  assert.ok(recipients.includes('buyer@example.com'), 'buyer should receive delivery email');
  // seller is NOT emailed on Delivered per spec
  assert.ok(!recipients.includes('seller@example.com'), 'seller should NOT be emailed on Delivered');
});

test('Released → emails both parties', async () => {
  clearCaptures();
  await notify.handleEvent('Released', { ...escrow, state: 'RELEASED' }, {});
  const recipients = sentEmails.map((e) => e.to);
  assert.ok(recipients.includes('buyer@example.com'));
  assert.ok(recipients.includes('seller@example.com'));
});

test('Disputed → emails both parties and triggers arbitration', async () => {
  clearCaptures();
  let arbiterCalled = false;
  arbiterMock.triggerArbitration = async (e) => { arbiterCalled = true; return {}; };

  await notify.handleEvent('Disputed', { ...escrow, state: 'DISPUTED' }, { reason: 'not delivered' });

  const recipients = sentEmails.map((e) => e.to);
  assert.ok(recipients.includes('buyer@example.com'));
  assert.ok(recipients.includes('seller@example.com'));
  // Give async arbiter a tick to run
  await new Promise((r) => setImmediate(r));
  assert.ok(arbiterCalled, 'arbiter should be triggered on Disputed');
});

test('Escalated → emails both parties and triggers arbitration', async () => {
  clearCaptures();
  let arbiterCalled = false;
  arbiterMock.triggerArbitration = async (e) => { arbiterCalled = true; return {}; };

  await notify.handleEvent('Escalated', { ...escrow, state: 'DISPUTED' }, {});

  const recipients = sentEmails.map((e) => e.to);
  assert.ok(recipients.includes('buyer@example.com'));
  assert.ok(recipients.includes('seller@example.com'));
  await new Promise((r) => setImmediate(r));
  assert.ok(arbiterCalled, 'arbiter should be triggered on Escalated');
});

test('Resolved → emails both parties with verdict info', async () => {
  clearCaptures();
  const resolvedEscrow = {
    ...escrow,
    state: 'RESOLVED',
    verdict_hash: '0xverdicthash',
    resolved_buyer_bps: 3000,
    resolved_seller_bps: 7000,
  };
  await notify.handleEvent('Resolved', resolvedEscrow, {});
  const recipients = sentEmails.map((e) => e.to);
  assert.ok(recipients.includes('buyer@example.com'));
  assert.ok(recipients.includes('seller@example.com'));
  // Verify verdict info is in email body
  const buyerEmail = sentEmails.find((e) => e.to === 'buyer@example.com');
  assert.ok(buyerEmail.text.includes('3000'), 'email should contain buyerBps');
});

test('Cancelled → emails both parties', async () => {
  clearCaptures();
  await notify.handleEvent('Cancelled', { ...escrow, state: 'CANCELLED' }, {});
  const recipients = sentEmails.map((e) => e.to);
  assert.ok(recipients.includes('buyer@example.com'));
  assert.ok(recipients.includes('seller@example.com'));
});

test('deliverWebhook retries on failure then throws', async () => {
  let attempts = 0;
  global.fetch = async () => {
    attempts++;
    if (attempts < 4) return { ok: false, status: 503 };
    throw new Error('network error');
  };

  // Pass short retry delays to keep the test fast (default is [2000, 8000, 30000])
  await assert.rejects(
    () => notify.deliverWebhook('https://webhook.test', { test: true }, [10, 10, 10]),
    /network error|HTTP 503/
  );
  // Restore
  global.fetch = async (url, opts) => {
    webhookCalls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  };
});

test('unknown event does not throw', async () => {
  await notify.handleEvent('UnknownEvent', escrow, {});
  // Should just log and return
  assert.ok(true);
});
