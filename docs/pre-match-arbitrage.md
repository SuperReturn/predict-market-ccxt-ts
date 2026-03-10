# Pre-Match Arbitrage: Polymarket × Betfair

> Strategy guide for the `scripts/ws/nba.ts` monitor.

---

## English

### What Is Pre-Match Arbitrage?

Pre-match arbitrage exploits **price discrepancies** between two platforms that quote odds on the same event before it begins. Because Polymarket and Betfair price the same NBA game outcome independently, their implied probabilities occasionally diverge. When the combined implied probability of all outcomes sums to **less than 100%** (after fees), a risk-free profit can be locked in by betting both sides simultaneously.

```
Arb exists when:
  (1 / Polymarket_Yes_price) + (1 / Betfair_back_odds_opponent) < 1  (after fees)
```

---

### How the Two Platforms Work

| | Polymarket | Betfair Exchange |
|---|---|---|
| **Price unit** | Share price $0–$1 | Decimal back / lay odds |
| **Win payout** | $1 per share | Stake × (back odds − 1) |
| **Fees** | ~0% maker, ~0% taker | 2–5% commission on net win |
| **Liquidity** | CLOB (central limit order book) | Exchange matching |
| **Settlement** | On-chain smart contract | Betfair rules |

#### Converting to implied probability

```
Polymarket Yes price  →  implied prob  =  price          (e.g. $0.41 = 41%)
Betfair back odds     →  implied prob  =  1 / back odds  (e.g. 2.70 = 37.0%)
Betfair lay odds      →  implied prob  =  1 / lay odds   (e.g. 2.80 = 35.7%)
```

---

### Step-by-Step Process

1. **Monitor** — `nba.ts` streams Polymarket CLOB orderbook updates in real time and polls Betfair every 60 s.
2. **Detect** — Compare mid-price (Polymarket) against back-implied probability (Betfair) for each team.
3. **Calculate** — Run the hedge formula below to size each leg and confirm net profit > 0 after fees.
4. **Execute** — Place both legs as close to simultaneously as possible (liquidity risk otherwise).
5. **Settle** — Both platforms resolve on the same result; profits are realized at settlement.

---

### Worked Example

#### Market snapshot (hypothetical)

| Outcome | Polymarket (mid) | Betfair back | Betfair lay | Betfair implied |
|---|---|---|---|---|
| Celtics win | 40.5% ($0.405) | 2.70 | 2.80 | 37.0% |
| Spurs win | 59.5% ($0.595) | 1.55 | 1.60 | 64.5% |

**Delta detected:** Celtics 40.5% on Polymarket vs 37.0% on Betfair → Polymarket is overpricing Celtics.

#### Arb logic

- **Polymarket is too high on Celtics** → sell (buy Spurs Yes on Polymarket = equivalent to laying Celtics).
- **Betfair offers good back odds on Celtics** → back Celtics on Betfair.

Buy the cheap side (Betfair), sell the expensive side (Polymarket).

---

### Hedge Sizing Formula

Let:
- `B` = Betfair stake on Celtics back @ 2.70
- `P` = Polymarket payout target on Spurs Yes (amount you receive if Spurs win)
- `p` = Polymarket Spurs Yes share price = 0.595 → cost = `P × 0.595`
- `profit` = locked profit (same in both scenarios)

**Scenario equations:**

```
Celtics win:   (2.70 − 1) × B  −  P × 0.595  =  profit   →  1.70B − 0.595P = profit
Spurs win:    −B               +  P − P×0.595  =  profit   →  −B + 0.405P = profit
```

**Setting equal and solving (`profit = X`):**

```
1.70B − 0.595P = −B + 0.405P
2.70B = P
→  P = 2.70 × B
```

With **B = $1,000**:

```
P  = 2.70 × 1,000 = $2,700     ← Polymarket payout if Spurs win
Cost of Spurs Yes = 2,700 × 0.595 = $1,606.50
```

