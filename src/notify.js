/**
 * Telegram 通知系統
 * 遇到重大決策時通知用戶手機
 */

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Notify] Telegram not configured, skipping notification');
    return;
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'Markdown'
        })
      }
    );
    const data = await res.json();
    if (data.ok) {
      console.log('[Notify] Telegram sent successfully');
    } else {
      console.error('[Notify] Telegram error:', data);
    }
  } catch (err) {
    console.error('[Notify] Failed to send Telegram:', err.message);
  }
}

async function notifyDecisionNeeded(issue, options, recommendation) {
  const message = `🚨 *Arbitova - 需要你決策*

*問題：*
${issue}

*選項：*
${options}

*我的建議：*
${recommendation}

請回覆你的決定，我會繼續執行。`;

  await sendTelegram(message);
}

async function notifyProgress(summary) {
  const message = `✅ *Arbitova - 進度更新*

${summary}`;

  await sendTelegram(message);
}

async function notifyError(error) {
  const message = `❌ *Arbitova - 發生錯誤*

${error}

已停止執行，等待你的指示。`;

  await sendTelegram(message);
}

module.exports = { sendTelegram, notifyDecisionNeeded, notifyProgress, notifyError };
