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
