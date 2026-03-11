# Pre-Match Arbitrage: Polymarket × Betfair

> Strategy guide for the `scripts/ws/nba.ts` monitor.
>
> **Current strategy: Polymarket MAKER + Betfair TAKER**

---
### Strategy Overview

The script implements a **maker-taker cross-venue arbitrage**:

| Leg | Role | Action |
|-----|------|--------|
| Polymarket | **Maker** | Post a GTC limit order *inside* the spread |
| Betfair Exchange | **Taker** | Execute immediately once Polymarket fills |

Instead of crossing Polymarket's spread (which costs ~1% per trade), we post a limit order *between* the bid and ask, waiting for a taker to fill us. Because Polymarket charges **0% maker fee**, our only cost is the Betfair Exchange commission (2–5% on net winnings).

---

### Key Terms

| Term | Meaning |
|------|---------|
| **BACK** | The standard bet on Betfair Exchange: you bet an outcome **will** happen. Backing Celtics at odds 2.10 (implied 47.6%) means you profit if Celtics win. Equivalent to *buying* the outcome. |
| **LAY** | The opposite of BACK: you act as the bookmaker, betting an outcome will **not** happen. Laying Celtics at odds 2.18 (implied 45.9%) means you collect the backer's stake if Celtics lose, but must pay out if they win. Equivalent to *selling* the outcome. |
| **tick** | The minimum price increment. On Polymarket, 1 tick = 1% (0.01). A market at bid=43% / ask=44% has a 1-tick spread; bid=42% / ask=44% is a 2-tick spread. |
| **Net edge/shr** | Net profit per $1 share after Betfair commission. Scenario A formula: `bfLayImplied × (1 − BF_COMM) − makerPrice`. This is the exact locked profit per share if both legs execute. |
| **drift** | When Betfair odds move adversely after an order is posted. E.g., BF LAY implied falls from 46% → 44% while waiting for Polymarket to fill — the arb gap shrinks or disappears. If drift exceeds `BF_CANCEL_DRIFT` (1.5%), the pending order is cancelled and state resets. |
| **TTL** | *Time To Live* — the maximum time a posted Polymarket order can remain unfilled before being auto-cancelled. Controlled by `ORDER_TTL_MS` (default 5 minutes). After expiry, state resets to `WATCHING`. |

---

### Two Arb Scenarios

#### Scenario A — BUY Polymarket + LAY Betfair

Triggered when Betfair LAY implied probability is significantly above Polymarket.

```
Betfair LAY implied > polyBid + POLY_TICK + MAKER_THRESHOLD (default 2.5%)

Maker price  = polyBid + POLY_TICK          ← post at best-bid + 1 tick
Net edge/shr = bfLayImplied × (1 − BF_COMM) − makerPrice

On fill → LAY outcome on Betfair Exchange (bet it does NOT win)
```

**P&L (example, Celtics):**

| Outcome | Polymarket leg | Betfair leg | Net |
|---------|---------------|-------------|-----|
| Celtics WIN  | +$1/share (payout) | −liability (lay loss) | hedged |
| Celtics LOSE | −makerPrice/share  | +stake (lay win, less commission) | **locked profit** |

#### Scenario B — SELL Polymarket + BACK Betfair

Triggered when Polymarket is significantly above Betfair BACK implied.

```
polyAsk − POLY_TICK > bfBackImplied + MAKER_THRESHOLD (default 2.5%)

Maker price  = polyAsk − POLY_TICK          ← post at best-ask − 1 tick
Net edge/shr = makerPrice − bfBackImplied × (1 − BF_COMM)

On fill → BACK outcome on Betfair Exchange (bet it WINS)
```

---

### Worked Example — Scenario A

**Market snapshot:**

| | Polymarket | Betfair |
|---|---|---|
| Celtics bid/ask | 43% / 44% | back=2.10, lay=2.18 |
| Celtics implied | mid=43.5% | back=47.6%, lay=45.9% |
| Spurs bid/ask | 56% / 57% | back=1.74, lay=1.77 |

**Delta:** Betfair LAY implied for Celtics (45.9%) > Poly mid (43.5%) by **2.4%** → approaches threshold.

**Arb action (if gap ≥ 2.5%):**
- Post **GTC BUY** Celtics at **44%** (`polyBid + 1 tick` = 43% + 1% = 44%).

