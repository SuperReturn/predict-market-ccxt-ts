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

> **Slippage risk:** The Betfair hedge leg is executed as a **market order immediately after** the Polymarket fill. On thin NBA lines the available lay/back price may be 0.2–0.5% worse than the last observed quote by the time our order lands. A `BF_SLIPPAGE_BUFFER` (default 0.3%) is baked into the minimum edge requirement to guard against this.

---

### Key Terms

| Term | Meaning |
|------|---------|
| **BACK** | The standard bet on Betfair Exchange: you bet an outcome **will** happen. Backing Celtics at odds 2.10 (implied 47.6%) means you profit if Celtics win. Equivalent to *buying* the outcome. |
| **LAY** | The opposite of BACK: you act as the bookmaker, betting an outcome will **not** happen. Laying Celtics at odds 2.18 (implied 45.9%) means you collect the backer's stake if Celtics lose, but must pay out if they win. Equivalent to *selling* the outcome. |
| **tick** | The minimum price increment. On Polymarket, 1 tick = 1% (0.01). A market at bid=43% / ask=44% has a 1-tick spread; bid=42% / ask=44% is a 2-tick spread. |
| **Net edge/shr** | Net profit per $1 share after Betfair commission **and** before slippage buffer. Scenario A formula: `bfLayImplied × (1 − BF_COMM) − makerPrice`. This is the locked profit per share if both legs execute at quoted prices. |
| **drift** | When Betfair odds move **adversely** after an order is posted. Adverse = LAY implied **falls** (for BUY arbs) or BACK implied **rises** (for SELL arbs). `BF_CANCEL_DRIFT` (1.5%) is an **absolute** threshold measured on the **hedge-side price only**. Favorable drift (edge widens) does NOT trigger a cancel. If adverse drift exceeds the threshold, the pending Polymarket order is cancelled and state resets. |
| **TTL** | *Time To Live* — the maximum time a posted Polymarket order can remain unfilled before being auto-cancelled. Controlled by `ORDER_TTL_MS` (default 5 minutes). After expiry, state resets to `WATCHING`. |

---

### Two Arb Scenarios

#### Scenario A — BUY Polymarket + LAY Betfair

Triggered when the exact per-tick net edge is large enough:

```
Entry condition:
  netEdge ≥ REQUIRED_NET_EDGE + BF_SLIPPAGE_BUFFER

where:
  makerPrice = polyBid + POLY_TICK          ← post at best-bid + 1 tick
  netEdge    = bfLayImplied × (1 − BF_COMM) − makerPrice

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
Entry condition:
  netEdge ≥ REQUIRED_NET_EDGE + BF_SLIPPAGE_BUFFER

where:
  makerPrice = polyAsk − POLY_TICK          ← post at best-ask − 1 tick
  netEdge    = makerPrice − bfBackImplied × (1 − BF_COMM)

On fill → BACK outcome on Betfair Exchange (bet it WINS)
```

---

### Worked Example — Scenario A

#### Why 1-tick spread provides NO maker advantage

```
Celtics:  bid=43%  ask=44%  spread=1 tick

Posting BUY at: bid + 1 tick = 43% + 1% = 44%  ← equals the ask price
```

When `bid + 1 tick = ask`, our limit order sits **at** the current ask. On Polymarket's CLOB this order will be matched immediately against any resting ask, making us effectively a **taker** (crossing the spread). There is zero maker benefit in a 1-tick spread scenario — we are still paying full spread cost.

#### 2-tick spread example (genuine maker advantage)

**Market snapshot:**

| | Polymarket | Betfair |
|---|---|---|
| Celtics bid/ask | 42% / 44% | back=2.10, lay=2.18 |
| Celtics implied | mid=43% | back=47.6%, lay=45.9% |

```
Celtics:  bid=42%  ask=44%  spread=2 ticks

Maker BUY at: 42% + 1% = 43%   ← inside the spread, saves 1% vs taker

Net edge = bfLayImplied × (1 − BF_COMM) − makerPrice
         = 45.9% × (1 − 5%) − 43%
         = 43.6% − 43%
         = 0.6%  (vs BF_SLIPPAGE_BUFFER 0.3% → passes filter ✓)

vs. Taker BUY at: 44%
Net edge = 45.9% × 0.95 − 44% = 43.6% − 44% = −0.4%  ✗ (taker loses)
```

Maker saves **1% per share** entry cost — that 1% directly determines whether the trade is profitable at all.

---

### State Machine

Each (game, outcome) pair progresses through these states:

