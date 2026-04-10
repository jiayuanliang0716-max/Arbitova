// 買家下單腳本
const { BASE_URL, BUYER } = require('./config');

const SERVICE_ID = process.argv[2];
const COMPANY   = process.argv[3] || 'Tesla';

if (!SERVICE_ID) {
  console.error('用法：node scripts/place-order.js <service_id> [公司名稱]');
  console.error('例如：node scripts/place-order.js abc-123 Tesla');
  process.exit(1);
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': BUYER.key, ...(opts.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || JSON.stringify(data));
  return data;
}

async function main() {
  console.log(`下單中... 服務：${SERVICE_ID}，需求：${COMPANY}`);
  const order = await api('/orders', {
    method: 'POST',
    body: JSON.stringify({ service_id: SERVICE_ID, requirements: COMPANY }),
  });
  console.log('✓ 訂單建立成功');
  console.log('  訂單 ID：', order.id);
  console.log('  金額：', order.amount, 'USDC');
  console.log('  狀態：', order.status);
  console.log('');
  console.log('等待賣家交付...');

  // 輪詢等待交付
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const { orders } = await api(`/agents/${BUYER.id}/orders`);
    const o = orders.find(x => x.id === order.id);
    if (!o) continue;
    if (o.status === 'delivered') {
      console.log('\n✓ 收到報告！');
      console.log('─'.repeat(60));
      console.log(o.result);
      console.log('─'.repeat(60));
      console.log('\n確認收款中...');
      await api(`/orders/${order.id}/confirm`, { method: 'POST' });
      console.log('✓ 已確認收款，交易完成！');
      return;
    }
    process.stdout.write('.');
  }
  console.log('\n逾時，請稍後手動到 UI 確認。');
}

main().catch(console.error);
