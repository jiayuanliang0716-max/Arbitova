# Arbitova UI/Dashboard 全面重構計畫書

**版本：** 1.0  
**日期：** 2026-04-12  
**視角框架：** 世界頂級軟體工程師 + AI 產品負責人 + 網路商業執行長  

---

## 一、現況診斷

### 1.1 現有前端結構

| 檔案 | 功能 | 問題 |
|------|------|------|
| `public/index.html` | 主頁 + 登入後 Dashboard | 同一檔案處理兩種狀態，邏輯混疊 |
| `public/verdicts.html` | 公開仲裁紀錄頁 | 設計語言與主頁不一致（indigo accent vs teal accent） |
| `public/badge.html` | 信譽徽章頁 | 良好，但缺乏與 Dashboard 的連通感 |
| `public/profile.html` | 代理人公開主頁 | 缺乏 social proof 密度 |
| `public/css/main.css` | 全局樣式 | 有 CSS 變數系統，基礎良好 |

### 1.2 當前設計的核心問題

**技術層面**
- Landing page 與 Dashboard 共用同一 HTML 檔案，JS 狀態切換脆弱
- 無 component 化，修改一個按鈕需要在多個 HTML 檔案搜尋
- 沒有 CMS 或設定層：改一個標題需要 git push + Render 重新部署

