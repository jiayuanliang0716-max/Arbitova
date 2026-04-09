# A2A 交易系統 — 自主執行任務書

## 你的身份
你是這個 A2A 交易系統的全權執行者。
在 AUTONOMOUS_RULES.md 定義的邊界內完全自主決策和執行。

## 專案目標
建立一個讓 AI Agent 之間能夠自主發現、交易、結算的平台。
定位：Agent 經濟的基礎設施層。

## 系統現況
- MVP Phase 1 已完成（虛擬 USDC）
- 線上運行：https://a2a-system.onrender.com
- 詳細進度參考：PROGRESS.md

## 執行原則

### 開始每次工作時
1. 讀取 PROGRESS.md 了解現有進度
2. 讀取 DECISION_NEEDED.md 確認有無待處理事項
3. 從上次中斷的地方繼續
4. 不要重複已完成的工作

### 執行過程中
1. 技術決策自己做，不需要確認
2. 遇到 bug 自己修，最多嘗試 5 次
3. 每完成一個功能立刻更新 PROGRESS.md 並 git push
4. 遇到 AUTONOMOUS_RULES.md 定義的重大決策，寫入 DECISION_NEEDED.md 後停止

### 完成每次工作時
1. 更新 PROGRESS.md
2. git add . && git commit -m "進度更新：[說明]"
3. git push

## 今晚的任務（2026-04-10 夜間自動迭代）

**先決條件**：開始工作前，必須先確認 Claude Code 目前是「Claude Max 訂閱計費」，不是「API Key 計費」。如果是 API Key 計費，立即停止並寫入 DECISION_NEEDED.md 通知用戶。

### 主攻方向（完全自主，不會觸發紅線）

**任務一：前端介面（優先）**
- 擴充 `/` Dashboard，加入完整互動功能
- Agent 註冊表單（填表單 → 取得 API key → 顯示並複製）
- 服務上架表單（需要 API key）
- 市場瀏覽頁（卡片式顯示、搜尋、排序）
- 下單流程（填需求 → 確認 → 顯示訂單 ID）
- 訂單管理頁（我的買單、我的賣單、狀態追蹤）
- 純 HTML + vanilla JS，不引入框架
- 使用現有 REST API，不改後端

**任務二：信用評分系統**
- agents 表新增 `reputation_score` 欄位（初始 0）
- 完成交易自動加分：買家確認成功 +10
- 發生爭議自動扣分：被裁定失敗方 -20
- 新 API：`GET /agents/:id/reputation` 顯示評分和歷史
- 服務搜尋結果依照賣家 reputation 排序
- Dashboard 顯示高 reputation agent 排行榜

### 會停下來寫入 DECISION_NEEDED.md 的情況
- Phase 2 USDC 相關（Coinbase AgentKit、錢包、真實金錢）
- 需要新的第三方 API Key 或帳號
- 要刪除現有資料或破壞性 schema migration
- 要引入前端框架（React/Vue）
- 同一 bug 修 5 次未成功
- 發現安全漏洞
- Claude Code 發現自己不是訂閱計費

### 每個任務完成後
1. 更新 PROGRESS.md
2. `git add . && git commit -m "..." && git push`
3. 用 `node -e` 呼叫 `src/notify.js` 發 Telegram 通知用戶
4. 等 Render 自動部署完成
5. 驗證線上
6. 開始下一個任務

### 用戶指令（從 Telegram 來）
定期呼叫 `https://a2a-system.onrender.com/telegram/commands` 取得用戶指令：
- `PAUSE` → 完成當前任務後停止
- `RESUME` → 繼續執行
- `STATUS` → 發送進度摘要到 Telegram
- `DIRECTIVE:xxx` → 將 xxx 納入任務方向考量

### 第一個動作
1. 執行 `claude config` 或檢查環境，確認使用 Claude Max 訂閱計費
2. 讀取 PROGRESS.md
3. 開始執行任務一：前端介面的 Agent 註冊表單
