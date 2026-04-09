# A2A Agent 交易系統 完整規劃報告書
> 版本 v1.0 | 日期：2026-04-09 | 作者：Claude Code

---

## 目錄

1. 這是什麼、為什麼要做
2. 系統全貌與邊界
3. 技術架構
4. 資料結構設計
5. 付款機制設計（最重要）
6. 需要準備什麼
7. 開發路線圖
8. 上線策略
9. 潛藏問題與解決辦法
10. 商業模式
11. 成功指標

---

## 第一章：這是什麼、為什麼要做

### 1.1 一句話說清楚

> 一個讓 AI Agent 能夠找到彼此、談好條件、完成交易的最小系統。

### 1.2 為什麼現在要做

目前 AI Agent 的付款場景分兩種：

| 場景 | 現狀 | 誰在做 |
|------|------|--------|
| 人類透過 Agent 消費 | 已有解決方案 | Visa、Mastercard、Stripe |
| Agent 直接付錢給 Agent | 幾乎空白 | 你 |

Visa 和 Mastercard 的佈局是「人類 → Agent → 商家」，解決的是人類的消費授權問題。
但「Agent A 直接雇用 Agent B 完成子任務」這個場景，目前沒有標準化的方式。

### 1.3 類比說明

- 現在的 AI Agent 像是「會幹活的工人，但沒有銀行帳戶」
- 你要做的是「讓這些工人能互相雇用、互相付錢」的基礎設施
- MVP 目標：讓第一筆真實的 Agent 對 Agent 交易發生

### 1.4 這不是什麼

- 不是 ChatGPT 或任何面向人類的 AI 產品
- 不是區塊鏈項目（雖然會用到一點）
- 不是要取代人類的金融系統
- 不是完整的去中心化協議（MVP 階段是中心化平台）

---

## 第二章：系統全貌與邊界

### 2.1 系統的五個層次（從高到低）

```
第五層：任務層      Agent 接到目標，拆解成子任務          ← 不在 MVP 範圍
        ↓
第四層：發現層      Agent 找到能完成子任務的其他 Agent    ← MVP 要做
        ↓
第三層：協議層      兩個 Agent 確認服務內容、價格、條件   ← MVP 要做
        ↓
第二層：結算層      付錢、交付、確認完成                  ← MVP 要做（模擬）
        ↓
第一層：身份層      確認雙方身份真實可信                  ← 不在 MVP 範圍
```

### 2.2 MVP 要做什麼

```
[Agent A 買家] ←→ [你的系統] ←→ [Agent B 賣家]

Agent B 在系統上架服務
Agent A 搜尋並找到 Agent B 的服務
Agent A 付款（資金鎖定在系統中）
Agent B 交付服務內容
Agent A 確認完成
系統釋放款項給 Agent B
```

### 2.3 參與者是誰

**Agent（自動化程式）**
- 由人類或公司部署
- 透過 API 與你的系統互動
- 不需要人類即時介入每一筆交易

**部署者（人類/組織）**
- 負責預充值給自己的 Agent
- 設定 Agent 的消費規則和上限
- 承擔法律責任

**你（平台方）**
- 提供 API 服務
- 託管資金（Escrow）
- 處理爭議（MVP 階段人工）

---

## 第三章：技術架構

### 3.1 整體架構圖

```
┌─────────────────────────────────────────────┐
│                  你的 API Server             │
│                  (Node.js + Express)         │
├─────────────────┬───────────────────────────┤
│   業務邏輯層    │      資料存取層            │
│  - 訂單管理     │   (SQLite → PostgreSQL)    │
│  - 付款邏輯     │                            │
│  - 爭議處理     │                            │
├─────────────────┴───────────────────────────┤
│              付款層（分階段）                │
│  Phase 1: 資料庫模擬餘額                    │
│  Phase 2: USDC on Base / Coinbase AgentKit  │
└─────────────────────────────────────────────┘
         ↑                    ↑
    Agent A (買家)       Agent B (賣家)
    透過 API 呼叫        透過 API 呼叫
```

### 3.2 技術選型與理由

| 技術 | 選擇 | 理由 |
|------|------|------|
| 後端語言 | Node.js + Express | 快速開發，社群資源豐富 |
| 資料庫（MVP） | SQLite | 零配置，本機就能跑 |
| 資料庫（上線後） | PostgreSQL | 穩定、支援並發 |
| 付款（Phase 1） | 資料庫模擬 | 先驗證流程 |
| 付款（Phase 2） | USDC on Base | 手續費近乎為零 |
| 部署 | Railway 或 Render | 便宜、簡單 |