**視覺層面**
- verdicts.html 使用 indigo (#6366f1)，主頁使用 teal (#00d4aa)，品牌色彩不統一
- badge.html 使用 `var(--text-soft)` 但該變數在 main.css 未定義（應為 `--text-secondary`）
- 字型系統宣告了 Inter 但未載入 Google Fonts，fallback 到系統字型
- 沒有 motion design：頁面轉場、數字動畫、載入狀態都太靜態

**產品層面**
- Dashboard 沒有「操作員視角」：你作為創辦人，需要看的是系統健康、異常交易、仲裁隊列，而不是用戶看的數字
- 沒有新聞/公告系統：任何更新都只能靠 X 或 Discord，無法在官網展示
- 沒有自動化更新流程：每次版本更新都需要人工修改 HTML

---

## 二、設計哲學與視覺語言

### 2.1 設計參考基準

以下為世界一線產品的設計哲學分析，取其精髓用於 Arbitova：

**Stripe（支付基礎設施標準）**
- 核心原則：「任何支付公司都必須比 Stripe 更可信才值得存在」
- 取用：typography-first hierarchy、精準的 grid 系統、數字展示用 tabular-nums
- 取用：漸層是用來建立深度感，不是裝飾
- 避免：過度精細的插圖（對 agent economy 不適用）

**Linear（開發者工具的設計標準）**
- 核心原則：速度即設計，每個互動都應感覺瞬間發生
- 取用：keyboard-first、清晰的 hierarchy、減法設計哲學
- 取用：密集的資訊展示但不顯擁擠（行高與間距的精確控制）

**Vercel（開發者 Dashboard 標準）**
- 核心原則：即時性（real-time feedback）、讓技術數字有意義
- 取用：部署狀態、指標卡片、活動串流的視覺模式
- 取用：空白即訊息（empty state 的設計）

**Planetscale（技術基礎設施的可信度建立）**
- 核心原則：用數據密度建立技術可信度
- 取用：分支線圖、讀/寫分離的視覺呈現
- 取用：「你的系統現在的狀態」優先於「你的帳戶」

**Anthropic.com（AI 公司的視覺沉穩感）**
- 核心原則：不試圖「看起來像 AI」，反而更可信
- 取用：大量留白、serif 字型點綴、低飽和度色系
- 取用：說人話，不說 AI buzzword

### 2.2 Arbitova 的設計身份

Arbitova 不是一個 consumer app，也不是傳統 B2B SaaS。  
它是 **agent economy 的法院 + 銀行**。

這決定了以下設計原則：

**原則一：Trust through restraint（克制即信任）**
- 任何看起來「很酷」的設計元素，先問：「這讓用戶更相信我嗎？」
- 顏色用途：teal 只用於成功/確認/金流，不用於裝飾
- 字體大小：標題不超過 32px（太大的標題讓人覺得在賣夢想，不是基礎設施）

**原則二：Density with breathing room（密度與呼吸並存）**
- Dashboard 需要展示大量數據，但不能讓操作員感到焦慮
- 卡片系統：8px grid，card padding 至少 20px
- 表格行高：48px（比多數 SaaS 產品高，讓眼睛更容易追蹤）

**原則三：Motion as signal（動效是訊號，不是裝飾）**
- 數字增加時：count-up animation（讓新交易感覺真實）
- 狀態變化時：200ms ease-out（讓系統感覺有回應但不煩躁）
- 頁面載入：skeleton placeholder，不是 spinner

**原則四：No AI aesthetic（不要 AI 視覺）**
- 禁止：賽博朋克光效、grid 背景、流光效果
- 禁止：過度使用漸層、玻璃擬態濫用
- 允許：subtle noise texture、monospace 數字、精準的邊框色

### 2.3 統一色彩系統

```css
:root {
  /* 背景層次（從深到淺）*/
  --bg-base:    #080808;   /* 頁面背景 */
  --bg-surface: #111111;   /* 卡片、面板 */
  --bg-raised:  #181818;   /* hover 狀態、輸入框 */
  --bg-overlay: #202020;   /* dropdown、tooltip */

  /* 邊框（三個層次）*/
  --border-subtle:  rgba(255,255,255,0.06);
  --border-default: rgba(255,255,255,0.10);
  --border-strong:  rgba(255,255,255,0.18);

  /* 文字（四個層次）*/
  --text-primary:   #F2F2F2;
  --text-secondary: #8A8A8A;
  --text-tertiary:  #555555;
  --text-disabled:  #333333;

  /* 品牌色：統一使用 teal（廢除 verdicts.html 的 indigo）*/
  --brand:          #00C896;   /* 主要動作、成功狀態 */
  --brand-dim:      rgba(0, 200, 150, 0.10);
  --brand-border:   rgba(0, 200, 150, 0.25);

  /* 語意色 */
  --success:  #00C896;
  --warning:  #F59E0B;
  --danger:   #EF4444;
  --neutral:  #6B7280;

  /* 數字字型（tabular）*/
  --font-num: 'IBM Plex Mono', 'SF Mono', monospace;
  --font-ui:  'Inter', system-ui, sans-serif;
}
```

---

## 三、頁面架構重設計

### 3.1 整體頁面地圖

```
arbitova.com/
├── /                    → 公開 Landing Page
├── /verdicts            → 公開仲裁紀錄（重設計）
├── /badge               → 信譽徽章（重設計）
├── /profile/:agentId    → 代理人公開主頁（重設計）
├── /changelog           → 版本更新紀錄（新增，自動生成）
├── /status              → 系統狀態頁（新增）
│
├── /dashboard           → 用戶 Dashboard（分離出來獨立）
│   ├── /overview        → 交易概覽
│   ├── /escrows         → 托管管理
│   ├── /disputes        → 爭議管理
│   ├── /arbitration     → 仲裁紀錄
│   ├── /rfp             → RFP 市場
│   ├── /reputation      → 信譽管理
│   ├── /api-keys        → API 金鑰
│   └── /settings        → 設定
│
└── /admin               → 操作員後台（新增，password protected）
    ├── /metrics         → 平台全局指標
    ├── /content         → 網站內容管理
    ├── /announcements   → 公告管理
    └── /system          → 系統健康
```

### 3.2 Landing Page 重設計

**目標：** 讓第一次看到 Arbitova 的開發者在 10 秒內理解「這是什麼」並想要 API Key

**版面結構（從上到下）：**

```
[Nav] Arbitova  |  Docs  Pricing  Verdicts  |  [Log in] [Get API Key →]

[Hero]
  小標：Trust infrastructure for the agent economy
  主標：Every agent payment,  （大字，28px，不超過）
        verified and protected.
  副標：Escrow. AI arbitration. Reputation scores.
        One SDK for agent-to-agent transactions.
  CTA：[Get API Key, free →]  [Read the docs]

  ↓ 下方緊接著：real-time counter
  "14,302 transactions settled · 99.7% resolution rate · 0 contested funds lost"
  （從 API 動態拉取，每 30 秒更新）

[Code Demo]  — 左右分欄
  左：5 行 SDK 程式碼（Node.js）
  右：對應的 transaction lifecycle 視覺（狀態機圖）

[Feature 三欄]
  Escrow          AI Arbitration       Reputation
  一句話說明       一句話說明           一句話說明
  → 了解更多       → 查看仲裁紀錄       → 查看排行榜

[Pricing]
  三個方案卡片（Free / Pro / Enterprise）
  Simple table，無裝飾

[Trust Signal]
  "每一筆仲裁都公開" → 連結到 /verdicts
  最近 5 筆仲裁的 live feed（無需登入可見）

[Footer]
  Docs | API | Verdicts | Status | Changelog | GitHub
```

**關鍵設計決策：**
- Hero 不用任何插圖或動畫背景
- Code demo 使用真實的 SDK 程式碼（複製可用）
- Stats 從 API 動態拉取，不是假數字
- 完全沒有 emoji

### 3.3 用戶 Dashboard 重設計

**Overview 頁面佈局（4 區塊）：**

```
┌─────────────────────────────────────────────────────────┐
│ [Sidebar 240px]  │  [主內容區]                           │
│                  │                                        │
│  Overview        │  [四個 KPI 卡片，一排]                │
│  Escrows         │  Total Escrowed  Active  Settled  Disputed │
│  Disputes        │  $4,200          12      847      3         │
│  Arbitration     │                                        │
│  RFP Market      │  [兩欄]                               │
│  Reputation      │  Recent Transactions  │  System Status │
│  API Keys        │  （表格，10 行）      │  （狀態卡片）  │
│  Settings        │                       │               │
│                  │  [Arbitration Queue]                  │
│  ─────────────   │  （需要你注意的案件）                 │
│  [agent name]    │                                        │
│  [level badge]   └────────────────────────────────────────┘
│  [logout]
└──────────────────
```

**KPI 卡片設計規格：**
```
┌────────────────────────────┐
│ TOTAL ESCROWED             │
│ $4,200.00                  │  ← tabular-num, 28px
│ ↑ +$320 today              │  ← 12px, --text-secondary
└────────────────────────────┘
```
- 數字使用 IBM Plex Mono
- 沒有彩色背景（白字在深色卡片上）
- 箭頭是 SVG，不是 emoji

**Recent Transactions 表格規格：**

| 欄位 | 內容 | 寬度 |
|------|------|------|
| ID | `ORD-00847` monospace | 100px |
| Parties | `Agent A → Agent B` | flex |
| Amount | `$120.00` 右對齊 | 80px |
| Status | `Settled` badge | 80px |
| Time | `2m ago` | 80px |

Status badge 顏色規則：
- Settled → `--success` 背景 10% opacity，文字 `--success`
- Active → `--brand` 同上
- Disputed → `--warning` 同上
- Failed → `--danger` 同上

### 3.4 Verdicts 頁面重設計

保留現有邏輯，但解決設計不一致問題：

**修正清單：**
1. 廢除 indigo (#6366f1)，全部換成 teal (#00C896)
2. `.badge-ai::before` 的色圓點改為 `--brand`
3. 增加「AI Panel」展開：點擊一行後的 modal 展示 3 個 AI 法官各自的推理
4. 增加搜尋欄位（按 dispute_type 搜尋）
5. 增加時間範圍篩選（今天 / 本週 / 本月 / 全部）
6. Stats bar 增加動態計數（用 count-up.js 或自製）

**新增：Reasoning Depth Panel**
點擊任何一行後，modal 顯示：
```
Case #00847 — Incomplete Delivery

Verdict: Buyer wins (2/3 judges)
Confidence: 87%

── Judge 1 (Claude) ──
Reasoning: The seller's delivery was incomplete...
Vote: BUYER

── Judge 2 (GPT-4) ──  
Reasoning: Upon review, the buyer's claim...
Vote: BUYER

── Judge 3 (Gemini) ──
Reasoning: While the seller...
Vote: SELLER

Majority verdict: BUYER (2-1)
```

---

## 四、操作員後台（Admin CMS）

### 4.1 設計目標

你需要一個讓你能夠「不需要 git push」就能：
- 修改首頁任何文字、數字、CTA
- 發布公告
- 查看平台異常
- 調整 Pricing 頁的方案與金額

### 4.2 技術架構選擇

**方案比較：**

| 方案 | 優點 | 缺點 | 適合度 |
|------|------|------|--------|
| Sanity CMS | 完整 CMS、可視化編輯 | 需要 Next.js、增加複雜度 | 中 |
| Tina CMS | Git-based、Markdown | 需要 React 前端 | 低 |
| Directus | Self-hosted、REST API | 需要 VPS 額外費用 | 中 |
| **自製 Admin Panel** | 完全控制、輕量 | 需要開發時間 | **高** |
| Netlify CMS (Decap) | Git-based、純靜態 | 功能受限 | 低 |

**選擇：自製輕量 Admin Panel + JSON 設定檔**

理由：
- Arbitova 是 infrastructure 產品，不需要 full CMS
- 需要修改的內容有限且結構化
- 自製可以和現有 Render 後台整合
- 你已有 Express.js 後台，加一個 `/admin` 路由成本最低

### 4.3 Admin Panel 架構

**資料流：**
```
[Admin Browser]
      ↓
[POST /admin/api/content]  ← password 驗證
      ↓
[Express.js 後台]
      ↓
[Postgres DB: site_config table]
      ↓
[Frontend 每次載入時 GET /api/site-config]
      ↓
[index.html 動態填入內容]
```

**site_config 表結構：**
```sql
CREATE TABLE site_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**可管理的欄位：**
```json
{
  "hero_title": "Trust infrastructure for the agent economy",
  "hero_subtitle": "Escrow. AI arbitration. Reputation scores.",
  "hero_badge_text": "Now in Public Beta",
  "stats_show_live": true,
  "pricing_free_limit": "1,000 transactions/month",
  "pricing_pro_price": "$29",
  "pricing_enterprise_price": "Contact us",
  "announcement_active": true,
  "announcement_text": "MCP Server v3.3.0 released — 60 tools",
  "announcement_url": "/changelog",
  "changelog_entries": [...]
}
```

**Admin Panel 介面（/admin）：**

```
┌──────────────────────────────────────────────────────────┐
│ Arbitova Admin                           [Logout]         │
├──────────────────────────────────────────────────────────┤
│ [Platform Metrics] [Content Editor] [Announcements] [System] │
└──────────────────────────────────────────────────────────┘

Content Editor 頁面：
┌────────────────────────────────────────┐
│ Hero Section                           │
│ Title:    [___________________________]│
│ Subtitle: [___________________________]│
│ Badge:    [___________________________]│
│                                        │
│ Announcement Banner                    │
│ Active:   [ON / OFF]                   │
│ Text:     [___________________________]│
│ URL:      [___________________________]│
│                                        │
│              [Save Changes]            │
└────────────────────────────────────────┘
```

**驗證：**
- 單一密碼（bcrypt hash 存在環境變數）
- Session token（24h expiry）
- Rate limiting：5 次失敗後鎖定 15 分鐘

### 4.4 視覺微調系統（不需要改程式碼）

透過 Admin Panel 管理的 CSS 變數覆寫層：

```json
{
  "theme_overrides": {
    "--brand": "#00C896",
    "--bg-base": "#080808"
  }
}
```

Frontend 在 `<head>` 末端動態注入：
```html
<style id="theme-override">
  :root { --brand: #00C896; --bg-base: #080808; }
</style>
```

這讓你可以在不 push 程式碼的情況下：
- 測試不同的 brand color
- 做 A/B 測試（暗/亮 主題預設）

---

## 五、自動化更新系統

### 5.1 Changelog 自動發布

**目標：** 每次 git push to master，自動更新 /changelog 頁面

**GitHub Actions 流程：**
```yaml
# .github/workflows/changelog.yml
name: Update Changelog

on:
  push:
    branches: [master]

jobs:
  update-changelog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      
      - name: Extract commits since last release
        id: commits
        run: |
          LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
          if [ -n "$LAST_TAG" ]; then
            COMMITS=$(git log $LAST_TAG..HEAD --pretty=format:'{"hash":"%h","msg":"%s","date":"%ci"}' | jq -s .)
          else
            COMMITS=$(git log -20 --pretty=format:'{"hash":"%h","msg":"%s","date":"%ci"}' | jq -s .)
          fi
          echo "commits=$COMMITS" >> $GITHUB_OUTPUT
      
      - name: Push to Arbitova API
        run: |
          curl -X POST https://a2a-system.onrender.com/admin/api/changelog \
            -H "Authorization: Bearer ${{ secrets.ADMIN_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d '{"entries": ${{ steps.commits.outputs.commits }}}'
```

**Changelog 頁面設計（/changelog）：**
```
Changelog

v3.3.0  —  2026-04-12
  + MCP Server: 60 tools
  + External arbitration API bug fix
  ~ SDK: fee rate adjustment

v3.1.0  —  2026-03-28
  + Tiebreaker mechanism
  + Python SDK v2.4.0
```

設計參考：Linear changelog、Vercel changelog

### 5.2 Platform Stats 自動更新

**Stats 即時化方案：**

```javascript
// Frontend: 每 30 秒輪詢一次平台統計
async function refreshStats() {
  const data = await fetch('/api/v1/stats/public').then(r => r.json());
  animateCounter('stat-transactions', data.total_transactions);
  animateCounter('stat-volume', data.total_volume);
  animateCounter('stat-agents', data.total_agents);
}

function animateCounter(id, target) {
  const el = document.getElementById(id);
  const start = parseInt(el.dataset.current || '0');
  const duration = 800;
  const startTime = performance.now();
  
  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const value = Math.floor(start + (target - start) * easeOut(progress));
    el.textContent = value.toLocaleString();
    if (progress < 1) requestAnimationFrame(update);
    else el.dataset.current = target;
  }
  
  requestAnimationFrame(update);
}

// 初始化 + 定時刷新
refreshStats();
setInterval(refreshStats, 30000);
```

### 5.3 公告自動發布流程

**流程：**
```
[你在 Admin Panel 輸入公告]
          ↓
[POST /admin/api/announcements]
          ↓
[存入 DB announcement_queue]
          ↓
[Frontend 每次載入時讀取 active announcement]
          ↓
[顯示頂部 Banner]
          ↓
[可選：同時觸發 Webhook → Discord / MoltBook]
```

**公告 Banner 設計：**
```
┌─────────────────────────────────────────────────────────┐
│  MCP Server v3.3.0 released — 60 tools available now.   │
│  Read the changelog →                             [×]   │
└─────────────────────────────────────────────────────────┘
```
- 無色彩，只有深色背景（--bg-overlay）
- 一行文字 + 連結 + 關閉按鈕
- 用戶關閉後儲存到 localStorage，不再顯示同一則公告

### 5.4 自動 Discord / MoltBook 通知

每次透過 Admin Panel 發布公告，自動同步：

```javascript
// Admin API: POST /admin/api/announcements
async function publishAnnouncement(text, url) {
  // 1. 存入 DB
  await db.query(
    'INSERT INTO announcements (text, url, active) VALUES ($1, $2, true)',
    [text, url]
  );
  
  // 2. 觸發 Discord Webhook
  if (process.env.DISCORD_WEBHOOK_URL) {
    await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `**Arbitova Update:** ${text}\n${url}`
      })
    });
  }
  
  // 3. 觸發 MoltBook（若有 API）
  if (process.env.MOLTBOOK_API_KEY) {
    // MoltBook post via existing integration
  }
}
```

---

## 六、系統健康頁（/status）

參考 Stripe Status、GitHub Status 設計：

```
Arbitova System Status
Last updated: 2 minutes ago

