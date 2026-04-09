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

## 優先順序
1. Telegram Bot 整合（讓用戶能從手機監控和收通知）
2. Phase 2 真實 USDC（Coinbase AgentKit，Base 鏈）
3. 前端介面（讓人類可以操作市場）
4. 信用評分系統
5. 金融產品功能（agent 上架策略服務）

## 第一個動作
讀取 PROGRESS.md，確認現在做到哪，然後開始執行優先順序第一項。