### 3.3 Agent 如何與系統互動

Agent 只需要能發出 HTTP 請求，任何語言都能用：

```
# Python Agent 範例
import requests

# 搜尋服務
response = requests.get('https://your-api.com/services/search?q=data-analysis')

# 建立訂單
order = requests.post('https://your-api.com/orders', json={
    'service_id': '123',
    'buyer_agent_id': 'agent-a-001'
})
```

---

## 第四章：資料結構設計

### 4.1 四張核心資料表

#### agents 表（Agent 身份與錢包）
```sql
CREATE TABLE agents (
    id          TEXT PRIMARY KEY,    -- 唯一識別碼
    name        TEXT NOT NULL,       -- Agent 名稱
    api_key     TEXT UNIQUE,         -- 用來驗證身份
    owner_email TEXT,                -- 部署者的 email
    balance     DECIMAL DEFAULT 0,   -- 帳戶餘額（模擬）
    escrow      DECIMAL DEFAULT 0,   -- 被鎖定的金額
    created_at  DATETIME DEFAULT NOW()
);
```

#### services 表（上架的服務）
```sql
CREATE TABLE services (
    id            TEXT PRIMARY KEY,
    agent_id      TEXT REFERENCES agents(id),
    name          TEXT NOT NULL,       -- 服務名稱
    description   TEXT,               -- 服務說明
    price         DECIMAL NOT NULL,   -- 價格（USDC）
    delivery_time INTEGER,            -- 承諾交付時間（小時）
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    DATETIME DEFAULT NOW()
);
```

#### orders 表（交易記錄）
```sql
CREATE TABLE orders (
    id             TEXT PRIMARY KEY,
    buyer_id       TEXT REFERENCES agents(id),
    seller_id      TEXT REFERENCES agents(id),
    service_id     TEXT REFERENCES services(id),
    status         TEXT DEFAULT 'pending',
    -- 狀態: pending → paid → delivered → completed / disputed
    amount         DECIMAL NOT NULL,
    requirements   TEXT,              -- 買家的具體需求說明
    deadline       DATETIME,          -- 截止時間
    created_at     DATETIME DEFAULT NOW(),
    completed_at   DATETIME
);
```

#### deliveries 表（交付內容）
```sql
CREATE TABLE deliveries (
    id           TEXT PRIMARY KEY,
    order_id     TEXT REFERENCES orders(id),
    content      TEXT NOT NULL,       -- 交付的內容（文字/連結）
    delivered_at DATETIME DEFAULT NOW()
);
```

### 4.2 後期追加的表（MVP 先不做）

```
disputes  → 爭議記錄
scores    → 信用評分歷史
events    → 所有操作的稽核日誌
```

---

## 第五章：付款機制設計（最重要）

### 5.1 核心問題：AI 付款的根據是什麼

這是整個系統最根本的問題。AI Agent 本身無法「擁有」資產，所有付款行為背後必然有一個人類或組織作為最終授權方。

**MVP 的答案**：Agent 是「被授權的代理人」，部署者（人類）預先充值並設定規則。

```
部署者（人類）
    ↓ 預充值 + 設定消費上限
Agent 的帳戶（你的系統託管）
    ↓ 在規則內自主交易
其他 Agent 的帳戶
```

### 5.2 Phase 1：模擬付款（MVP 階段）

**運作方式**：資料庫裡的數字

```
Agent A 帳戶餘額：10 USDC
Agent A 購買服務（1 USDC）後：
  - Agent A 餘額：9 USDC
  - Escrow（鎖定）：1 USDC

Agent B 交付確認後：
  - Escrow：0 USDC
  - Agent B 餘額：+1 USDC（扣除 2.5% 手續費後）
```

**為什麼先模擬**：
- 不需要處理區塊鏈技術複雜度
- 可以快速驗證業務流程
- 出錯容易修復
- 不會有真實資金損失

### 5.3 Phase 2：真實付款（上線後）

選項一：**Coinbase AgentKit**
- Coinbase 官方的 AI Agent 錢包解決方案
- 支援 USDC on Base
- 有 SDK，整合相對容易
- 需要 KYC 驗證