Overall: All systems operational

────────────────────────────────────────
API Endpoints                Operational
Arbitration Engine           Operational  
Escrow Processing            Operational
Database                     Operational
────────────────────────────────────────

Uptime (90 days): 99.7%
[graph showing daily uptime bars]

Recent Incidents:
  None in the last 30 days.
```

**後台實作：**
- 每 60 秒 cron 輪詢各個關鍵 endpoint
- 結果存入 `system_health` 表
- Frontend 讀取並展示
- 若有 endpoint 失敗 > 2 次，自動發送 email/Discord 警報

---

## 七、技術實作路線圖

### Phase 1（第 1-2 週）：設計系統統一

優先級：高。這些改動不需要後台，只需改 HTML/CSS。

- [ ] 統一 verdicts.html 顏色到 teal 系統
- [ ] 建立統一 `design-tokens.css`（廢棄各頁的 inline style 重複定義）
- [ ] 載入 Inter 字型（加一行 Google Fonts link）
- [ ] 載入 IBM Plex Mono 用於數字
- [ ] 建立 component snippets（按鈕、卡片、徽章）讓各頁共用

**工作量：** 約 6-8 小時

### Phase 2（第 3-4 週）：Landing Page 重建

- [ ] 拆分 index.html：Landing 和 Dashboard 分成兩個獨立 HTML
- [ ] 實作 Hero section（新版設計）
- [ ] 實作 Code demo 區塊（左程式碼 + 右狀態機）
- [ ] 實作即時 stats（count-up animation + 30s 輪詢）
- [ ] 實作 Pricing 頁（從 DB 讀取，可由 Admin 修改）
- [ ] 實作 /changelog 靜態頁

**工作量：** 約 12-16 小時

### Phase 3（第 5-6 週）：Dashboard 重建

- [ ] 重新設計 Sidebar navigation
- [ ] Overview 頁面：KPI 卡片 + 交易表格 + 系統狀態
- [ ] Escrows 管理頁：列表 + 搜尋 + 狀態篩選
- [ ] Disputes 頁：仲裁隊列，優先顯示需要處理的
- [ ] Reputation 頁：信譽趨勢圖
- [ ] API Keys 頁：更清晰的 key 管理

**工作量：** 約 20-24 小時

### Phase 4（第 7-8 週）：Admin CMS + 自動化

- [ ] 建立 `site_config` 表和 `announcements` 表
- [ ] 實作 `/admin` 路由（password protected）
- [ ] Admin Panel：Content Editor（hero、公告、pricing）
- [ ] Admin Panel：Platform Metrics（全局數據）
- [ ] Admin Panel：System Health dashboard
- [ ] GitHub Actions：Changelog 自動更新
- [ ] Discord Webhook：公告自動同步
- [ ] 實作 `/status` 頁

**工作量：** 約 20-25 小時

### Phase 5（第 9-10 週）：Verdicts 深化 + Badge 優化

- [ ] Verdicts：搜尋 + 時間篩選
- [ ] Verdicts：AI Panel reasoning modal（三位法官詳細推理）
- [ ] Badge：設計語言統一
- [ ] Profile：social proof 密度提升（加入 recent activity timeline）
- [ ] /status 頁面上線

**工作量：** 約 10-12 小時

---

## 八、未來自動化更新機制（長期）

### 8.1 版本發布自動化

當你 push 一個 git tag（例如 `v3.4.0`）：

```
git tag v3.4.0 -m "Add batch escrow support"
git push origin v3.4.0
```

GitHub Actions 自動：
1. 解析 tag 和 commit message
2. 更新 /changelog 頁面
3. 更新 npm package version badge
4. 在 Admin Panel 新增一則草稿公告（你手動確認後發布）
5. 可選：發布到 Discord #updates 頻道

### 8.2 API 文件自動同步

後台已有 OpenAPI 規格（~125 paths），設定：

```yaml
# .github/workflows/docs-sync.yml
on:
  push:
    paths:
      - 'src/routes/**/*.js'
      - 'src/middleware/**/*.js'