> **Note on tick size:** In this snapshot the spread is exactly 1 tick wide (bid=43%, ask=44%), so posting at `bid + 1 tick` coincides with the ask — maker and taker price converge. The maker advantage is most pronounced when the spread is **2+ ticks wide** (e.g., bid=43%, ask=45%); see "More favorable example" below.

**More favorable example** (2-tick spread):

```
Celtics:  bid=42%  ask=44%  spread=2%
Betfair LAY implied = 46%

Maker BUY at: 42% + 1% = 43%   ← inside the spread
Gross edge  = 46% − 43% = 3%
BF commission: 46% × 5% = 2.3%
Net edge/share ≈ 3% − 0.7% effective = 2.3%  ✓

vs. Taker BUY at: 44%
Gross edge  = 46% − 44% = 2%
BF commission: same
Net edge/share ≈ 2% − 0.7% = 1.3%
```

Maker saves **1% per share** entry cost → directly added to locked profit.

---

### State Machine

Each (game, outcome) pair progresses through these states:

```
WATCHING
  │
  ├── gap ≥ MAKER_THRESHOLD AND net edge ≥ REQUIRED_NET_EDGE
  │
  ▼
ORDER_POSTED  ──────────────────────────────┐
  │                                         │ TTL expired (5 min)
  │ Betfair drift > BF_CANCEL_DRIFT (1.5%)  │ or BF moved adversely
  │                                         │
  ▼                                         ▼
POLY_FILLED                             WATCHING (reset)
  │
  ▼
HEDGED  (Betfair order placed)
  │
  ▼
(await settlement)
```

---

### How MAKER_THRESHOLD Is Derived

`MAKER_THRESHOLD = 0.025` (2.5%) is **not** an arbitrary number — it is a flat approximation of the minimum gap needed so that the Betfair commission cannot eat the entire profit.

The exact minimum gap depends on the team's probability:

```
gap_min = REQUIRED_NET_EDGE + BF_COMMISSION × bfImplied
        = 0.5%             + 5%             × bfImplied

Examples by team probability:
  50/50 game  → 0.5% + 5% × 50% = 0.5% + 2.5% = 3.0%
  70% fav     → 0.5% + 5% × 70% = 0.5% + 3.5% = 4.0%
  25% dog     → 0.5% + 5% × 25% = 0.5% + 1.25% = 1.75%
```

Because the true minimum varies by team probability, 2.5% is used as a **quick pre-filter** for an average ~50% game. For any order that passes this check, the code then runs the **exact** `netEdge` calculation:

```typescript
// BUY case (from detectArbOpportunity in nba.ts)
const netEdge = bfLayImplied * (1 - BF_COMMISSION) - makerPrice;
if (gap >= MAKER_THRESHOLD && netEdge >= REQUIRED_NET_EDGE) { ... }
```

The `REQUIRED_NET_EDGE` check is the **real guard**. `MAKER_THRESHOLD` is only a first-pass speed filter that avoids computing `netEdge` on every tick for every outcome. Both must pass before an order is posted.

**Two-check flow:**
```
gap ≥ 2.5%?  →  No  → skip (quick reject, no further math)
             →  Yes → compute exact netEdge
                       netEdge ≥ 0.5%?  →  No  → skip
                                         →  Yes → post maker order
```

> To lower the effective threshold for heavy underdogs (bfImplied ~25%), you can reduce `MAKER_THRESHOLD` to `0.015`. To protect against heavy favorites (bfImplied ~70%+), raise it to `0.035`.
---

### Configuration

Key constants in `scripts/ws/nba.ts`:

| Constant | Default | Description |
|---|---|---|
| `MAKER_THRESHOLD` | `0.025` | Min gap pre-filter (2.5%) — see derivation above |
| `REQUIRED_NET_EDGE` | `0.005` | Exact min net profit per share after BF commission (0.5%) |
| `BF_COMMISSION` | `0.05` | Betfair commission on net wins (5%) |
| `BF_CANCEL_DRIFT` | `0.015` | Cancel if BF implied drifts 1.5% after posting |
| `ORDER_TTL_MS` | `300,000` | Cancel stale orders after 5 minutes |
| `ORDER_POLL_INTERVAL_MS` | `15,000` | Poll Polymarket fills every 15 s |
| `POSITION_SIZE_USDC` | `50` | USD value per arb leg |
| `DRY_RUN` | `true` | **Set false only for live trading** |