選項二：**x402 Protocol**
- HTTP 原生微支付協議
- Agent 可以直接在 HTTP 請求中附帶付款
- 更接近「Agent 原生」的設計
- 目前仍在早期階段

**建議**：Phase 2 先用 Coinbase AgentKit，因為文件完整、社群活躍。

### 5.4 Escrow 機制說明

```
買家付款
    ↓
資金進入 Escrow（第三方託管，由你的系統控制）
    ↓
情況 A：買家確認完成 → 資金釋放給賣家
情況 B：超過截止時間賣家未交付 → 資金退回買家
情況 C：發生爭議 → 資金凍結，等待裁定
```

---

## 第六章：需要準備什麼

### 6.1 技術準備

| 項目 | 說明 | 需要學習？ |
|------|------|----------|
| Node.js | 後端開發語言 | 基礎即可 |
| Express | Web 框架 | 簡單 |
| SQLite | 資料庫 | 基礎 SQL |
| REST API | API 設計概念 | 需要了解 |
| Git | 版本控制 | 基礎即可 |
| Postman 或 curl | API 測試工具 | 需要 |

**你不需要現在就懂的**：
- 區塊鏈 / Solidity（Phase 2 再學）
- 前端（MVP 只需要 API）
- DevOps（先用 Railway 一鍵部署）

### 6.2 帳號準備

| 帳號 | 用途 | 費用 |
|------|------|------|
| GitHub | 代碼管理 | 免費 |
| Railway 或 Render | 部署服務 | 免費方案夠用 |
| Postman | API 測試 | 免費 |
| （Phase 2）Coinbase Developer Platform | 錢包整合 | 免費，但需 KYC |

### 6.3 開發環境

```
本機需要安裝：
- Node.js v20+
- Git
- VS Code（推薦）或任何編輯器
- Postman（API 測試）

不需要：
- Docker（MVP 階段）
- 任何雲端服務（先在本機跑）
```

### 6.4 時間與人力

```
一個人開發 MVP：
- 每天 2-3 小時
- 約 2-3 週可完成基礎功能
- 第一筆模擬交易在第 2 週可以完成
```

---

## 第七章：開發路線圖

### 7.1 詳細時程

#### Week 1：基礎建設
```
Day 1
- 初始化 Node.js 專案
- 安裝必要套件（Express、better-sqlite3）
- 建立資料庫 schema（四張表）
- 測試資料庫連線

Day 2
- 實作 POST /agents/register（Agent 註冊）
- 實作 GET /agents/:id（查詢 Agent）
- 加入 API Key 驗證機制
- 測試：成功註冊兩個 Agent

Day 3
- 實作 POST /services（上架服務）
- 實作 GET /services/search（搜尋服務）
- 測試：Agent B 上架服務，Agent A 找到它

Day 4-5
- 整理代碼、補充錯誤處理
- 寫基礎測試
- 準備 Week 2
```

#### Week 2：交易核心
```
Day 6
- 實作 POST /orders（建立訂單 + 付款鎖定）
- 付款邏輯：Agent A 餘額扣除，進入 Escrow

Day 7
- 實作 POST /orders/:id/deliver（提交交付內容）
- 實作 POST /orders/:id/confirm（確認完成 + 釋放款項）

Day 8
- 加入自動超時退款邏輯
- 測試完整流程（從上架到完成）

Day 9-10
- 端到端測試
- 模擬第一筆完整的 A2A 交易
- 記錄過程中遇到的問題
```

#### Week 3：穩定化
```
- 加入基礎爭議功能（發起爭議、人工裁定）
- 完善錯誤處理
- 部署到 Railway
- 準備給真實 Agent 使用的文件
```

### 7.2 里程碑定義

| 里程碑 | 完成標準 |
|--------|---------|
| M1 | 兩個 Agent 可以成功註冊 |
| M2 | 服務可以上架和搜尋 |
| M3 | 第一筆模擬交易從頭到尾跑通 |
| M4 | 系統部署到網路上，外部可存取 |
| M5 | 第一筆真實 USDC 交易完成 |

---

## 第八章：上線策略

### 8.1 分階段上線

#### Stage 1：封閉測試（Week 3）
```
- 只有你自己操作
- 手動建立兩個測試 Agent
- 跑完 10 筆模擬交易
- 確認流程無誤
```

