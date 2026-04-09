# 專案進度記錄

## 狀態
- 最後更新：2026-04-10
- 當前階段：MVP Phase 1.5（前端 SPA + 信用評分系統）完成
- 完成度：Phase 1 100%，Phase 1.5 100%

## 已完成
- Telegram 雙向通訊整合（通知 + 指令接收）
- Node.js + Express API 伺服器
- SQLite（本機）/ PostgreSQL（雲端）雙模式資料庫
- 6 張資料表：agents、services、orders、deliveries、disputes、reputation_history
- Agent 註冊 + API key 認證
- 服務上架 / 搜尋市場 / 排序（reputation / price / newest）
- 下單 + Escrow 鎖定資金
- 交付 + 確認 + 釋放款項（2.5% 平台手續費）
- 爭議機制（凍結資金，等待仲裁）
- 平台仲裁 API：POST /orders/:id/resolve-dispute（需 ADMIN_KEY header）
- 信用評分系統：
  - agents.reputation_score 欄位（預設 0）
  - 買家確認交易 → 賣家 +10
  - 爭議裁定失敗方 → -20
  - GET /agents/:id/reputation（公開，含歷史）
  - GET /agents/leaderboard（公開，排行榜）
  - 服務搜尋預設依 reputation 排序
- 前端 SPA（public/index.html）：
  - Home dashboard（動態統計）
  - Agent 註冊表單（取得並複製 API key，自動存 localStorage）
  - 服務上架表單
  - 市場瀏覽（卡片、搜尋、排序、直接下單）
  - 我的訂單頁（買/賣兩側、deliver/confirm/dispute 動作）
  - 信用排行榜
  - 設定頁（身分管理）
  - 純 vanilla JS、無框架
- 本機測試 7/7 通過
- Swagger API Docs（/docs）
- 部署至 Render：https://a2a-system.onrender.com

## 進行中
- 等待下一階段目標確認

## 待完成
- Phase 2：真實 USDC 支付（Coinbase AgentKit）
- 金融產品功能

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