---

### P&L Breakdown

| | Betfair leg | Polymarket leg | **Net profit** |
|---|---|---|---|
| **Celtics win** | +$1,700 | −$1,606.50 | **+$93.50** |
| **Spurs win** | −$1,000 | +$1,093.50 | **+$93.50** |

**Total capital deployed:** $1,000 + $1,606.50 = **$2,606.50**  
**Locked profit (pre-fee):** $93.50  
**ROI (pre-fee):** 3.58%

#### After Betfair commission (e.g. 5%)

```
Celtics win: +$1,700 × (1 − 0.05) = +$1,615  →  net = $1,615 − $1,606.50 = +$8.50
Spurs win:   Betfair leg unchanged (loss, no commission) →  net = +$93.50
```

> Commission only applies to **net winning** on Betfair. Adjust the stake `B` upward to compensate and still lock in symmetric profit.

---

### Real-World Caveats

| Risk | Description |
|---|---|
| **Fee erosion** | Betfair charges 2–5% on net wins. True arb edges of <2% vanish after fees. |
| **Execution slippage** | Both legs must be filled at the quoted price. Thin books move fast. |
| **Resolution mismatch** | Rare, but Polymarket and Betfair rules could differ (e.g. overtime handling). |
| **Liquidity risk** | Partial fills leave you unhedged on one leg. |
| **Currency / settlement lag** | Polymarket settles on-chain; Betfair settles immediately. Timing risk is low but non-zero. |

---

### When to Look for Arb

- **High-liquidity window:** 2–6 hours before tip-off — books are deep, spreads tight.
- **News shocks:** Injury reports, weather, lineup changes cause one platform to lag the other.
- **Late-session drift:** Polymarket CLOB can move on small retail flow without Betfair catching up immediately.

The `nba.ts` script surfaces the **delta** on every tick so you can evaluate opportunities in real time.

---

---

## 中文

### 什麼是賽前套利？

賽前套利是利用兩個平台在**同一場賽事開始前**對同一結果的報價差異來獲利。Polymarket 和 Betfair 各自獨立定價同一場 NBA 比賽，因此隱含機率偶爾會出現分歧。當所有結果的隱含機率加總**低於 100%**（扣費後），就可以同時在兩邊下注，鎖定無風險利潤。

```
套利條件：
  (1 / Polymarket_Yes 價格) + (1 / Betfair_back 賠率_對手) < 1  （扣費後）
```

---

### 兩個平台的運作方式

| | Polymarket | Betfair Exchange |
|---|---|---|
| **計價單位** | 股份價格 $0–$1 | 十進位 back / lay 賠率 |
| **贏時賠付** | 每股 $1 | 注額 × (back 賠率 − 1) |
| **手續費** | ~0% maker / taker | 淨盈利的 2–5% |
| **流動性** | CLOB 中央限價委託簿 | 交易所撮合 |
| **結算** | 鏈上智能合約 | Betfair 規則 |

#### 轉換為隱含機率

```
Polymarket Yes 價格  →  隱含機率  =  價格           （例：$0.41 = 41%）
Betfair back 賠率    →  隱含機率  =  1 / back 賠率  （例：2.70 = 37.0%）
Betfair lay 賠率     →  隱含機率  =  1 / lay 賠率   （例：2.80 = 35.7%）
```

---

### 操作步驟

1. **監控** — `nba.ts` 即時串流 Polymarket CLOB 訂單簿更新，每 60 秒輪詢一次 Betfair。
2. **偵測** — 比較每隊的 Polymarket mid-price 與 Betfair back 隱含機率。
3. **計算** — 用下方的對沖公式計算各腿注額，確認扣費後淨利潤 > 0。
4. **執行** — 兩腿盡量同時下注（否則有流動性風險）。
5. **結算** — 兩平台依相同結果結算，利潤實現。

---

### 具體範例

#### 市場快照（假設數值）

