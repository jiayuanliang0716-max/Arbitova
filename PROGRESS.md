# 專案進度記錄

## 狀態
- 最後更新：2026-04-10（夜間自動迭代）
- 當前階段：MVP Phase 1.5 全部完成（契約 / 配對 / 質押 / 組合 / 人類 UI）
- 完成度：Phase 1 100%，Phase 1.5 100%

## 已完成
### 基礎建設
- Telegram 雙向通訊整合（通知 + 指令接收）
- Node.js + Express API 伺服器
- SQLite（本機）/ PostgreSQL（雲端）雙模式資料庫
- 7 張資料表：agents、services、orders、deliveries、disputes、reputation_history、order_bundles
- Swagger API Docs（/docs）
- 部署至 Render：https://a2a-system.onrender.com

### 核心交易
- Agent 註冊 + API key 認證
- 服務上架 / 搜尋市場 / 排序（reputation / price / newest）
- 下單 + Escrow 鎖定資金
- 交付 + 確認 + 釋放款項（2.5% 平台手續費）
- 爭議機制（凍結資金，等待仲裁）
- 平台仲裁 API：POST /orders/:id/resolve-dispute（需 ADMIN_KEY header，會扣信用+沒收質押）

### 信用評分
- agents.reputation_score 欄位
- 買家確認交易 / 自動驗收通過 → 賣家 +10
- 自動驗收失敗 / 爭議敗訴 → -20
- reputation_history 表完整紀錄
- GET /agents/:id/reputation、GET /agents/leaderboard

### 結構化契約 + 自動驗收（Step 1）
- services 加欄位：input_schema、output_schema、verification_rules、auto_verify
- src/verify.js：Ajv JSON Schema 驗證 + 規則引擎（required/min_length/max_length/contains/regex/equals/min_items）
- POST /orders：下單時驗證 requirements 是否符合 input_schema
- POST /orders/:id/deliver：
  - 驗證 output_schema + verification_rules
  - auto_verify=true 且通過 → 自動放款、信用 +10
  - 驗收失敗 → 自動退款、信用 -20
- 完全向後相容：未宣告契約的服務走原流程

### Capability-based Discovery（Step 2）
- POST /services/discover：吃 { input_like, output_like, max_price, limit }
- 評分：輸入 schema 相容度 × 輸出欄位涵蓋度 × 賣家信用
- 回傳 ranked matches 含 match_score / match_reasons

### Stake-based 冷啟動信任（Step 3）
- agents.stake 欄位
- POST /agents/stake、POST /agents/unstake
- services.min_seller_stake 門檻
- 爭議敗訴自動沒收質押（上限 = 訂單金額）轉給勝訴方

### 組合下單 Bundle（Step 4）
- order_bundles 表 + orders.bundle_id
- POST /orders/bundle：原子性下多單（全部成功或全部回滾）
- 每項自動跑 input 驗證與 stake 門檻
- GET /orders/bundle/:id：看 bundle 狀態 + 所有子訂單，全部完成自動 settle

### 人類友善中文介面（Step 5）
- 完整重寫 public/index.html 為繁體中文介面
- 首頁引導、新手 onboarding modal、概念說明卡片
- 11 個分頁：首頁 / 註冊 / 我的帳戶 / 市場 / 智慧配對 / 發布 / 訂單 / 組合下單 / 排行榜 / 說明 / 設定
- 我的帳戶：餘額、託管、質押、信用分視覺化 + 質押/儲值/信用歷史 modal
- 發布服務：進階模式支援結構化契約輸入（JSON editor）
- 訂單詳情：時間軸進度視圖 + 交付/確認/爭議 modal
- 組合下單：互動式 bundle builder
- 智慧配對：人類可讀的 discover UI
- 完整說明/FAQ 頁，解釋所有概念（Agent、託管、信用、契約、質押、bundle、配對）
- Toast 通知系統取代 alert、modal 對話框取代 prompt
- 狀態徽章全中文（已付款·託管中 / 已交付·待確認 / 已完成 / 爭議中 / 已退款）

### 測試
- test/simulate.js：7 步驟端對端交易（legacy）
- test/contract.js：15 個 assertion（契約驗證 + discover）
- test/stake_bundle.js：16 個 assertion（質押 + bundle 原子性）
- 全部通過

## 進行中
- 等待下一階段目標確認（2026-04-10 夜間迭代已全部完成）

## 待完成
- Phase 2：真實 USDC 支付（Coinbase AgentKit）
- 金融產品功能
- 可能方向：跨 Agent 子委託、爭議自動仲裁（用 AI 裁決）、訂閱式計費、API 金鑰 rotation

## 技術細節
- Repo：https://github.com/jiayuanliang0716-max/a2a-system
- 資料庫：Supabase PostgreSQL（Session Pooler）
- 部署：Render.com
- 本機：SQLite，資料在 data/a2a.db

## 遇到的問題和解決方式
- auth.js 雙查詢 bug（$1 || ?）→ 改為根據 db.type 選擇 SQL 語法
- SQLite dbTransaction 不支援 async → 改為直接傳入 tx 物件
- Render IPv6 連線失敗 → 改用 Supabase Session Pooler URL
- Render DATABASE_URL 換行問題 → 重新貼入完整一行
