/**
 * 自動迭代腳本
 * 每次執行：讀取待處理 Telegram 指令 → 更新 MISSION.md → 通知 Claude Code 繼續
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PROJECT_DIR = __dirname;

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg })
  });
}

async function getPendingCommands() {
  try {
    const r = await fetch('https://a2a-system.onrender.com/telegram/commands');
    const data = await r.json();
    return data.commands || [];
  } catch (e) {
    return [];
  }
}

async function markDone(id) {
  await fetch(`https://a2a-system.onrender.com/telegram/commands/${id}/done`, {
    method: 'POST'
  });
}

async function main() {
  console.log('[迭代開始]', new Date().toISOString());

  // 讀取待處理指令
  const commands = await getPendingCommands();

  let shouldPause = false;
  let directives = [];

  for (const cmd of commands) {
    if (cmd.command === 'PAUSE') {
      shouldPause = true;
      await markDone(cmd.id);
      await sendTelegram('⏸ 已暫停自動迭代。發送「繼續」重新啟動。');
    } else if (cmd.command === 'RESUME') {
      shouldPause = false;
      await markDone(cmd.id);
      await sendTelegram('▶️ 繼續執行中...');
    } else if (cmd.command === 'STATUS') {
      const progress = fs.readFileSync(path.join(PROJECT_DIR, 'PROGRESS.md'), 'utf8');
      const summary = progress.split('\n').slice(0, 20).join('\n');
      await sendTelegram('📊 目前進度：\n\n' + summary);
      await markDone(cmd.id);
    } else if (cmd.command.startsWith('DIRECTIVE:')) {
      directives.push(cmd.command.replace('DIRECTIVE:', ''));
      await markDone(cmd.id);
    }
  }

  if (shouldPause) {
    console.log('[暫停] 收到暫停指令，停止迭代');
    process.exit(0);
  }

  // 如果有新指令，更新 MISSION.md
  if (directives.length > 0) {
    const missionPath = path.join(PROJECT_DIR, 'MISSION.md');
    const mission = fs.readFileSync(missionPath, 'utf8');
    const updated = mission + '\n\n## 用戶最新指令（' + new Date().toLocaleString('zh-TW') + '）\n' +
      directives.map(d => '- ' + d).join('\n');
    fs.writeFileSync(missionPath, updated);
    await sendTelegram('📝 已更新任務方向：\n' + directives.join('\n'));
  }

  console.log('[迭代完成]');
}

main().catch(async (err) => {
  console.error(err);
  await sendTelegram('❌ 迭代腳本錯誤：' + err.message);
});
