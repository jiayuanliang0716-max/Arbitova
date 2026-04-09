/**
 * Contract verification + discover smoke test
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function call(method, path, body, key) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key && { 'X-API-Key': key })
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('PASS:', msg);
}

async function run() {
  console.log('\n=== Contract + Discover smoke test ===\n');

  // Register seller
  const seller = (await call('POST', '/agents/register', { name: 'AutoSeller' })).data;
  const buyer  = (await call('POST', '/agents/register', { name: 'AutoBuyer' })).data;

  // Publish a service with output_schema + rules + auto_verify
  const svcRes = await call('POST', '/services', {
    name: 'Strict Summarizer',
    price: 2,
    input_schema: {
      type: 'object',
      required: ['article'],
      properties: { article: { type: 'string' } }
    },
    output_schema: {
      type: 'object',
      required: ['summary'],
      properties: { summary: { type: 'string' } }
    },
    verification_rules: [
      { type: 'min_length', path: 'summary', value: 20 }
    ],
    auto_verify: true
  }, seller.api_key);
  assert(svcRes.status === 201, 'create contracted service');
  const svcId = svcRes.data.id;

  // Input validation: missing required field → should fail
  const badOrder = await call('POST', '/orders',
    { service_id: svcId, requirements: JSON.stringify({}) }, buyer.api_key);
  assert(badOrder.status === 400, 'reject order with invalid input (missing required)');

  // Input validation: non-JSON → fail
  const nonJson = await call('POST', '/orders',
    { service_id: svcId, requirements: 'just text' }, buyer.api_key);
  assert(nonJson.status === 400, 'reject order whose requirements is non-JSON');

  // Good order
  const goodOrder = await call('POST', '/orders',
    { service_id: svcId, requirements: JSON.stringify({ article: 'Here is the article body.' }) },
    buyer.api_key);
  assert(goodOrder.status === 201, 'create order with valid input');
  const orderId = goodOrder.data.id;

  // Deliver with valid output → should auto-complete
  const okDeliver = await call('POST', '/orders/' + orderId + '/deliver',
    { content: JSON.stringify({ summary: 'This is a sufficiently long auto-verified summary.' }) },
    seller.api_key);
  assert(okDeliver.data.status === 'completed', 'auto-verify passes, order auto-completes');
  assert(okDeliver.data.auto_verified === true, 'auto_verified flag true');

  // Second order, bad delivery → should auto-refund
  const order2 = await call('POST', '/orders',
    { service_id: svcId, requirements: JSON.stringify({ article: 'Another article.' }) },
    buyer.api_key);
  const badDeliver = await call('POST', '/orders/' + order2.data.id + '/deliver',
    { content: JSON.stringify({ summary: 'too short' }) },
    seller.api_key);
  assert(badDeliver.status === 400, 'bad delivery returns 400');
  assert(badDeliver.data.status === 'refunded', 'bad delivery auto-refunded');
  assert(badDeliver.data.verification_failed === true, 'verification_failed flag set');

  // Discover by output shape
  const disc = await call('POST', '/services/discover',
    { output_like: { required: ['summary'] } });
  assert(disc.status === 200, 'discover returns 200');
  assert(disc.data.matches.length >= 1, 'discover finds at least one service');
  assert(disc.data.matches[0].id === svcId, 'discover top match is our service');
  assert(disc.data.matches[0].match_score > 0, 'match has positive score');

  // Reputation should reflect: +10 auto_verified, -20 auto_verification_failed → net -10
  const rep = await call('GET', '/agents/' + seller.id + '/reputation');
  console.log('Seller rep:', rep.data.reputation_score, 'history entries:', rep.data.history.length);
  assert(rep.data.reputation_score === -10, 'rep net -10 after one pass + one fail');

  console.log('\nAll contract tests passed ✓\n');
}

run().catch(e => { console.error('Test crashed:', e); process.exit(1); });