#### Stage 2：小規模開放（Month 2）
```
目標：找到 3-5 個願意測試的真實用戶
方式：
- 在 Twitter/X 發文說明這個系統
- 在 AI Agent 相關社群（Discord、Reddit）分享
- 找幾個有在做 AI Agent 的開發者直接聯繫
重點：收集真實反饋，不是追求用戶數
```

#### Stage 3：接入真實付款（Month 3）
```
- 整合 Coinbase AgentKit
- 先從極小金額開始（$0.01 USDC）
- 確認真實付款流程無誤
- 逐步開放更多用戶
```

#### Stage 4：公開上線（Month 4+）
```
- 完整文件
- 開發者 API 文件
- 基礎監控和告警
- 正式收取手續費
```

### 8.2 上線前必須確認的事

```
技術面：
- [ ] 所有 API 都有錯誤處理
- [ ] 資料庫有備份機制
- [ ] API Key 安全儲存（不能明文）
- [ ] 有基礎的請求頻率限制（防止濫用）

法律面：
- [ ] 確認你所在地區對「資金託管」的法規
- [ ] 準備服務條款
- [ ] 確認是否需要金融相關執照（重要！）

營運面：
- [ ] 有監控系統（知道服務掛掉）
- [ ] 有日誌記錄（出問題能追查）
- [ ] 有緊急聯絡方式
```

---

## 第九章：潛藏問題與解決辦法

### 9.1 技術問題

**問題一：如何防止 Agent 身份偽冒**
```
風險：有人假冒高信用 Agent 來詐騙
症狀：Agent B 假裝是知名服務商，騙走款項

解法（MVP）：
- 每個 Agent 有唯一 API Key
- 交易前驗證 API Key
- 上架服務需要部署者 email 確認

解法（後期）：
- 加入身份驗證層（如 DID 去中心化身份）
- 要求高額交易額外驗證
```

**問題二：資料庫並發問題**
```
風險：同一個 Agent 同時發出兩筆付款，餘額扣兩次但只有一次的錢
症狀：帳戶餘額變成負數

解法：
- 資料庫交易（Transaction）確保原子性
- 付款前加鎖（SELECT FOR UPDATE）
- SQLite 已內建序列化，PostgreSQL 需要手動處理
```

**問題三：服務交付無法自動驗證**
```
風險：Agent B 交付了垃圾內容，但系統無法判斷
症狀：買家說沒收到，賣家說已交付

解法（MVP）：
- 要求賣家提交交付內容的文字描述或連結
- 買家有 24 小時確認期
- 超時自動確認（防止買家惡意不確認）

解法（後期）：
- 加入 AI 自動驗證服務品質
- 建立標準化的交付格式
```

### 9.2 商業問題

**問題四：冷啟動（先有雞還是先有蛋）**
```
風險：沒有賣家所以買家不來，沒有買家所以賣家不來
症狀：平台空蕩蕩，沒有真實交易

解法：
- 你自己先建立幾個示範 Agent（既是買家也是賣家）
- 找 1-2 個合作夥伴一起測試
- MVP 只需要 2 個 Agent 就能跑，不需要等規模
```

**問題五：惡意爭議**
```
風險：買家服務確認收到後，惡意發起爭議要退款
症狀：賣家提供了服務卻拿不到錢

解法：
- 買家確認後不能再發起爭議（一旦確認就是最終）
- 爭議必須在買家確認前發起
- 惡意爭議會扣買家信用分
```

**問題六：賣家捲款跑路**
```
風險：賣家收到訂單後消失，不交付也不退款
症狀：款項卡在 Escrow，買家等不到服務

解法：
- Escrow 機制確保款項由平台控制，賣家無法直接拿走
- 超過截止時間自動退款給買家
- 賣家信用分嚴重扣分，往後需要更高保證金
```

### 9.3 法律問題

**問題七：資金託管的法規風險（最重要）**
```
風險：在某些國家/地區，託管他人資金需要金融執照
症狀：平台被主管機關要求關閉

解法（短期）：
- MVP 階段只做「模擬付款」，不碰真實資金
- 法律諮詢：了解你所在地區的規定
- 把真實資金結算外包給有執照的第三方（如 Stripe、Coinbase）

解法（長期）：
- 使用智能合約取代你的 Escrow
- 智能合約是中立的代碼，不是「你」在保管資金
- 這是 Web3 模式最重要的好處之一
```

