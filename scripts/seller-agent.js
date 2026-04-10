// Seller Agent — auto-registers services and fulfills orders via Claude
const { BASE_URL, SELLER } = require('./config');

const POLL_INTERVAL = 15000;
const processed = new Set();

// Services this agent offers
const MY_SERVICES = [
  {
    name: '每日股價 Alert',
    description: '訂閱後每天自動推播你指定股票的技術分析 Alert，包含當日趨勢、關鍵價位與操作建議。下單時填入股票代號（例如：TSLA）。',
    price: 1.00,
    delivery_hours: 1,
    sub_interval: 'daily',
    sub_price: 0.50,
    promptFn: (req) => `請針對股票「${req || 'TSLA'}」生成今日簡短 Alert 通知，格式如下：

📊 ${req || 'TSLA'} 每日 Alert

趨勢：（多頭/空頭/盤整，一句話）
今日關鍵支撐：$XXX
今日關鍵壓力：$XXX
操作建議：（買入觀望賣出，一句話）
風險提示：（一句話）

簡潔有力，適合快速閱讀，使用繁體中文。`,
  },
  {
    name: '競業分析報告',
    description: '輸入公司名稱，AI 自動生成競業分析報告，包含市場定位、核心競爭力、潛在風險與機會點。',
    price: 2.00,
    delivery_hours: 1,
    promptFn: (req) => `請針對「${req || 'OpenAI'}」撰寫一份簡明的競業分析報告，包含以下四個部分：
1. 市場定位（2-3 句）
2. 核心競爭力（3 個要點）
3. 潛在風險（2-3 個）
4. 機會點（2-3 個）
格式清晰，使用繁體中文，總長度約 300-400 字。`,
  },
  {
    name: '股價技術分析報告',
    description: '輸入股票代號（例如：TSLA、AAPL、2330），AI 生成技術分析報告，包含趨勢判斷、支撐壓力位、操作建議。',
    price: 2.00,
    delivery_hours: 1,
    promptFn: (req) => `請針對股票「${req || 'TSLA'}」撰寫一份技術分析報告，包含以下部分：
1. 近期趨勢判斷（多頭/空頭/盤整，2-3 句）
2. 關鍵支撐與壓力位（各列 2 個價位）
3. 成交量觀察（1-2 句）
4. 短線操作建議（買入/觀望/賣出，附理由）
5. 風險提示（1-2 句）
注意：本報告僅供參考，不構成投資建議。使用繁體中文，總長度約 300-400 字。`,
  },
  {
    name: '文章摘要服務',
    description: '貼上任意文章或文字內容，AI 自動生成重點摘要，包含核心論點、關鍵數據與結論。',
    price: 1.00,
    delivery_hours: 1,
    promptFn: (req) => `請將以下內容整理成一份清晰的摘要報告：

${req || '（未提供內容）'}

摘要格式：
1. 核心主題（1 句）
2. 重點條列（3-5 個要點）
3. 關鍵數據或事實（如有）
4. 結論（1-2 句）
使用繁體中文，簡潔清楚。`,
  },
];

async function api(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': SELLER.key, ...(opts.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || JSON.stringify(data));
  return data;
}

// Auto-register services if not already listed
async function ensureServicesRegistered() {
  try {
    const { services } = await api(`/services/search?sort=reputation`);
    const myServices = services.filter(s => s.agent_id === SELLER.id);
    const myNames = new Set(myServices.map(s => s.name));

    for (const svc of MY_SERVICES) {
      if (myNames.has(svc.name)) {
        console.log(`[setup] 服務已存在：${svc.name}`);
      } else {
        const body = {
          name: svc.name,
          description: svc.description,
          price: svc.price,
          delivery_hours: svc.delivery_hours,
          market_type: 'a2a',
        };
        if (svc.sub_interval) body.sub_interval = svc.sub_interval;
        if (svc.sub_price)    body.sub_price    = svc.sub_price;
        const r = await api('/services', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        console.log(`[setup] 上架成功：${svc.name} (ID: ${r.id})`);
      }
    }
  } catch (err) {
    console.error('[setup] 上架失敗：', err.message);
  }
}

async function generateReport(prompt) {
  const data = await api('/api/generate', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
  return data.result;
}

// Match order to service definition by service name
async function getServiceDef(serviceId) {
  try {
    const { services } = await api(`/services/search?sort=reputation`);
    const svc = services.find(s => s.id === serviceId);
    if (!svc) return null;
    return MY_SERVICES.find(d => d.name === svc.name) || null;
  } catch { return null; }
}

async function processOrders() {
  try {
    const { orders } = await api(`/agents/${SELLER.id}/orders`);
    const pending = orders.filter(o => o.status === 'paid' && !processed.has(o.id));

    for (const order of pending) {
      processed.add(order.id);
      console.log(`[${new Date().toLocaleTimeString()}] 收到訂單：${order.id}`);
      console.log(`  服務：${order.service_name}`);
      console.log(`  需求：${order.requirements || '（未填寫）'}`);

      try {
        const def = await getServiceDef(order.service_id);
        const prompt = def
          ? def.promptFn(order.requirements?.trim())
          : `請根據以下需求提供服務：${order.requirements || '（未填寫需求）'}`;

        console.log(`  生成中...`);
        const report = await generateReport(prompt);

        await api(`/orders/${order.id}/deliver`, {
          method: 'POST',
          body: JSON.stringify({ content: report }),
        });
        console.log(`  ✓ 已交付`);
      } catch (err) {
        console.error(`  ✗ 交付失敗：`, err.message);
        processed.delete(order.id);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] 輪詢錯誤：`, err.message);
  }
}

async function main() {
  console.log('=== Seller Agent 啟動 ===');
  console.log(`賣家 ID：${SELLER.id}`);
  console.log('');
  console.log('[setup] 檢查服務上架狀態...');
  await ensureServicesRegistered();
  console.log('');
  console.log('開始偵測訂單，每 15 秒檢查一次...');
  processOrders();
  setInterval(processOrders, POLL_INTERVAL);
}

main().catch(console.error);
