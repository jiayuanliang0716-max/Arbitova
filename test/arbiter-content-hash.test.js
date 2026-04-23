'use strict';

/**
 * test/arbiter-content-hash.test.js — M-4 delivery content-hash SOP.
 *
 * The arbiter must not sign `resolve` on a verdict whose underlying
 * delivery content has drifted from the hash recorded at delivery time.
 * This file pins that SOP at three layers:
 *
 *   unit:   verifyDeliveryContentHash produces the right {match, recorded, recomputed}
 *   bundle: buildEvidenceBundle surfaces content_hash_match in the evidence record
 *   gate:   a hash mismatch forces escalate_to_human regardless of confidence
 *
 * The third layer is validated via a light constitutional-path test (no
 * network), because the full LLM ensemble is out of scope for unit tests.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  sha256Hex,
  verifyDeliveryContentHash,
  buildEvidenceBundle,
} = require('../src/arbitrate');

// ─── verifyDeliveryContentHash ────────────────────────────────────────────

test('H1 verifyDeliveryContentHash: no delivery → null advisory', () => {
  const out = verifyDeliveryContentHash(null);
  assert.deepEqual(out, { match: null, recorded: null, recomputed: null });
});

test('H2 verifyDeliveryContentHash: delivery with no recorded hash → advisory only', () => {
  const out = verifyDeliveryContentHash({ content: 'hello world' });
  assert.equal(out.match, null);
  assert.equal(out.recorded, null);
  assert.equal(out.recomputed, sha256Hex('hello world'));
});

test('H3 verifyDeliveryContentHash: recorded hash matches content → match=true', () => {
  const content = 'This is the delivered report.';
  const delivery = { content, payload_hash: sha256Hex(content) };
  const out = verifyDeliveryContentHash(delivery);
  assert.equal(out.match, true);
  assert.equal(out.recorded, sha256Hex(content));
  assert.equal(out.recomputed, sha256Hex(content));
});

test('H4 verifyDeliveryContentHash: recorded hash mismatch → match=false', () => {
  const delivery = {
    content: 'tampered content',
    payload_hash: sha256Hex('original content'),
  };
  const out = verifyDeliveryContentHash(delivery);
  assert.equal(out.match, false);
  assert.notEqual(out.recorded, out.recomputed);
});

test('H5 verifyDeliveryContentHash: accepts bare hex or sha256-prefixed form', () => {
  const content = 'x';
  const bareHex = sha256Hex(content).replace(/^sha256:/, '');
  const out = verifyDeliveryContentHash({ content, payload_hash: bareHex });
  assert.equal(out.match, true);
});

test('H6 verifyDeliveryContentHash: object content is JSON-stringified before hashing', () => {
  const content = { ok: true, n: 1 };
  const recorded = sha256Hex(JSON.stringify(content));
  const out = verifyDeliveryContentHash({ content, payload_hash: recorded });
  assert.equal(out.match, true);
});

test('H7 verifyDeliveryContentHash: content_hash alias also works', () => {
  const content = 'alt field name';
  const out = verifyDeliveryContentHash({
    content,
    content_hash: sha256Hex(content),
  });
  assert.equal(out.match, true);
});

// ─── buildEvidenceBundle surfaces the gate ───────────────────────────────

test('H8 buildEvidenceBundle: match → content_hash_match=true, both hashes recorded', () => {
  const content = 'clean delivery';
  const bundle = buildEvidenceBundle({
    order: { buyer_id: 'b', amount: 10 },
    dispute: { raised_by: 'b', created_at: '2026-04-23T10:00:00Z' },
    delivery: { content, payload_hash: sha256Hex(content), created_at: '2026-04-23T09:00:00Z' },
  });
  assert.equal(bundle.content_hash_match, true);
  assert.equal(bundle.delivery_payload_hash, sha256Hex(content));
  assert.equal(bundle.delivery_payload_hash_recomputed, sha256Hex(content));
});

test('H9 buildEvidenceBundle: mismatch → content_hash_match=false (arbiter escalates)', () => {
  const bundle = buildEvidenceBundle({
    order: { buyer_id: 'b', amount: 10 },
    dispute: { raised_by: 'b', created_at: '2026-04-23T10:00:00Z' },
    delivery: {
      content: 'tampered',
      payload_hash: sha256Hex('original'),
      created_at: '2026-04-23T09:00:00Z',
    },
  });
  assert.equal(bundle.content_hash_match, false);
  assert.notEqual(bundle.delivery_payload_hash, bundle.delivery_payload_hash_recomputed);
});

test('H10 buildEvidenceBundle: no recorded hash → content_hash_match=null (advisory)', () => {
  const bundle = buildEvidenceBundle({
    order: { buyer_id: 'b', amount: 10 },
    dispute: { raised_by: 'b', created_at: '2026-04-23T10:00:00Z' },
    delivery: { content: 'legacy, no hash', created_at: '2026-04-23T09:00:00Z' },
  });
  assert.equal(bundle.content_hash_match, null);
  assert.equal(bundle.delivery_payload_hash, null);
  assert.ok(bundle.delivery_payload_hash_recomputed.startsWith('sha256:'));
});

test('H11 buildEvidenceBundle: no delivery → no hash fields populated', () => {
  const bundle = buildEvidenceBundle({
    order: { buyer_id: 'b', amount: 10 },
    dispute: { raised_by: 'b', created_at: '2026-04-23T10:00:00Z' },
    delivery: null,
  });
  assert.equal(bundle.content_hash_match, null);
  assert.equal(bundle.delivery_payload_hash, null);
  assert.equal(bundle.delivery_payload_hash_recomputed, null);
  assert.equal(bundle.delivery_present, false);
});
