const { BASE_URL, BUYER } = require('./config');

async function main() {
  const r = await fetch(`${BASE_URL}/agents/${BUYER.id}/orders`, {
    headers: { 'X-API-Key': BUYER.key }
  });
  const d = await r.json();
  const order = d.orders.find(x => x.status === 'delivered');

  if (!order) {
    console.log('找不到待確認的訂單，目前狀態：');
    d.orders.slice(0, 5).forEach(o => console.log(' -', o.id.slice(0,8), o.status));
    return;
  }

  console.log('找到已交付訂單：', order.id);
  console.log('確認收款中...');

  const c = await fetch(`${BASE_URL}/orders/${order.id}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': BUYER.key }
  });
  const result = await c.json();

  if (!c.ok) { console.error('確認失敗：', result); return; }
  console.log('');
  console.log('交易完成！');
  console.log('賣家收到：', result.seller_received, 'USDC');
  console.log('平台手續費：', result.platform_fee, 'USDC');
}

main().catch(console.error);
