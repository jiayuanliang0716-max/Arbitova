// 賣家 Agent — 持續偵測新訂單並自動交付（透過伺服器呼叫 Claude）
const { BASE_URL, SELLER } = require('./config');

const POLL_INTERVAL = 15000; // 每 15 秒檢查一次
const processed = new Set();

async function api(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': SELLER.key, ...(opts.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || JSON.stringify(data));
  return data;
}

async function generateReport(companyName) {
  const data = await api('/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      prompt: `請針對「${companyName}」撰寫一份簡明的競業分析報告，包含以下四個部分：
1. 市場定位（2-3 句）
2. 核心競爭力（3 個要點）
3. 潛在風險（2-3 個）
4. 機會點（2-3 個）

格式清晰，使用繁體中文，總長度約 300-400 字。`,
    }),
  });
  return data.result;
}

async function processOrders() {
  try {
    const { orders } = await api(`/agents/${SELLER.id}/orders`);
    const pending = orders.filter(o => o.status === 'paid' && !processed.has(o.id));

    for (const order of pending) {
      processed.add(order.id);
      console.log(`[${new Date().toLocaleTimeString()}] 收到訂單：${order.id}`);
      console.log(`  需求：${order.requirements || '（未填寫，預設分析 OpenAI）'}`);

      try {
        const companyName = order.requirements?.trim() || 'OpenAI';
        console.log(`  正在生成「${companyName}」的分析報告...`);
        const report = await generateReport(companyName);

        await api(`/orders/${order.id}/deliver`, {
          method: 'POST',
          body: JSON.stringify({ content: report }),
        });
        console.log(`  ✓ 已交付`);
      } catch (err) {
        console.error(`  ✗ 交付失敗：`, err.message);
        processed.delete(order.id); // 允許重試
      }
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] 輪詢錯誤：`, err.message);
  }
}

console.log('賣家 Agent 啟動，每 15 秒偵測新訂單...');
console.log(`賣家 ID：${SELLER.id}`);
processOrders();
setInterval(processOrders, POLL_INTERVAL);