**問題八：誰對 Agent 的行為負責**
```
風險：Agent A 付錢購買了違法服務
症狀：平台被牽連

解法：
- 服務條款明確規定：Agent 的行為由其部署者負責
- 禁止上架的服務類型要明確列出
- 違規服務的下架機制
```

### 9.4 擴展問題

**問題九：SQLite 無法支撐多用戶並發**
```
風險：用戶多了之後系統變慢甚至崩潰
症狀：API 回應時間越來越長

解法：
- MVP 用 SQLite，超過 1000 用戶考慮遷移
- 代碼設計上用 Repository Pattern，遷移資料庫不需要改業務邏輯
- 到時候遷移到 PostgreSQL（架構設計相似，遷移成本低）
```

**問題十：API 被濫用**
```
風險：有人寫腳本大量呼叫你的 API
症狀：服務器負載暴增，正常用戶無法使用

解法（MVP 就要做）：
- Rate Limiting：每個 API Key 每分鐘最多 60 次請求
- 用 express-rate-limit 套件，一行代碼就能加
```

---

## 第十章：商業模式

### 10.1 收費方式

```
Phase 1（MVP）：完全免費
目的：累積用戶和交易數據

Phase 2（有真實交易後）：
- 每筆成功交易：抽取 2.5%
- 爭議仲裁費用：固定 0.5 USDC（防惡意爭議）
- 這是交易完成後才收，買家付款時不收

Phase 3（規模化後）：
- Premium 上架：賣家付費提升搜尋排名
- API 訂閱方案：高頻使用的開發者
```

### 10.2 收費的技術實作

```
手續費計算：
賣家收到款項 = 交易金額 × (1 - 2.5%)

例子：
交易金額：10 USDC
賣家實收：9.75 USDC
平台收入：0.25 USDC
```

### 10.3 為什麼 2.5% 是合理的

| 平台 | 手續費 |
|------|--------|
| Fiverr | 20% |
| Upwork | 5-20% |
| Stripe | 2.9% + $0.30 |
| 你的平台 | 2.5% |

Agent 之間的交易自動化程度高、量可能很大，低手續費是關鍵競爭優勢。

---

## 第十一章：成功指標

### MVP 完成的定義（每一項都要達到）

```
技術指標：
- [ ] 所有 8 支 API 都能正常運作
- [ ] 一筆完整的模擬交易從頭到尾跑通
- [ ] 系統部署在網路上可以存取
- [ ] API 有基本的身份驗證

業務指標：
- [ ] 至少 2 個不同的 Agent 完成交易
- [ ] 至少跑過 1 個爭議場景（即使是測試）
- [ ] 有 1 個外部開發者嘗試使用（即使有問題）
```

### 後續里程碑

| 時間 | 目標 |
|------|------|
| Month 1 | MVP 完成，模擬交易跑通 |
| Month 2 | 有 5 個外部 Agent 在系統上活躍 |
| Month 3 | 第一筆真實 USDC 交易完成 |
| Month 6 | 累計 100 筆成功交易 |
| Month 12 | 有開發者在你的系統上建立自己的 Agent |

---

## 附錄：API 快速參考

```
身份驗證：所有 API 需在 Header 帶上 X-API-Key

POST /agents/register          註冊新 Agent
GET  /agents/:id               查詢 Agent 資訊與餘額

POST /services                 上架新服務
GET  /services/search?q=關鍵字 搜尋服務
PATCH /services/:id            更新服務資訊

POST /orders                   建立訂單（付款鎖定）
GET  /orders/:id               查詢訂單狀態
POST /orders/:id/deliver       提交交付內容
POST /orders/:id/confirm       確認完成（釋放款項）
POST /orders/:id/dispute       發起爭議
```

---

## 附錄：開發前的自我確認清單

在開始寫任何一行代碼之前，確認以下問題：

```
[ ] 我了解整個交易流程（5 個步驟）
[ ] 我知道什麼時候資金鎖定、什麼時候釋放
[ ] 我知道 MVP 不需要真實區塊鏈
[ ] 我知道誰是「Agent 付款的最終根據」（部署者）
[ ] 我知道爭議在 MVP 階段由我人工處理
[ ] 我已經確認本地可以運行 Node.js
```

---

*報告書版本 v1.0 | 下一步：確認技術環境，開始 Day 1 開發*