| 結果 | Polymarket（mid） | Betfair back | Betfair lay | Betfair 隱含 |
|---|---|---|---|---|
| Celtics 贏 | 40.5%（$0.405） | 2.70 | 2.80 | 37.0% |
| Spurs 贏 | 59.5%（$0.595） | 1.55 | 1.60 | 64.5% |

**偵測到的差值（Delta）：** Celtics 在 Polymarket 40.5% vs Betfair 37.0% → Polymarket 把 Celtics 定得太高。

#### 套利邏輯

- **Polymarket 的 Celtics 太貴** → 在 Polymarket 買 Spurs Yes（= 等同於 lay Celtics）。
- **Betfair 的 Celtics back 賠率划算** → 在 Betfair back Celtics。

買入便宜的一邊（Betfair），賣出昂貴的一邊（Polymarket）。

---

### 對沖注額公式

設：
- `B` = 在 Betfair back Celtics 的注額（賠率 2.70）
- `P` = Polymarket Spurs Yes 目標賠付金額（若 Spurs 贏，你收到的金額）
- `p` = Polymarket Spurs Yes 股價 = 0.595 → 成本 = `P × 0.595`
- `profit` = 鎖定利潤（兩種情況相同）

**情境方程式：**

```
Celtics 贏：  (2.70 − 1) × B  −  P × 0.595  =  profit   →  1.70B − 0.595P = profit
Spurs 贏：   −B               +  P − P×0.595  =  profit   →  −B + 0.405P = profit
```

**令兩式相等，求解（profit = X）：**

```
1.70B − 0.595P = −B + 0.405P
2.70B = P
→  P = 2.70 × B
```

以 **B = $1,000** 為例：

```
P  = 2.70 × 1,000 = $2,700     ← Polymarket Spurs 贏時的賠付目標
Spurs Yes 成本 = 2,700 × 0.595 = $1,606.50
```

---

### 損益明細

| | Betfair 腿 | Polymarket 腿 | **淨利潤** |
|---|---|---|---|
| **Celtics 贏** | +$1,700 | −$1,606.50 | **+$93.50** |
| **Spurs 贏** | −$1,000 | +$1,093.50 | **+$93.50** |

**總投入資金：** $1,000 + $1,606.50 = **$2,606.50**  
**鎖定利潤（扣費前）：** $93.50  
**報酬率（扣費前）：** 3.58%

#### 扣除 Betfair 抽成後（例如 5%）

```
Celtics 贏：+$1,700 × (1 − 0.05) = +$1,615  →  淨利 = $1,615 − $1,606.50 = +$8.50
Spurs 贏：  Betfair 輸，不收手續費            →  淨利 = +$93.50
```

> Betfair 抽成只針對**淨獲利**，輸的時候不抽。可將注額 `B` 略微提高來補償，讓兩邊利潤對稱。

---

### 真實風險提醒

| 風險 | 說明 |
|---|---|
| **手續費侵蝕** | Betfair 淨盈利抽 2–5%，邊際 <2% 的套利扣費後可能消失。 |
| **執行滑價** | 兩腿都需以報價成交，薄流動性的盤口變動很快。 |
| **結算規則差異** | 罕見，但 Polymarket 與 Betfair 的規則偶爾略有不同（如加時處理）。 |
| **流動性風險** | 部分成交會讓一腿未對沖。 |
| **結算時差** | Polymarket 鏈上結算；Betfair 即時結算。時間差風險低但存在。 |

---

### 何時尋找套利機會

- **高流動性窗口：** 開賽前 2–6 小時，深度最好，價差最窄。
- **突發消息衝擊：** 傷病報告、陣容變動、天氣因素，可能讓某一平台定價滯後。
- **晚場漂移：** Polymarket CLOB 可能因散戶流量波動，Betfair 來不及跟進。

`nba.ts` 在每次 tick 都計算並顯示 **Delta**，讓你即時評估套利機會。
