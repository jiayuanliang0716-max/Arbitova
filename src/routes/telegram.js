const express = require('express');
const { dbRun, dbAll } = require('../db/helpers');
const { sendTelegram } = require('../notify');

const router = express.Router();
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

// Telegram webhook — 接收你的訊息
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // 先回 200，避免 Telegram 重試

  try {
    const message = req.body?.message;
    if (!message) return;

    const chatId = String(message.chat?.id);
    const text = message.text?.trim();

    // 只接受你自己的訊息
    if (chatId !== String(CHAT_ID)) return;

    const lower = text?.toLowerCase();

    // 即時回應指令
    if (lower === '暫停' || lower === 'pause' || lower === 'stop') {
      await dbRun(`INSERT INTO telegram_commands (command) VALUES (${p(1)})`, ['PAUSE']);
      await sendTelegram('⏸ 收到「暫停」指令，下次迭代結束後停止。');

    } else if (lower === '繼續' || lower === 'continue' || lower === 'resume') {
      await dbRun(`INSERT INTO telegram_commands (command) VALUES (${p(1)})`, ['RESUME']);
      await sendTelegram('▶️ 收到「繼續」指令，下次迭代將繼續執行。');

    } else if (lower === '狀態' || lower === 'status' || lower === '現在做到哪') {
      await dbRun(`INSERT INTO telegram_commands (command) VALUES (${p(1)})`, ['STATUS']);
      await sendTelegram('📊 收到，下次迭代時會回報目前進度。');

    } else if (text) {
      // 其他文字當作方向指令
      await dbRun(`INSERT INTO telegram_commands (command) VALUES (${p(1)})`, [`DIRECTIVE:${text}`]);
      await sendTelegram(`📝 收到指令：「${text}」\n下次迭代時執行。`);
    }
  } catch (err) {
    console.error('[Telegram webhook error]', err.message);
  }
});

// 查詢待處理指令（給 Claude Code 自動迭代用）
router.get('/commands', async (req, res) => {
  try {
    const commands = await dbAll(
      `SELECT * FROM telegram_commands WHERE status = ${p(1)} ORDER BY created_at ASC`,
      ['pending']
    );
    res.json({ commands });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 標記指令為已處理
router.post('/commands/:id/done', async (req, res) => {
  try {
    const now = isPostgres ? 'NOW()' : "datetime('now')";
    await dbRun(
      `UPDATE telegram_commands SET status = 'processed', processed_at = ${now} WHERE id = ${p(1)}`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
