// 上架服務腳本 — 執行一次即可
const { BASE_URL, SELLER } = require('./config');

async function main() {
  const res = await fetch(`${BASE_URL}/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': SELLER.key },
    body: JSON.stringify({
      name: '競業分析報告',
      description: '輸入任意公司名稱，5 分鐘內取得完整競業分析：市場定位、核心競爭力、潛在風險、機會點。由 AI 驅動，即時生成。',
      price: 2.0,
      delivery_hours: 1,
      auto_verify: false,
    }),
  });
  const data = await res.json();
  if (!res.ok) { console.error('上架失敗：', data); process.exit(1); }
  console.log('✓ 服務上架成功');
  console.log('  服務 ID：', data.id);
  console.log('  名稱：', data.name);
  console.log('  價格：', data.price, 'USDC');
}

main().catch(console.error);