```

每次 API 路由有變動，自動重新生成 OpenAPI JSON，更新文件頁面。

### 8.3 Arbitration Stats 日報

每天 UTC 00:00，GitHub Actions 執行：
1. 呼叫 `/api/v1/stats/daily`
2. 生成日報 JSON
3. 存入 DB `daily_reports` 表
4. 前端 /verdicts 頁面的「上週趨勢」圖自動更新

---

## 九、不做的事（範圍管控）

以下是常見陷阱，明確排除：

- **不做 React/Next.js 遷移**：現有 vanilla HTML/CSS/JS 對這個規模完全足夠，遷移帶來的複雜度不值得
- **不做複雜的 CMS（Sanity/Contentful）**：內容量不足以支撐，自製 JSON config 更輕量
- **不做 WebSocket 即時推送**：30 秒 polling 對 stats 更新完全足夠，WebSocket 增加基礎設施複雜度
- **不做多語言（i18n）**：現有的 `data-i18n` 屬性系統保留但不擴展，等有真實用戶需求再做
- **不做 Mobile App**：Web first，PWA 支援足夠
- **不做 Dark/Light 切換按鈕**：保持 dark-only，避免設計分裂，減少測試工作量

---

## 十、衡量成功的指標

| 指標 | 當前狀態 | 三個月後目標 |
|------|---------|------------|
| 首頁 Bounce Rate | 未追蹤 | < 55% |
| Dashboard 日活 | 未追蹤 | > 5 unique users |
| API Key 申請率 | 未追蹤 | 首頁訪客 > 8% 申請 |
| Verdicts 頁停留時間 | 未追蹤 | > 90 秒 |
| 內容更新頻率 | 每次需 git push | 每週可無程式碼更新 |
| Admin 操作時間 | N/A | 改一個標題 < 30 秒 |

---

## 附錄：參考網站清單

技術設計參考（按相關性排序）：

| 網站 | 參考元素 |
|------|---------|
| stripe.com | 整體設計語言、typography、信任感建立 |
| linear.app | Dashboard 密度、keyboard nav、速度感 |
| vercel.com/dashboard | KPI 卡片設計、部署狀態視覺 |
| planetscale.com | 技術可信度建立、資料視覺化 |
| railway.app | 開發者 UX、活動串流設計 |
| github.com/pulls | 表格設計、狀態 badge |
| anthropic.com | 企業 AI 的視覺克制感 |
| pagerduty.com | 系統健康頁參考 |
| cloudflare.com/analytics | 指標展示密度 |

---

*計畫書結束。本文件應根據開發進度每兩週更新一次。*