```
WATCHING
  │
  ├── per-tick exact: netEdge ≥ REQUIRED_NET_EDGE + BF_SLIPPAGE_BUFFER
  │
  ▼
ORDER_POSTED  ──────────────────────────────┐
  │                                         │ TTL expired (5 min)
  │ BF adverse drift > BF_CANCEL_DRIFT      │ or BF moved adversely
  │ (hedge-side only, absolute)             │
  ▼                                         ▼
POLY_FILLED                             WATCHING (reset)
  │
  ▼
HEDGED  (Betfair market order placed)
  │
  ▼
(await settlement)
```

---

### Why the Static MAKER_THRESHOLD Was Removed

The original code used a fixed `MAKER_THRESHOLD = 2.5%` as a "quick pre-filter" before computing the exact `netEdge`. This caused two real problems:

**Problem 1 — missed arbs on heavy underdogs:**

```
25% underdog true minimum gap:
  gap_min = REQUIRED_NET_EDGE + BF_COMM × bfImplied
          = 0.5% + 5% × 25% = 1.75%

A 2.0% gap is genuinely profitable but the 2.5% pre-filter rejects it.
```

**Problem 2 — false signals on heavy favorites:**

```
70% favorite true minimum gap:
  gap_min = 0.5% + 5% × 70% = 4.0%

A 2.5% gap appears to pass the pre-filter but netEdge is actually negative.
The second exact check would catch this, but the conceptual threshold misled.
```

**Fix:** The pre-filter is removed entirely. Every tick runs the exact calculation:

```
netEdge = bfLayImplied × (1 − BF_COMM) − makerPrice   (BUY case)
netEdge = makerPrice − bfBackImplied × (1 − BF_COMM)  (SELL case)

Trigger: netEdge ≥ REQUIRED_NET_EDGE + BF_SLIPPAGE_BUFFER
```

Modern hardware handles this O(1) per-tick math trivially. The dynamic minimum gap by probability is now implicit in the exact formula rather than approximated by a constant.

---

### Risks & Limitations

| Risk | Description | Mitigation in code |
|------|-------------|-------------------|
| **Betfair taker slippage** | Market order after fill may execute at worse price | `BF_SLIPPAGE_BUFFER` (0.3%) deducted from net edge threshold |
| **1-tick spread = no maker benefit** | `bid+1tick = ask` means our order crosses the spread | Code still works, but net edge check will filter it out on thin markets |
| **Small position size ($50)** | $50 stake yields $0.30–$1.50 gross profit; small Poly maker orders can sit unfilled for minutes | Increase `POSITION_SIZE_USDC` only after validating fill rates. $50 is test-only. |
| **Polymarket API rate limits** | Frequent `fetchOrder` polling (every 15 s) or burst order placement can trigger 429s | `ORDER_POLL_INTERVAL_MS` default 15 s is conservative; add exponential backoff if 429s appear |
| **Partial fills** | Order may fill in multiple increments | `hedgedShares` field tracks already-hedged shares; each new increment triggers its own Betfair hedge |
| **Order rejection** | Polymarket may reject the order (insufficient balance, market paused) | `createOrder` errors are caught and logged; state stays `WATCHING` so the next tick re-evaluates |
| **Betfair API credentials** | Requires `BETFAIR_APP_KEY` + `BETFAIR_SESSION_TOKEN` for live hedging | Missing credentials set state to `FAILED` with clear log message |

---

### Configuration

Key constants in `scripts/ws/nba.ts`:

| Constant | Default | Description |
|---|---|---|
| `REQUIRED_NET_EDGE` | `0.005` | Exact min net profit per share after BF commission (0.5%) |
| `BF_SLIPPAGE_BUFFER` | `0.003` | Extra buffer for Betfair market-order slippage (0.3%). Combined threshold = 0.8% |
| `BF_COMMISSION` | `0.05` | Betfair commission on net wins (5%) |
| `BF_CANCEL_DRIFT` | `0.015` | Cancel if BF hedge-side implied drifts **adversely** by 1.5% (absolute, hedge-side only) |
| `ORDER_TTL_MS` | `300,000` | Cancel stale orders after 5 minutes |
| `ORDER_POLL_INTERVAL_MS` | `15,000` | Poll Polymarket fills every 15 s (conservative to avoid rate limits) |
| `POSITION_SIZE_USDC` | `50` | USD value per arb leg — **test-only size**; increase carefully in live trading |
| `DRY_RUN` | `true` | **Set false only for live trading** |
