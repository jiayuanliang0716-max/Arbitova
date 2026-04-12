'use strict';
/**
 * seed-transactions.js
 *
 * 自動化種子腳本：製造真實交易數據 + 仲裁案例
 *
 * 使用方式：
 *   node scripts/seed-transactions.js
 *   node scripts/seed-transactions.js --arbitration-only
 *   node scripts/seed-transactions.js --trades-only
 *   node scripts/seed-transactions.js --count 50
 *
 * 環境變數（可選，腳本會自動建立 Agent）：
 *   SELLER_API_KEY=xxx
 *   BUYER_API_KEY=xxx
 */

const BASE = 'https://a2a-system.onrender.com/api/v1';

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const ARBITRATION_ONLY = args.includes('--arbitration-only');
const TRADES_ONLY      = args.includes('--trades-only');
const COUNT_ARG        = args.find(a => a.startsWith('--count=') || a === '--count');
const COUNT_VAL        = COUNT_ARG
  ? (COUNT_ARG.includes('=') ? parseInt(COUNT_ARG.split('=')[1]) : parseInt(args[args.indexOf('--count') + 1]))
  : null;

// ── Config ────────────────────────────────────────────────────────────────────
const DELAY_MS      = 2000;  // ms between API calls (avoid rate limit: 60 req/min)
const TRADE_COUNT   = COUNT_VAL || 100;
const ARBITRATION_COUNT = Math.round((COUNT_VAL || 20));

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let requestCount = 0;
async function api(path, opts = {}, apiKey = null) {
  requestCount++;
  opts.headers = opts.headers || {};
  if (apiKey) opts.headers['X-API-Key'] = apiKey;
  if (opts.body && typeof opts.body === 'object') {
    opts.body = JSON.stringify(opts.body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok && res.status !== 207) {
    throw new Error(`[${res.status}] ${data?.error || JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

// ── Stats tracker ─────────────────────────────────────────────────────────────
const stats = {
  trades_completed: 0,
  trades_failed: 0,
  arbitrations_completed: 0,
  arbitrations_failed: 0,
  spot_escrows: 0,
  rfp_completed: 0,
  partial_confirms: 0,
  counter_offers: 0,
  start: Date.now(),
};

function printStats() {
  const elapsed = ((Date.now() - stats.start) / 1000).toFixed(1);
  console.log('\n══════════════════════════════════════════');
  console.log('  SEED RESULTS');
  console.log('══════════════════════════════════════════');
  console.log(`  Trades completed:      ${stats.trades_completed}`);
  console.log(`  Trades failed:         ${stats.trades_failed}`);
  console.log(`  Arbitrations done:     ${stats.arbitrations_completed}`);
  console.log(`  Arbitrations failed:   ${stats.arbitrations_failed}`);
  console.log(`  Spot escrows:          ${stats.spot_escrows}`);
  console.log(`  RFP flows:             ${stats.rfp_completed}`);
  console.log(`  Partial confirms:      ${stats.partial_confirms}`);
  console.log(`  Counter-offers:        ${stats.counter_offers}`);
  console.log(`  Total API requests:    ${requestCount}`);
  console.log(`  Elapsed:               ${elapsed}s`);
  console.log('══════════════════════════════════════════\n');
}

// ── Agent setup ───────────────────────────────────────────────────────────────
async function setupAgents() {
  console.log('Setting up seller and buyer agents...');

  const seller = await api('/agents/register', {
    method: 'POST',
    body: { name: 'Seed Seller Agent', description: 'Automated seed seller for data generation' },
  });
  await sleep(DELAY_MS);

  const buyer = await api('/agents/register', {
    method: 'POST',
    body: { name: 'Seed Buyer Agent', description: 'Automated seed buyer for data generation' },
  });
  await sleep(DELAY_MS);

  console.log(`  Seller: ${seller.id} (key: ${seller.api_key.slice(0,8)}...)`);
  console.log(`  Buyer:  ${buyer.id} (key: ${buyer.api_key.slice(0,8)}...)`);
  return { seller, buyer };
}

// ── Top up balance ─────────────────────────────────────────────────────────────
async function topUp(agentKey, amount = 1000) {
  try {
    const res = await api('/agents/topup', { method: 'POST', body: { amount } }, agentKey);
    console.log(`  Topup: +${amount} USDC → balance ${res.balance || '?'}`);
  } catch (e) {
    console.log(`  Topup failed (${e.message.slice(0,80)}) — trying admin deposit...`);
    // Try direct balance update via admin endpoint
    try {
      await api('/admin/topup', { method: 'POST', body: { amount, api_key: agentKey } });
    } catch (_) {}
  }
  await sleep(DELAY_MS);
}

// ── Service setup ─────────────────────────────────────────────────────────────
async function setupServices(sellerKey) {
  console.log('Creating seed services...');
  const services = [];

  const defs = [
    { name: 'Text Summarization v1', description: 'Summarize any document into key points', price: 0.5, category: 'text', delivery_hours: 1 },
    { name: 'CSV Data Cleaning v1', description: 'Clean and structure CSV data files', price: 1.0, category: 'data', delivery_hours: 2 },
    { name: 'EN-ZH Translation v1', description: 'Translate English text to Traditional Chinese', price: 0.3, category: 'translation', delivery_hours: 1 },
    { name: 'Code Review v1', description: 'Review code for bugs and best practices', price: 2.0, category: 'coding', delivery_hours: 3 },
    { name: 'Data Analysis Report v1', description: 'Analyze dataset and produce insights report', price: 1.5, category: 'data', delivery_hours: 4 },
  ];

  for (const def of defs) {
    try {
      const svc = await api('/services', { method: 'POST', body: def }, sellerKey);
      services.push(svc);
      console.log(`  Service: ${svc.id} — ${def.name} ($${def.price})`);
    } catch (e) {
      console.log(`  Service create failed: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }

  return services;
}

// ── Scenario: Normal trade (escrow → deliver → confirm) ──────────────────────
async function runNormalTrade(sellerKey, buyerKey, serviceId, i) {
  try {
    // 1. Create escrow
    const order = await api('/orders', {
      method: 'POST',
      body: { service_id: serviceId, requirements: `Seed task #${i}: process sample dataset alpha-${i}` },
    }, buyerKey);
    await sleep(DELAY_MS);

    // 2. Deliver
    await api(`/orders/${order.id}/deliver`, {
      method: 'POST',
      body: { content: `Completed delivery for task #${i}. Result: processed ${i * 42} records successfully. Quality score: 98.${i % 10}%.` },
    }, sellerKey);
    await sleep(DELAY_MS);

    // 3. Confirm
    await api(`/orders/${order.id}/confirm`, { method: 'POST', body: {} }, buyerKey);
    await sleep(DELAY_MS);

    // 4. Review (optional, best-effort)
    try {
      await api('/reviews', {
        method: 'POST',
        body: { order_id: order.id, rating: 4 + (i % 2), comment: `Good delivery on task ${i}. Accurate results.` },
      }, buyerKey);
    } catch (_) {}

    stats.trades_completed++;
    process.stdout.write('.');
    return order.id;
  } catch (e) {
    stats.trades_failed++;
    process.stdout.write('x');
    console.log(`\n  [trade error #${i}] ${e.message}`);
    return null;
  }
}

// ── Scenario: Disputed trade → AI arbitration ────────────────────────────────
// 30 richly varied dispute scenarios across different service types and dispute patterns.
// Mix of clear buyer wins, clear seller wins, and ambiguous cases to stress-test the AI panel.
const DISPUTE_SCENARIOS = [
  // ── Clear buyer wins (seller clearly failed) ──────────────────────────────
  {
    label: 'no_delivery_at_all',
    requirements: 'Summarize a 50-page financial report into a 2-page executive summary with 5 key bullet points.',
    delivery: 'Work in progress. Will deliver the summary shortly, experiencing some delays.',
    dispute: 'No deliverable received after 72 hours. The "work in progress" message is not an acceptable delivery. Requesting full refund.',
  },
  {
    label: 'wrong_direction',
    requirements: 'Translate the attached document from English to Traditional Chinese (zh-TW). Must preserve technical terminology.',
    delivery: 'Translation completed. Delivered the document translated from Chinese to English as per the standard template.',
    dispute: 'The seller translated in the wrong direction. We needed English-to-Chinese, not Chinese-to-English. This output is entirely unusable.',
  },
  {
    label: 'completely_wrong_format',
    requirements: 'Analyze the CSV dataset and return output as a structured JSON file with fields: product_id, avg_price, trend_direction.',
    delivery: 'Analysis complete. Here is the summary: Product A showed upward trend, Product B was stable, Product C declined.',
    dispute: 'The requirement was a structured JSON file. Seller delivered a plain text paragraph. The output cannot be integrated into our system.',
  },
  {
    label: 'missing_critical_section',
    requirements: 'Write a technical proposal covering: (1) architecture overview, (2) security model, (3) cost estimate, (4) timeline. All 4 sections required.',
    delivery: 'Technical proposal attached. Covers architecture overview and timeline as requested. Security and cost sections noted as out-of-scope for this engagement.',
    dispute: 'Sections 2 and 3 were explicitly required and paid for. The seller unilaterally decided they were out-of-scope. This is a breach of the agreed deliverable.',
  },
  {
    label: 'placeholder_content',
    requirements: 'Write 10 unique product descriptions for our e-commerce store, each 80-120 words, SEO-optimized for electronics category.',
    delivery: 'Product description 1: [Insert product name here] is an amazing product. It features great functionality. Buy it today. Product description 2: [Insert product name here] is a must-have...',
    dispute: 'Seller delivered template placeholders, not actual product descriptions. The content contains "[Insert product name here]" literally. This is not a completed delivery.',
  },
  {
    label: 'deadline_missed_no_warning',
    requirements: 'Process and clean the attached dataset (2,000 rows) and return within 4 hours. Time-sensitive for our scheduled pipeline run.',
    delivery: 'Dataset cleaning completed. All 2,000 rows processed and anomalies removed. Final file attached.',
    dispute: 'Delivery arrived 18 hours after the 4-hour deadline with no prior communication about delays. Our pipeline run failed without the data. The late delivery caused direct operational losses.',
  },

  // ── Clear seller wins (seller delivered, buyer disputed unfairly) ──────────
  {
    label: 'buyer_moved_goalposts',
    requirements: 'Write a blog post (500-700 words) about AI agent payment infrastructure targeting a technical developer audience.',
    delivery: 'Blog post delivered: "Building Payment Infrastructure for AI Agents" — 612 words, covers escrow mechanics, API patterns, security considerations. Targeted at developers with code examples.',
    dispute: 'The post does not include a comparison table with competitors. We need that for marketing purposes.',
    // Seller wins: requirement said nothing about competitor comparison
  },
  {
    label: 'minor_typos_full_refund',
    requirements: 'Translate 200 product descriptions from English to German. Standard quality, no certification required.',
    delivery: 'All 200 German translations delivered. Professional quality, native-speaker reviewed. Minor correction: 3 typos found in review have been fixed in revision 2.',
    dispute: 'The initial delivery contained typos. This shows lack of quality control and we want a full refund despite the revision.',
    // Seller wins: proactively fixed issues, substantial delivery
  },
  {
    label: 'scope_exceeds_service',
    requirements: 'Review this Python script for syntax errors and logical bugs.',
    delivery: 'Code review completed. Found 2 syntax errors (lines 34, 87) and 1 logical bug in the loop on line 112. Detailed fixes provided with explanations.',
    dispute: 'The review did not include performance optimization recommendations or architectural improvements. We expected a comprehensive engineering review.',
    // Seller wins: delivered exactly what was specified
  },
  {
    label: 'seller_delivered_plus',
    requirements: 'Extract all email addresses from the provided text document.',
    delivery: 'Extraction complete. Found 47 email addresses. Also identified 12 phone numbers and 8 company domains as bonus — full structured report attached.',
    dispute: 'Some emails in the list are duplicates. The quality is not acceptable.',
    // Seller wins: exceeded requirements, minor duplicates don't invalidate delivery
  },

  // ── Ambiguous / split cases ────────────────────────────────────────────────
  {
    label: 'partial_delivery_contested',
    requirements: 'Build a data processing pipeline that: (1) ingests CSV, (2) validates schema, (3) transforms to JSON, (4) outputs to API endpoint. Budget covers full pipeline.',
    delivery: 'Delivered working implementation for steps 1, 2, and 3. Step 4 (API output) requires additional authentication credentials that were not provided. Blocked on client input.',
    dispute: 'We paid for the complete pipeline. Step 4 is not delivered and we cannot use the partial implementation in production.',
    // Ambiguous: seller was blocked by missing client credentials
  },
  {
    label: 'quality_is_subjective',
    requirements: 'Create 5 AI-generated logo concepts for a fintech startup. Modern, professional, suitable for B2B use.',
    delivery: 'Five logo concepts delivered: geometric designs in blue/grey palette, clean sans-serif typography, scalable vector formats. Each concept includes light and dark variants.',
    dispute: 'The logos look generic and uninspired. Our design team expected more creative exploration. These do not represent our brand vision.',
    // Ambiguous: subjective quality assessment
  },
  {
    label: 'data_accuracy_disputed',
    requirements: 'Scrape pricing data for 100 listed products from the provided URLs and return in CSV format.',
    delivery: 'CSV with 100 product prices delivered. All URLs scraped successfully at time of task execution.',
    dispute: 'Multiple prices in the CSV are wrong. We spot-checked 10 items and 4 had incorrect prices. This dataset is unreliable.',
    // Ambiguous: prices may have changed after scraping, or scraping error
  },
  {
    label: 'interpretation_dispute',
    requirements: 'Analyze user feedback data and identify the top 3 pain points.',
    delivery: 'Analysis complete. Top 3 pain points: (1) slow loading times, (2) confusing navigation, (3) lack of mobile support. Supporting data and frequency counts included.',
    dispute: 'The analysis only looked at quantitative mentions. We needed qualitative sentiment analysis with emotional intensity scoring.',
    // Ambiguous: "analyze" and "identify pain points" is open to interpretation
  },
  {
    label: 'technical_integration_issue',
    requirements: 'Set up automated email notifications using our existing SendGrid account for user signup events. Provide working code and documentation.',
    delivery: 'Complete implementation delivered. Node.js integration code with full documentation. Tested successfully in isolated environment.',
    dispute: 'The code does not work in our production environment. We get authentication errors with SendGrid.',
    // Ambiguous: could be environment config issue or code bug
  },
  {
    label: 'incomplete_but_usable',
    requirements: 'Create a sentiment analysis model trained on our 50,000-record customer review dataset. Target accuracy: 85%+.',
    delivery: 'Model delivered. Achieved 78% accuracy on validation set. Documentation includes current limitations and suggested improvements to reach 85% with additional training data.',
    dispute: 'The model did not meet the 85% accuracy requirement. We cannot use a model that misses the spec by 7 percentage points.',
    // Ambiguous: seller delivered a working model but missed the spec
  },

  // ── Edge cases ──────────────────────────────────────────────────────────────
  {
    label: 'force_majeure_claim',
    requirements: 'Process batch of 500 legal documents and extract clause types within 6 hours.',
    delivery: 'Processing interrupted at 340 documents due to critical API outage on our processing infrastructure. 340 out of 500 documents completed and delivered.',
    dispute: 'We needed all 500 documents processed. The partial delivery is not acceptable for our legal deadline.',
    // Complex: partial delivery due to infrastructure issue
  },
  {
    label: 'version_mismatch',
    requirements: 'Update our codebase from React 17 to React 18. Ensure all existing tests pass.',
    delivery: 'Migration complete. All 47 existing tests pass. Updated dependencies and resolved breaking changes in concurrent mode. Detailed migration notes included.',
    dispute: 'The upgrade introduced a visual regression in our custom DatePicker component that was not caught by tests. We have to roll back.',
    // Seller wins: delivered exactly what was asked (tests pass), undiscovered visual regression is a different issue
  },
  {
    label: 'evidence_of_delivered_work',
    requirements: 'Conduct competitor analysis across 10 SaaS companies in the project management space. Minimum 5 data points per company.',
    delivery: 'Analysis complete. 10-company report with 8-12 data points each, covering pricing, features, customer segments, integrations, and recent news. 47-page PDF delivered.',
    dispute: 'The competitor analysis is outdated. Some pricing data is 3 months old.',
    // Seller wins: delivered comprehensive work, some data staleness is unavoidable in competitive research
  },
  {
    label: 'communication_breakdown',
    requirements: 'Write API documentation for 15 endpoints. Include request/response examples, error codes, and authentication details.',
    delivery: 'Documentation delivered for 15 endpoints. All include request/response examples and error codes. Authentication section covers API key usage.',
    dispute: 'The documentation does not cover OAuth 2.0 flow which is our primary auth method. We specified authentication details.',
    // Ambiguous: "authentication details" could mean either API key or OAuth
  },
  {
    label: 'revision_limit_exceeded',
    requirements: 'Design a landing page wireframe. Includes up to 2 revisions based on feedback.',
    delivery: 'Wireframe v1 delivered. Revised to v2 after feedback. Revised to v3 after second feedback round. Delivered final v3.',
    dispute: 'Version 3 still does not match our vision. We want another round of changes.',
    // Seller wins: fulfilled contract (2 revisions), additional work is out of scope
  },
  {
    label: 'data_privacy_redaction',
    requirements: 'Redact all PII (names, emails, phone numbers) from 200 customer support transcripts.',
    delivery: 'All 200 transcripts processed. PII identified and redacted with [REDACTED] placeholders. Automated + manual verification applied.',
    dispute: 'We found 3 transcripts where first names were not fully redacted. This is a compliance risk.',
    // Ambiguous: 98.5% accuracy — is that sufficient for "all" PII?
  },
  {
    label: 'output_format_ambiguity',
    requirements: 'Convert 50 audio interview recordings to text transcripts.',
    delivery: 'All 50 transcripts delivered in .txt format. Speaker labels added (Speaker A/B). Timestamps included every 30 seconds.',
    dispute: 'We needed Word documents (.docx) with formatted styling, not plain text files. We cannot use these in our workflow.',
    // Ambiguous: "transcripts" format not specified in requirements
  },
  {
    label: 'api_downtime_during_task',
    requirements: 'Fetch real-time exchange rates for 50 currency pairs and provide a formatted spreadsheet.',
    delivery: 'Spreadsheet delivered with all 50 currency pairs. Note: 8 pairs were unavailable due to source API maintenance window at time of execution; marked as N/A with timestamp.',
    dispute: 'We paid for 50 complete data points. Getting N/A for 16% of the dataset is not acceptable.',
    // Complex: external dependency failure
  },
  {
    label: 'file_corruption_dispute',
    requirements: 'Edit and export a 45-minute video with specified cuts, transitions, and audio sync.',
    delivery: 'Video editing complete. 45-minute export delivered in H.264 format, 1080p, all specified cuts and transitions applied.',
    dispute: 'The delivered video file is corrupted and will not play on our media server. We cannot verify the work.',
    // Complex: could be upload/transfer corruption, not editing fault
  },
  {
    label: 'scope_creep_by_buyer',
    requirements: 'Write unit tests for the provided authentication module (3 functions).',
    delivery: '18 unit tests delivered covering all 3 functions: login(), logout(), refreshToken(). Tests pass in Jest. Coverage: 94%.',
    dispute: 'The tests do not cover integration scenarios with our database layer or the full authentication flow. We expected end-to-end test coverage.',
    // Seller wins: delivered exactly what was specified (unit tests for 3 functions)
  },
  {
    label: 'language_quality_dispute',
    requirements: 'Proofread and correct grammar in a 10,000-word English business report.',
    delivery: 'Proofreading complete. 127 grammar corrections, 43 punctuation fixes, 12 sentence restructuring suggestions. Tracked changes provided.',
    dispute: 'The corrected report still reads awkwardly in several sections. The language does not sound natural to a native English speaker.',
    // Ambiguous: grammar vs. style is a gray area
  },
  {
    label: 'duplicate_submission_by_seller',
    requirements: 'Generate 20 unique marketing taglines for a cybersecurity product targeting enterprise clients.',
    delivery: '20 taglines delivered: "Security Without Compromise", "Defend the Future", "Trust in Every Transaction"... [continues with 20 items].',
    dispute: 'Several taglines are nearly identical variations of the same concept. "Defend the Future", "Secure Your Future", and "Protect Tomorrow" are essentially the same idea. This is not 20 unique concepts.',
    // Ambiguous: similar themes vs. true duplicates
  },
  {
    label: 'currency_of_information',
    requirements: 'Research and summarize the current regulatory landscape for cryptocurrency in 5 jurisdictions: US, EU, UK, Singapore, Japan.',
    delivery: 'Comprehensive 30-page regulatory report delivered. Covers current rules, pending legislation, and enforcement trends for all 5 jurisdictions.',
    dispute: 'The report does not mention the EU MiCA regulation which came into effect this year. The information is outdated.',
    // Complex: recency depends on when task was created vs. regulation changes
  },
  {
    label: 'model_overfitting',
    requirements: 'Train a machine learning classifier to predict customer churn on our dataset. Must achieve >90% precision on test set.',
    delivery: 'Model trained and delivered. Achieves 94% precision on provided test set. Model weights and inference code included.',
    dispute: 'The model is overfit to our test data. When we applied it to new production data, precision dropped to 61%. The model is not usable.',
    // Complex: overfitting — seller met the stated metric but model fails in practice
  },
];

async function runArbitrationCase(sellerKey, buyerKey, serviceId, i) {
  const scenario = DISPUTE_SCENARIOS[i % DISPUTE_SCENARIOS.length];
  try {
    // 1. Create escrow
    const order = await api('/orders', {
      method: 'POST',
      body: {
        service_id: serviceId,
        requirements: scenario.requirements || `${scenario.label}: Deliver according to standard specifications.`,
      },
    }, buyerKey);
    await sleep(DELAY_MS);

    // 2. Deliver (intentionally problematic)
    await api(`/orders/${order.id}/deliver`, {
      method: 'POST',
      body: { content: scenario.delivery },
    }, sellerKey);
    await sleep(DELAY_MS);

    // 3. Dispute
    await api(`/orders/${order.id}/dispute`, {
      method: 'POST',
      body: { reason: scenario.dispute },
    }, buyerKey);
    await sleep(DELAY_MS);

    // 4. AI arbitration
    const verdict = await api(`/orders/${order.id}/auto-arbitrate`, {
      method: 'POST',
      body: {},
    }, sellerKey);
    await sleep(DELAY_MS);

    stats.arbitrations_completed++;
    const winner = verdict.winner || verdict.verdict?.winner || '?';
    const confidence = verdict.confidence || verdict.verdict?.confidence || '?';
    process.stdout.write(`[${winner[0].toUpperCase()}${Math.round(parseFloat(confidence) * 100) || '?'}]`);
    return { order_id: order.id, scenario: scenario.label, winner, confidence };
  } catch (e) {
    stats.arbitrations_failed++;
    if (e.message.includes('503') || e.message.includes('ANTHROPIC_API_KEY')) {
      console.log('\n  [!] ANTHROPIC_API_KEY not set on Render. Arbitration cases skipped.');
      console.log('      Set it at: Render → Your Service → Environment → Add ANTHROPIC_API_KEY');
      throw new Error('NO_API_KEY');
    }
    process.stdout.write('e');
    return null;
  }
}

// ── Scenario: Spot escrow ─────────────────────────────────────────────────────
async function runSpotEscrow(sellerKey, buyerKey, sellerId, i) {
  try {
    const order = await api('/orders/spot', {
      method: 'POST',
      body: {
        to_agent_id: sellerId,
        amount: 0.25 + (i % 5) * 0.25,
        title: `Spot task #${i}: quick data lookup`,
        requirements: `Retrieve pricing data for product SKU-${1000 + i}`,
      },
    }, buyerKey);
    await sleep(DELAY_MS);

    await api(`/orders/${order.id}/deliver`, {
      method: 'POST',
      body: { content: `SKU-${1000 + i} price: $${(12.99 + i * 0.5).toFixed(2)}, stock: ${50 + i} units.` },
    }, sellerKey);
    await sleep(DELAY_MS);

    await api(`/orders/${order.id}/confirm`, { method: 'POST', body: {} }, buyerKey);
    await sleep(DELAY_MS);

    stats.spot_escrows++;
    process.stdout.write('s');
    return order.id;
  } catch (e) {
    process.stdout.write('e');
    console.log(`\n  [spot error #${i}] ${e.message}`);
    return null;
  }
}

// ── Scenario: Counter-offer negotiation ──────────────────────────────────────
async function runCounterOffer(sellerKey, buyerKey, serviceId, i) {
  try {
    const order = await api('/orders', {
      method: 'POST',
      body: {
        service_id: serviceId,
        requirements: `Counter-offer seed #${i}: partial work expected`,
      },
    }, buyerKey);
    await sleep(DELAY_MS);

    await api(`/orders/${order.id}/deliver`, {
      method: 'POST',
      body: { content: `Partial delivery #${i}: completed 60% of the task. Remaining items require clarification.` },
    }, sellerKey);
    await sleep(DELAY_MS);

    await api(`/orders/${order.id}/dispute`, {
      method: 'POST',
      body: { reason: 'Delivery is incomplete. Only 60% was done.' },
    }, buyerKey);
    await sleep(DELAY_MS);

    // Seller proposes counter-offer (partial refund)
    const orderData = await api(`/orders/${order.id}`, {}, buyerKey);
    const refundAmount = parseFloat(orderData.amount || orderData.amount_usdc || 1) * 0.4;

    await api(`/orders/${order.id}/counter-offer`, {
      method: 'POST',
      body: {
        refund_amount: parseFloat(refundAmount.toFixed(2)),
        note: `I completed 60% of the work. Proposing a 40% refund as fair resolution.`,
      },
    }, sellerKey);
    await sleep(DELAY_MS);

    // Buyer accepts
    await api(`/orders/${order.id}/counter-offer/accept`, { method: 'POST', body: {} }, buyerKey);
    await sleep(DELAY_MS);

    stats.counter_offers++;
    process.stdout.write('n');
    return order.id;
  } catch (e) {
    process.stdout.write('e');
    console.log(`\n  [counter error #${i}] ${e.message}`);
    return null;
  }
}

// ── Scenario: Partial confirm (milestone) ────────────────────────────────────
async function runPartialConfirm(sellerKey, buyerKey, serviceId, i) {
  try {
    const order = await api('/orders', {
      method: 'POST',
      body: {
        service_id: serviceId,
        requirements: `Milestone task #${i}: deliver in two phases`,
      },
    }, buyerKey);
    await sleep(DELAY_MS);

    await api(`/orders/${order.id}/deliver`, {
      method: 'POST',
      body: { content: `Phase 1 of 2 delivered for task #${i}. Data collection complete. Analysis pending.` },
    }, sellerKey);
    await sleep(DELAY_MS);

    // Partial confirm: release 60%
    await api(`/orders/${order.id}/partial-confirm`, {
      method: 'POST',
      body: { percent: 60, note: 'Phase 1 accepted. Releasing 60% for completed work.' },
    }, buyerKey);
    await sleep(DELAY_MS);

    stats.partial_confirms++;
    process.stdout.write('p');
    return order.id;
  } catch (e) {
    process.stdout.write('e');
    console.log(`\n  [partial error #${i}] ${e.message}`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Arbitova Seed Transaction Script       ║');
  console.log('║   Building arbitration case library...   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  Mode: ${ARBITRATION_ONLY ? 'Arbitration only' : TRADES_ONLY ? 'Trades only' : 'Full suite'}`);
  console.log(`  Target trades:        ${TRADE_COUNT}`);
  console.log(`  Target arbitrations:  ${ARBITRATION_COUNT}`);
  console.log('');

  // Setup
  const { seller, buyer } = await setupAgents();
  await topUp(seller.api_key, 5000);
  await topUp(buyer.api_key, 5000);

  const services = await setupServices(seller.api_key);
  if (!services.length) { console.log('No services created. Aborting.'); return; }

  const svcId = services[0].id;
  const svcIdData = (services[1] || services[0]).id;

  // ── Normal trades ──────────────────────────────────────────────────────────
  if (!ARBITRATION_ONLY) {
    const normalCount = Math.round(TRADE_COUNT * 0.6);
    console.log(`\nRunning ${normalCount} normal trades (escrow→deliver→confirm)...`);
    for (let i = 0; i < normalCount; i++) {
      await runNormalTrade(seller.api_key, buyer.api_key, svcId, i);
      await sleep(DELAY_MS);
    }

    // Spot escrows
    const spotCount = Math.round(TRADE_COUNT * 0.2);
    console.log(`\nRunning ${spotCount} spot escrows...`);
    for (let i = 0; i < spotCount; i++) {
      await runSpotEscrow(seller.api_key, buyer.api_key, seller.id, i);
      await sleep(DELAY_MS);
    }

    // Counter-offer negotiations
    const counterCount = Math.round(TRADE_COUNT * 0.1);
    console.log(`\nRunning ${counterCount} counter-offer negotiations...`);
    for (let i = 0; i < counterCount; i++) {
      await runCounterOffer(seller.api_key, buyer.api_key, svcId, i);
      await sleep(DELAY_MS);
    }

    // Partial confirms
    const partialCount = Math.round(TRADE_COUNT * 0.1);
    console.log(`\nRunning ${partialCount} partial confirms (milestone)...`);
    for (let i = 0; i < partialCount; i++) {
      await runPartialConfirm(seller.api_key, buyer.api_key, svcIdData, i);
      await sleep(DELAY_MS);
    }
  }

  // ── Arbitration cases ──────────────────────────────────────────────────────
  if (!TRADES_ONLY) {
    console.log(`\nRunning ${ARBITRATION_COUNT} arbitration cases...`);
    console.log('  Legend: [Bxx]=Buyer wins xx% confidence  [Sxx]=Seller wins  e=error\n');
    const verdicts = [];
    for (let i = 0; i < ARBITRATION_COUNT; i++) {
      try {
        const result = await runArbitrationCase(seller.api_key, buyer.api_key, svcId, i);
        if (result) verdicts.push(result);
      } catch (e) {
        if (e.message === 'NO_API_KEY') break;
      }
      await sleep(DELAY_MS);
    }

    if (verdicts.length) {
      const buyerWins = verdicts.filter(v => v.winner === 'buyer').length;
      const sellerWins = verdicts.filter(v => v.winner === 'seller').length;
      console.log(`\n\n  Arbitration summary: ${buyerWins} buyer wins / ${sellerWins} seller wins`);
    }
  }

  printStats();
  console.log('  Seller API key:', seller.api_key);
  console.log('  Buyer  API key:', buyer.api_key);
  console.log('\n  Done. Check your platform at:');
  console.log('  https://a2a-system.onrender.com/docs\n');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  printStats();
  process.exit(1);
});
