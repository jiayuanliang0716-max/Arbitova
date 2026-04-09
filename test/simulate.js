/**
 * A2A 第一筆交易模擬測試
 *
 * 場景：
 *   Agent B（數據分析 Agent）上架「競品分析報告」服務
 *   Agent A（內容行銷 Agent）搜尋並購買該服務
 *   Agent B 交付報告
 *   Agent A 確認完成，款項釋放
 */

const BASE_URL = 'http://localhost:3000';

async function call(method, path, body, apiKey) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey && { 'X-API-Key': apiKey })
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} failed: ${JSON.stringify(data)}`);
  return data;
}

function log(step, data) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`STEP ${step}`);
  console.log('='.repeat(60));
  console.log(JSON.stringify(data, null, 2));
}

async function simulate() {
  console.log('\nA2A Trading System — First Transaction Simulation\n');

  // Step 1: 註冊 Agent B（賣家）
  const agentB = await call('POST', '/agents/register', {
    name: 'DataAnalysis Agent',
    description: 'Specialized in competitive analysis and market research',
    owner_email: 'seller@example.com'
  });
  log('1 — Agent B (Seller) Registered', {
    id: agentB.id,
    name: agentB.name,
    balance: agentB.balance,
    api_key: agentB.api_key
  });

  // Step 2: 註冊 Agent A（買家）
  const agentA = await call('POST', '/agents/register', {
    name: 'ContentMarketing Agent',
    description: 'Content strategy and marketing automation',
    owner_email: 'buyer@example.com'
  });
  log('2 — Agent A (Buyer) Registered', {
    id: agentA.id,
    name: agentA.name,
    balance: agentA.balance,
    api_key: agentA.api_key
  });

  // Step 3: Agent B 上架服務
  const service = await call('POST', '/services', {
    name: 'Competitive Analysis Report',
    description: 'In-depth analysis of top 5 competitors including pricing, positioning, and strategy',
    price: 1.0,
    delivery_hours: 24
  }, agentB.api_key);
  log('3 — Agent B Lists Service', service);

  // Step 4: Agent A 搜尋服務
  const searchResult = await call('GET', '/services/search?q=competitive', null, null);
  log('4 — Agent A Searches for Services', {
    count: searchResult.count,
    first_result: searchResult.services[0]
  });

  // Step 5: Agent A 建立訂單（付款鎖定）
  const order = await call('POST', '/orders', {
    service_id: service.id,
    requirements: 'Focus on SaaS competitors in the AI agent market. Include pricing tables.'
  }, agentA.api_key);
  log('5 — Agent A Creates Order (Funds Locked)', order);

  // 確認買家餘額已扣除
  const buyerAfterPay = await call('GET', `/agents/${agentA.id}`, null, agentA.api_key);
  console.log(`\n   Agent A balance after payment: ${buyerAfterPay.balance} USDC (escrow: ${buyerAfterPay.escrow})`);

  // Step 6: Agent B 交付服務
  const delivery = await call('POST', `/orders/${order.id}/deliver`, {
    content: `# Competitive Analysis Report

## Executive Summary
Analysis of top 5 competitors in the AI Agent market.

## Competitors Analyzed
1. AutoGPT — Open source, free tier, $20/mo pro
2. AgentGPT — $29/mo, focus on web automation
3. LangChain Cloud — $0.01/1k tokens, developer-focused
4. Fixie.ai — $49/mo, enterprise focus
5. Relevance AI — $19/mo, no-code agent builder

## Key Findings
- Price range: $0 - $49/month
- All competitors lack agent-to-agent payment infrastructure
- Opportunity: B2B agent marketplace is completely unaddressed

## Recommendation
Position as infrastructure layer, not end-user product.`
  }, agentB.api_key);
  log('6 — Agent B Delivers Service', delivery);

  // Step 7: Agent A 確認完成，款項釋放
  const completion = await call('POST', `/orders/${order.id}/confirm`, null, agentA.api_key);
  log('7 — Agent A Confirms Completion (Funds Released)', completion);

  // 最終狀態確認
  const sellerFinal = await call('GET', `/agents/${agentB.id}`, null, agentB.api_key);
  const buyerFinal = await call('GET', `/agents/${agentA.id}`, null, agentA.api_key);

  console.log('\n' + '='.repeat(60));
  console.log('TRANSACTION COMPLETE — FINAL STATE');
  console.log('='.repeat(60));
  console.log(`Agent A (Buyer)  balance: ${buyerFinal.balance} USDC`);
  console.log(`Agent B (Seller) balance: ${sellerFinal.balance} USDC`);
  console.log(`Platform fee collected: ${completion.platform_fee} USDC`);
  console.log('\nFirst A2A transaction succeeded.');
}

simulate().catch(err => {
  console.error('\nSimulation failed:', err.message);
  process.exit(1);
});
