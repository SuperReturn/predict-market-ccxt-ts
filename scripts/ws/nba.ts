import dotenv from 'dotenv';
import {
  type CreateOrderParams,
  type Market,
  type Order,
  type Orderbook,
  type OrderbookUpdate,
  OrderbookUtils,
  OrderSide,
  OrderStatus,
  Polymarket,
  PolymarketWebSocket,
  createExchange,
} from '../../src/index.js';

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const GAMMA_API = 'https://gamma-api.polymarket.com';
/** Polymarket NBA 2026 daily series ID */
const NBA_SERIES_ID = 10345;
/** Minimum USD liquidity to include a Polymarket game */
const MIN_LIQUIDITY = 1_000;
/** Only include games whose start time is within this window from now */
const PRE_GAME_LOOKAHEAD_MS = 48 * 60 * 60 * 1_000;
/** Betfair data is refreshed at most once per this interval (ms) */
const BETFAIR_COOLDOWN_MS = 60_000;
/**
 * Minimum time before tip-off to still track a game.
 * Games starting sooner than this are skipped.
 */
const MIN_PRE_GAME_MS = 30 * 60 * 1_000;

// ─── Maker-Strategy Config ────────────────────────────────────────────────────

/** Minimum price step on Polymarket (1 cent) */
const POLY_TICK = 0.01;

/**
 * Required minimum net edge per share after Betfair commission.
 * Every tick runs the exact per-tick calculation:
 *   netEdge = bfLayImplied × (1 − BF_COMM) − makerPrice   (BUY case)
 *   netEdge = makerPrice − bfBackImplied × (1 − BF_COMM)  (SELL case)
 * No static pre-filter is used — this alone gates all order decisions.
 */
const REQUIRED_NET_EDGE = 0.005;

/**
 * Slippage reserve for the Betfair taker leg.
 * The Betfair hedge is sent as a market order immediately after Polymarket
 * fill. On thin NBA lines the observed best lay/back price can slip
 * 0.2–0.5% before the order lands. Only arbs with
 *   netEdge ≥ REQUIRED_NET_EDGE + BF_SLIPPAGE_BUFFER
 * are entered, so marginal arbs don't turn negative after slippage.
 */
const BF_SLIPPAGE_BUFFER = 0.003;

/** Betfair commission rate applied to net winnings on the exchange leg. */
const BF_COMMISSION = 0.05;

/**
 * Cancel a Polymarket maker order if Betfair implied moves more than this
 * from the implied at the time of posting (adverse drift).
 */
const BF_CANCEL_DRIFT = 0.015;

/** Cancel any unfilled Polymarket maker order after this many ms. */
const ORDER_TTL_MS = 5 * 60 * 1_000;

/** How often to poll open orders for fill status (ms). */
const ORDER_POLL_INTERVAL_MS = 15 * 1_000;

/**
 * USD value to risk per arb leg.
 * Actual shares placed = POSITION_SIZE_USDC / makerPrice (for BUY),
 * or POSITION_SIZE_USDC / (1 − makerPrice) (for SELL, sized on the payout).
 * Keep small during testing.
 */
const POSITION_SIZE_USDC = 50;

/**
 * DRY_RUN = true  → detect and log arb opportunities, place NO real orders.
 * DRY_RUN = false → place real Polymarket maker orders and Betfair hedge orders.
 *
 * Set to false only after validating credentials and understanding all risks.
 */
const DRY_RUN = true;

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeamPrice {
  bid: number | null;
  ask: number | null;
  mid: number | null;
}

interface GameToken {
  tokenId: string;
  outcome: string;
}

/**
 * State machine for one arb position:
 *
 *   WATCHING      – monitoring for opportunity, no open order
 *   ORDER_POSTED  – GTC maker order posted on Polymarket, waiting for fill
 *   POLY_FILLED   – Polymarket order filled, executing Betfair hedge
 *   HEDGED        – both legs executed, waiting for settlement
 *   FAILED        – one or both legs failed; requires manual review
 */
type ArbState = 'WATCHING' | 'ORDER_POSTED' | 'POLY_FILLED' | 'HEDGED' | 'FAILED';

/** One active arb position per (game, outcome) pair */
interface ActiveOrder {
  orderId: string;
  tokenId: string;
  game: NbaGame;
  outcome: string;
  /**
   * 'buy'  → BUY outcome on Polymarket (maker) + LAY outcome on Betfair (taker)
   * 'sell' → SELL outcome on Polymarket (maker) + BACK outcome on Betfair (taker)
   */
  side: 'buy' | 'sell';
  makerPrice: number;
  /** Number of Polymarket shares in the order */
  sizeShares: number;
  /** Fill price received (set after confirmation) */
  fillPrice: number | null;
  /** Cumulative Polymarket shares filled so far (updated on each poll) */
  filledShares: number | null;
  /** Cumulative shares already sent to Betfair as hedge (tracks incremental partial fills) */
  hedgedShares: number;
  postedAt: number;
  /** Betfair implied probability at the time of posting (used for drift detection) */
  bfImpliedAtPost: number;
  /** Betfair outcome label matching game.betfairMarket.outcomes */
  bfOutcome: string;
  /** Betfair decimal odds for the hedge leg (LAY odds for BUY side, BACK odds for SELL side) */
  bfOdds: number;
  state: ArbState;
}

interface NbaGame {
  slug: string;
  question: string;
  outcomes: string[];
  tokens: GameToken[];
  polyPrices: Record<string, TeamPrice>;
  betfairMarket: Market | null;
  gameStartTime: Date | null;
  /** At most one active order per outcome */
  activeOrders: Map<string, ActiveOrder>;
}

interface ArbOpportunity {
  side: 'buy' | 'sell';
  /** Price at which to post the maker limit order on Polymarket */
  makerPrice: number;
  /** Number of shares to order */
  sizeShares: number;
  /** Betfair implied probability driving the trade */
  bfImplied: number;
  /** Betfair outcome label */
  bfOutcome: string;
  /** Betfair decimal odds for the hedge leg */
  bfOdds: number;
  /** Estimated net profit per share after BF commission */
  netEdgePerShare: number;
}

// ─── State ────────────────────────────────────────────────────────────────────

/** slug → game */
const games = new Map<string, NbaGame>();
/** tokenId → game */
const tokenToGame = new Map<string, NbaGame>();

let lastBetfairFetch = 0;
let allBetfairMarkets: Market[] = [];
let polyExchange: Polymarket | null = null;

// ─── Betfair Exchange Execution Client ────────────────────────────────────────

/**
 * Minimal Betfair Exchange JSON-RPC client for order placement.
 *
 * This is SEPARATE from The Odds API (which is read-only).
 * Requires BETFAIR_APP_KEY and BETFAIR_SESSION_TOKEN in .env.
 *
 * To obtain a session token:
 *   curl -X POST https://identitysso-cert.betfair.com/api/certlogin \
 *     -H "X-Application: <APP_KEY>" \
 *     -d "username=<USER>&password=<PASS>"
 */
class BetfairExchangeClient {
  private readonly endpoint = 'https://api.betfair.com/exchange/betting/json-rpc/v1';
  private readonly appKey: string;
  private readonly sessionToken: string;

  constructor(appKey: string, sessionToken: string) {
    this.appKey = appKey;
    this.sessionToken = sessionToken;
  }

  private get headers() {
    return {
      'X-Application': this.appKey,
      'X-Authentication': this.sessionToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /**
   * Find the native Betfair marketId and runner selectionIds for an NBA game.
   * Uses listMarketCatalogue to search by time window and market type.
   */
  async findNbaMarket(
    commenceTimeFrom: string,
    commenceTimeTo: string
  ): Promise<
    Array<{
      marketId: string;
      runners: Array<{ selectionId: number; runnerName: string }>;
    }>
  > {
    const payload = {
      jsonrpc: '2.0',
      method: 'SportsAPING/v1.0/listMarketCatalogue',
      params: {
        filter: {
          eventTypeIds: ['6'], // Basketball
          marketTypeCodes: ['MATCH_ODDS'],
          marketStartTime: { from: commenceTimeFrom, to: commenceTimeTo },
        },
        marketProjection: ['RUNNER_DESCRIPTION'],
        maxResults: 50,
      },
      id: 1,
    };

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`Betfair listMarketCatalogue HTTP ${res.status}`);
    const data = (await res.json()) as {
      result?: Array<{
        marketId: string;
        runners: Array<{ selectionId: number; runnerName: string }>;
      }>;
    };
    return data.result ?? [];
  }

  /**
   * Place a BACK or LAY limit order on the Betfair Exchange.
   * Returns the betId on success.
   *
   * @param marketId    Native Betfair marketId (e.g. "1.234567890")
   * @param selectionId Native Betfair runner selectionId
   * @param side        'BACK' or 'LAY'
   * @param price       Betfair decimal odds (e.g. 2.30)
   * @param size        Stake in GBP
   */
  async placeOrder(
    marketId: string,
    selectionId: number,
    side: 'BACK' | 'LAY',
    price: number,
    size: number
  ): Promise<string> {
    const payload = {
      jsonrpc: '2.0',
      method: 'SportsAPING/v1.0/placeOrders',
      params: {
        marketId,
        instructions: [
          {
            selectionId,
            handicap: 0,
            side,
            orderType: 'LIMIT',
            limitOrder: { size, price, persistenceType: 'LAPSE' },
          },
        ],
      },
      id: 1,
    };

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`Betfair placeOrders HTTP ${res.status}`);
    const data = (await res.json()) as {
      result?: {
        status: string;
        instructionReports?: Array<{ betId?: string; errorCode?: string }>;
      };
    };

    const result = data.result;
    if (result?.status !== 'SUCCESS') {
      const errCode = result?.instructionReports?.[0]?.errorCode ?? 'UNKNOWN';
      throw new Error(`Betfair placeOrders failed: ${errCode}`);
    }
    return result.instructionReports?.[0]?.betId ?? '';
  }
}

// ─── Polymarket data fetch ────────────────────────────────────────────────────

async function fetchNbaGamesFromPolymarket(): Promise<NbaGame[]> {
  const now = Date.now();

  const url =
    `${GAMMA_API}/events` +
    `?series_id=${NBA_SERIES_ID}&active=true&closed=false&limit=100` +
    `&order=startDate&ascending=true`;

  console.log('[Polymarket] fetching:', url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);

  const events = (await res.json()) as Array<Record<string, unknown>>;
  console.log(`[Polymarket] NBA events returned: ${events.length}`);

  const result: NbaGame[] = [];
  let skippedStarted = 0;
  let skippedTooClose = 0;
  let skippedFuture = 0;
  let skippedNoMarket = 0;
  let skippedLiquidity = 0;

  for (const ev of events) {
    const gameStartRaw = String(ev.startTime ?? ev.endDate ?? '');
    const gameStart = gameStartRaw ? new Date(gameStartRaw) : null;

    if (gameStart && !Number.isNaN(gameStart.getTime())) {
      const msUntilStart = gameStart.getTime() - now;
      if (msUntilStart <= 0) { skippedStarted++; continue; }
      if (msUntilStart < MIN_PRE_GAME_MS) { skippedTooClose++; continue; }
      if (msUntilStart > PRE_GAME_LOOKAHEAD_MS) { skippedFuture++; continue; }
    } else {
      if (String(ev.period ?? '') !== 'NS') continue;
    }

    const rawMarkets = (ev.markets ?? []) as Array<Record<string, unknown>>;
    const ml = rawMarkets.find((m) => m.sportsMarketType === 'moneyline');

    if (!ml || ml.closed || !ml.active || !ml.acceptingOrders) {
      skippedNoMarket++;
      continue;
    }

    const liquidity = Number(ml.liquidityNum ?? ml.liquidity ?? 0);
    if (liquidity < MIN_LIQUIDITY) { skippedLiquidity++; continue; }

    let outcomes: string[] = [];
    try {
      outcomes = typeof ml.outcomes === 'string'
        ? (JSON.parse(ml.outcomes) as string[])
        : (ml.outcomes as string[]) ?? [];
    } catch { continue; }

    let tokenIds: string[] = [];
    try {
      tokenIds = typeof ml.clobTokenIds === 'string'
        ? (JSON.parse(ml.clobTokenIds) as string[])
        : (ml.clobTokenIds as string[]) ?? [];
    } catch { continue; }

    if (!outcomes.length || !tokenIds.length) continue;

    const tokens: GameToken[] = tokenIds.map((tokenId, i) => ({
      tokenId,
      outcome: outcomes[i] ?? `Outcome${i}`,
    }));

    const polyPrices: Record<string, TeamPrice> = {};
    for (const o of outcomes) {
      polyPrices[o] = { bid: null, ask: null, mid: null };
    }

    result.push({
      slug: String(ev.slug ?? ml.slug ?? ''),
      question: String(ml.question ?? ev.title ?? ''),
      outcomes,
      tokens,
      polyPrices,
      betfairMarket: null,
      gameStartTime: gameStart,
      activeOrders: new Map(),
    });
  }

  console.log(
    `[Polymarket] filter: ` +
    `total=${events.length}  ` +
    `started_skip=${skippedStarted}  ` +
    `too_close_skip=${skippedTooClose}  ` +
    `future_skip=${skippedFuture}  ` +
    `no_market_skip=${skippedNoMarket}  liq_skip=${skippedLiquidity}  ` +
    `✓ accepted=${result.length}`
  );

  return result;
}

// ─── Betfair data fetch ───────────────────────────────────────────────────────

async function fetchBetfairNbaMarkets(oddsApiKey: string): Promise<Market[]> {
  const betfair = createExchange('betfair', { apiKey: oddsApiKey });
  const now = new Date();
  const minStart = new Date(now.getTime() + MIN_PRE_GAME_MS);
  const maxStart = new Date(now.getTime() + PRE_GAME_LOOKAHEAD_MS);
  return betfair.fetchMarkets({
    sportKey: 'basketball_nba',
    markets: 'h2h',
    regions: 'uk',
    bookmakers: 'betfair_ex_uk',
    commenceTimeFrom: minStart.toISOString().slice(0, 19) + 'Z',
    commenceTimeTo: maxStart.toISOString().slice(0, 19) + 'Z',
  });
}

// ─── Matching ─────────────────────────────────────────────────────────────────

function teamNick(name: string): string {
  const parts = name.toLowerCase().replace(/[.]/g, '').trim().split(/\s+/);
  return parts[parts.length - 1] ?? name.toLowerCase();
}

function matchBetfairMarket(game: NbaGame, bfMarkets: Market[]): Market | null {
  const gameNicks = new Set(game.outcomes.map(teamNick));
  for (const bfM of bfMarkets) {
    const bfNicks = bfM.outcomes.map(teamNick);
    if (bfNicks.every((n) => gameNicks.has(n))) return bfM;
  }
  return null;
}

// ─── Arb Detection ───────────────────────────────────────────────────────────

/**
 * Determine whether a maker arb opportunity exists for a given (game, outcome).
 *
 * Two scenarios are checked:
 *
 *  BUY Poly + LAY Betfair
 *    Condition : Betfair LAY implied > polyBid + TICK + MAKER_THRESHOLD
 *    Maker price: polyBid + POLY_TICK  (we become the best bid; takers hit us)
 *    Hedge      : LAY outcome on Betfair once filled
 *
 *  SELL Poly + BACK Betfair
 *    Condition : Betfair BACK implied < polyAsk − TICK − MAKER_THRESHOLD
 *    Maker price: polyAsk − POLY_TICK  (we become the best ask; takers hit us)
 *    Hedge      : BACK outcome on Betfair once filled
 *
 * Net edge calculation (BUY case, team X):
 *   If team X WINS : poly pays $1/share; BF lay liability = sizeShares × (layOdds−1) per unit
 *   If team X LOSES: poly worth $0;      BF lay collects stake (less commission)
 *
 *   Locked edge ≈ bfLayImplied − makerPrice − (bfLayImplied × BF_COMMISSION)
 *               = bfLayImplied × (1 − BF_COMMISSION) − makerPrice
 */
function detectArbOpportunity(
  game: NbaGame,
  outcome: string
): ArbOpportunity | null {
  const p = game.polyPrices[outcome];
  if (!p || p.bid === null || p.ask === null) return null;
  if (!game.betfairMarket) return null;

  // Skip if this outcome already has an active order
  if (game.activeOrders.has(outcome)) return null;

  const bfOutcome = game.betfairMarket.outcomes.find(
    (o) => teamNick(o) === teamNick(outcome)
  );
  if (!bfOutcome) return null;

  const backOdds =
    (game.betfairMarket.metadata.backOdds as Record<string, number> | undefined)?.[bfOutcome];
  const layOdds =
    (game.betfairMarket.metadata.layOdds as Record<string, number> | undefined)?.[bfOutcome];
  if (!backOdds) return null;

  const bfBackImplied = 1 / backOdds;
  const bfLayImplied = layOdds ? 1 / layOdds : null;

  // ── Case 1: BUY Poly + LAY Betfair ─────────────────────────────────────────
  // We post a BUY limit order at polyBid + TICK (improving the best bid).
  // When a seller takes our bid, we immediately LAY on Betfair.
  // NOTE: posting at bid+1tick only provides a maker advantage when the spread
  // is ≥ 2 ticks wide. On a 1-tick spread (bid+1 = ask) our order sits at the
  // ask price and can be filled immediately as a taker — no maker savings.
  if (bfLayImplied !== null && layOdds !== undefined) {
    const makerPrice = Math.round((p.bid + POLY_TICK) * 100) / 100;
    // BF lay commission is charged when we WIN the lay (team loses).
    // Net edge per share = bfLayImplied × (1 − BF_COMMISSION) − makerPrice
    // Require netEdge > REQUIRED_NET_EDGE + BF_SLIPPAGE_BUFFER so that
    // Betfair market-order slippage cannot push the trade into a loss.
    const netEdge = bfLayImplied * (1 - BF_COMMISSION) - makerPrice;

    if (netEdge >= REQUIRED_NET_EDGE + BF_SLIPPAGE_BUFFER) {
      const sizeShares = Math.floor(POSITION_SIZE_USDC / makerPrice);
      return {
        side: 'buy',
        makerPrice,
        sizeShares,
        bfImplied: bfLayImplied,
        bfOutcome,
        bfOdds: layOdds,
        netEdgePerShare: netEdge,
      };
    }
  }

  // ── Case 2: SELL Poly + BACK Betfair ───────────────────────────────────────
  // We post a SELL limit order at polyAsk − TICK (improving the best ask).
  // When a buyer takes our ask, we immediately BACK on Betfair.
  // Profitable when our sell price minus BF back-implied exceeds commission.
  {
    const makerPrice = Math.round((p.ask - POLY_TICK) * 100) / 100;
    // BF back commission charged when we WIN the back (team wins).
    // Net edge per share = makerPrice − bfBackImplied × (1 − BF_COMMISSION)
    const netEdge = makerPrice - bfBackImplied * (1 - BF_COMMISSION);

    if (netEdge >= REQUIRED_NET_EDGE + BF_SLIPPAGE_BUFFER) {
      const sizeShares = Math.floor(POSITION_SIZE_USDC / (1 - makerPrice));
      return {
        side: 'sell',
        makerPrice,
        sizeShares,
        bfImplied: bfBackImplied,
        bfOutcome,
        bfOdds: backOdds,
        netEdgePerShare: netEdge,
      };
    }
  }

  return null;
}

// ─── Order Management ────────────────────────────────────────────────────────

async function postMakerOrder(
  game: NbaGame,
  token: GameToken,
  opp: ArbOpportunity
): Promise<void> {
  const logPrefix = `[Arb:${game.question}:${token.outcome}]`;

  const params: CreateOrderParams = {
    marketId: token.tokenId,
    tokenId: token.tokenId,
    outcome: token.outcome,
    side: opp.side === 'buy' ? OrderSide.BUY : OrderSide.SELL,
    price: opp.makerPrice,
    size: opp.sizeShares,
    orderType: 'GTC',
  };

  console.log(
    `${logPrefix} posting GTC ${opp.side.toUpperCase()} ` +
    `${opp.sizeShares} shares @ ${(opp.makerPrice * 100).toFixed(2)}%  ` +
    `(BF ${opp.side === 'buy' ? 'LAY' : 'BACK'} implied=${(opp.bfImplied * 100).toFixed(2)}%  ` +
    `netEdge=${(opp.netEdgePerShare * 100).toFixed(2)}%/share)` +
    (DRY_RUN ? '  [DRY RUN]' : '')
  );

  if (DRY_RUN) {
    // Simulate a posted order with a synthetic ID for dry-run tracking
    const syntheticId = `dryrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    game.activeOrders.set(token.outcome, {
      orderId: syntheticId,
      tokenId: token.tokenId,
      game,
      outcome: token.outcome,
      side: opp.side,
      makerPrice: opp.makerPrice,
      sizeShares: opp.sizeShares,
      fillPrice: null,
      filledShares: null,
      hedgedShares: 0,
      postedAt: Date.now(),
      bfImpliedAtPost: opp.bfImplied,
      bfOutcome: opp.bfOutcome,
      bfOdds: opp.bfOdds,
      state: 'ORDER_POSTED',
    });
    return;
  }

  if (!polyExchange) {
    console.error(`${logPrefix} polyExchange not initialized`);
    return;
  }

  try {
    const order: Order = await polyExchange.createOrder(params);
    game.activeOrders.set(token.outcome, {
      orderId: order.id,
      tokenId: token.tokenId,
      game,
      outcome: token.outcome,
      side: opp.side,
      makerPrice: opp.makerPrice,
      sizeShares: opp.sizeShares,
      fillPrice: null,
      filledShares: null,
      hedgedShares: 0,
      postedAt: Date.now(),
      bfImpliedAtPost: opp.bfImplied,
      bfOutcome: opp.bfOutcome,
      bfOdds: opp.bfOdds,
      state: 'ORDER_POSTED',
    });
    console.log(`${logPrefix} order posted id=${order.id}`);
  } catch (err) {
    console.error(`${logPrefix} createOrder failed:`, (err as Error).message);
  }
}

async function cancelMakerOrder(ao: ActiveOrder, reason: string): Promise<void> {
  const logPrefix = `[Arb:${ao.game.question}:${ao.outcome}]`;

  console.log(`${logPrefix} cancelling order id=${ao.orderId}  reason=${reason}` +
    (DRY_RUN ? '  [DRY RUN]' : ''));

  ao.game.activeOrders.delete(ao.outcome);

  if (DRY_RUN || !polyExchange) return;

  try {
    await polyExchange.cancelOrder(ao.orderId, ao.tokenId);
    console.log(`${logPrefix} order cancelled`);
  } catch (err) {
    console.error(`${logPrefix} cancelOrder failed:`, (err as Error).message);
  }
}

/**
 * Execute the Betfair hedge once the Polymarket maker order is filled.
 *
 * In DRY_RUN mode: logs the intended action only.
 * In live mode: requires BETFAIR_APP_KEY and BETFAIR_SESSION_TOKEN env vars
 * plus the native Betfair marketId/selectionId obtained via listMarketCatalogue.
 */
async function executeBetfairHedge(ao: ActiveOrder): Promise<void> {
  const logPrefix = `[Hedge:${ao.game.question}:${ao.outcome}]`;
  const filledShares = ao.filledShares ?? ao.sizeShares;
  const bfSide = ao.side === 'buy' ? 'LAY' : 'BACK';
  // Convert shares to approximate GBP stake (using a 1:1 USD→GBP approximation;
  // adjust this conversion factor for real deployment)
  const bfStakeGbp = Number((filledShares * ao.makerPrice).toFixed(2));

  console.log(
    `${logPrefix} [${bfSide}] outcome="${ao.bfOutcome}"  ` +
    `odds=${ao.bfOdds?.toFixed(2) ?? 'N/A'}  stake=£${bfStakeGbp}` +
    (DRY_RUN ? '  [DRY RUN – no order sent]' : '')
  );

  if (DRY_RUN) {
    ao.state = 'HEDGED';
    console.log(`${logPrefix} HEDGED (simulated)`);
    return;
  }

  const appKey = process.env.BETFAIR_APP_KEY;
  const sessionToken = process.env.BETFAIR_SESSION_TOKEN;
  if (!appKey || !sessionToken) {
    console.error(
      `${logPrefix} Missing BETFAIR_APP_KEY / BETFAIR_SESSION_TOKEN – cannot execute hedge.\n` +
      `  Set these in .env and obtain a session token via the Betfair identity API.\n` +
      `  See: https://developer.betfair.com/exchange-api/`
    );
    ao.state = 'FAILED';
    return;
  }

  const bfClient = new BetfairExchangeClient(appKey, sessionToken);

  // Resolve native Betfair marketId + selectionId via listMarketCatalogue.
  // We narrow the time window around the game start to find the right market.
  let marketId: string | null = null;
  let selectionId: number | null = null;

  try {
    const gameStart = ao.game.gameStartTime;
    const from = gameStart
      ? new Date(gameStart.getTime() - 60 * 60 * 1_000).toISOString()
      : new Date().toISOString();
    const to = gameStart
      ? new Date(gameStart.getTime() + 60 * 60 * 1_000).toISOString()
      : new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString();

    const catalogue = await bfClient.findNbaMarket(from, to);
    const bfNick = teamNick(ao.bfOutcome);

    for (const mkt of catalogue) {
      const runner = mkt.runners.find(
        (r) => teamNick(r.runnerName) === bfNick
      );
      if (runner) {
        marketId = mkt.marketId;
        selectionId = runner.selectionId;
        break;
      }
    }
  } catch (err) {
    console.error(`${logPrefix} listMarketCatalogue failed:`, (err as Error).message);
    ao.state = 'FAILED';
    return;
  }

  if (!marketId || selectionId === null) {
    console.error(`${logPrefix} Could not find Betfair marketId/selectionId for "${ao.bfOutcome}"`);
    ao.state = 'FAILED';
    return;
  }

  try {
    const betId = await bfClient.placeOrder(
      marketId,
      selectionId,
      bfSide,
      ao.bfOdds ?? 2.0,
      bfStakeGbp
    );
    ao.state = 'HEDGED';
    console.log(`${logPrefix} HEDGED – Betfair betId=${betId}`);
  } catch (err) {
    console.error(`${logPrefix} placeOrder failed:`, (err as Error).message);
    ao.state = 'FAILED';
  }
}

/**
 * Poll all open Polymarket maker orders for fill status.
 * Called on an interval from main().
 */
async function checkOrderFills(): Promise<void> {
  if (!polyExchange && !DRY_RUN) return;

  const now = Date.now();

  for (const game of games.values()) {
    for (const [outcome, ao] of game.activeOrders) {
      if (ao.state !== 'ORDER_POSTED') continue;

      // ── TTL check ──────────────────────────────────────────────────────────
      if (now - ao.postedAt > ORDER_TTL_MS) {
        await cancelMakerOrder(ao, `TTL expired (${ORDER_TTL_MS / 1000}s)`);
        continue;
      }

      // ── Betfair drift check ────────────────────────────────────────────────
      // Only cancel on ADVERSE drift (hedge-side price moved against us).
      //   BUY arb  → hedge is LAY; adverse when LAY implied FALLS
      //              (we'd collect less from Betfair if team loses).
      //   SELL arb → hedge is BACK; adverse when BACK implied RISES
      //              (we'd pay more to Betfair if team wins).
      // Favorable drift (edge widened) does NOT trigger a cancel.
      // BF_CANCEL_DRIFT is an ABSOLUTE threshold on the hedge-side price only.
      if (ao.game.betfairMarket) {
        const backOdds =
          (ao.game.betfairMarket.metadata.backOdds as Record<string, number> | undefined)?.[ao.bfOutcome];
        const layOdds =
          (ao.game.betfairMarket.metadata.layOdds as Record<string, number> | undefined)?.[ao.bfOutcome];
        const currentBfImplied =
          ao.side === 'buy'
            ? layOdds ? 1 / layOdds : null
            : backOdds ? 1 / backOdds : null;

        if (currentBfImplied !== null) {
          const adverseDrift =
            ao.side === 'buy'
              ? ao.bfImpliedAtPost - currentBfImplied   // adverse = lay implied fell
              : currentBfImplied - ao.bfImpliedAtPost;  // adverse = back implied rose

          if (adverseDrift > BF_CANCEL_DRIFT) {
            await cancelMakerOrder(
              ao,
              `BF adverse drift: was ${(ao.bfImpliedAtPost * 100).toFixed(2)}%` +
              ` now ${(currentBfImplied * 100).toFixed(2)}%`
            );
            continue;
          }
        }
      }

      // ── DRY RUN: skip real API calls ──────────────────────────────────────
      if (DRY_RUN) continue;

      // ── Live: poll order status ───────────────────────────────────────────
      if (!polyExchange) continue;
      try {
        const order = await polyExchange.fetchOrder(ao.orderId);
        if (order.status === OrderStatus.FILLED) {
          ao.state = 'POLY_FILLED';
          ao.fillPrice = order.price;
          ao.filledShares = order.filled;
          const toHedge = (order.filled ?? 0) - ao.hedgedShares;
          console.log(
            `[Arb:${game.question}:${outcome}] POLY FILLED` +
            `  price=${(order.price * 100).toFixed(2)}%  shares=${order.filled}`
          );
          if (toHedge > 0) {
            const hedgeAo = { ...ao, filledShares: toHedge };
            await executeBetfairHedge(hedgeAo);
            ao.hedgedShares += toHedge;
          }
          ao.state = 'HEDGED';
        } else if (order.status === OrderStatus.PARTIALLY_FILLED) {
          // Hedge only the newly filled increment; keep polling for more fills.
          // Polymarket may reject the order or let remaining shares expire at TTL.
          const totalFilled = order.filled ?? 0;
          const toHedge = totalFilled - ao.hedgedShares;
          if (toHedge > 0) {
            ao.fillPrice = order.price;
            ao.filledShares = totalFilled;
            console.log(
              `[Arb:${game.question}:${outcome}] POLY PARTIAL FILL` +
              `  price=${(order.price * 100).toFixed(2)}%` +
              `  totalFilled=${totalFilled}  hedging=${toHedge} new shares`
            );
            const hedgeAo = { ...ao, filledShares: toHedge };
            await executeBetfairHedge(hedgeAo);
            ao.hedgedShares += toHedge;
          }
        } else if (order.status === OrderStatus.CANCELLED) {
          console.log(`[Arb:${game.question}:${outcome}] order cancelled externally`);
          game.activeOrders.delete(outcome);
        }
      } catch (err) {
        console.error(
          `[Arb:${game.question}:${outcome}] fetchOrder failed:`,
          (err as Error).message
        );
      }
    }
  }
}

// ─── Display ──────────────────────────────────────────────────────────────────

function logGameComparison(game: NbaGame): void {
  const ts = new Date().toISOString();
  const sep = '─'.repeat(72);

  const startsIn = game.gameStartTime
    ? (() => {
        const ms = game.gameStartTime.getTime() - Date.now();
        const h = Math.floor(ms / 3_600_000);
        const m = Math.floor((ms % 3_600_000) / 60_000);
        return `starts in ${h}h ${m}m (${game.gameStartTime.toISOString()})`;
      })()
    : '';

  console.log(`\n${sep}`);
  console.log(`  [${ts}]  ${game.question}`);
  if (startsIn) console.log(`  PRE-GAME  ${startsIn}`);
  console.log(sep);

  console.log('  POLYMARKET (CLOB)');
  for (const outcome of game.outcomes) {
    const p = game.polyPrices[outcome] ?? { bid: null, ask: null, mid: null };
    const fmt = (v: number | null) => (v !== null ? (v * 100).toFixed(2) + '%' : ' N/A ');
    console.log(
      `    ${outcome.padEnd(24)} bid=${fmt(p.bid)}  ask=${fmt(p.ask)}  mid=${fmt(p.mid)}`
    );
  }

  if (game.betfairMarket) {
    const backOdds = game.betfairMarket.metadata.backOdds as Record<string, number> | undefined;
    const layOdds = game.betfairMarket.metadata.layOdds as Record<string, number> | undefined;

    console.log('\n  BETFAIR EXCHANGE (back / lay / implied)');
    for (const bfOutcome of game.betfairMarket.outcomes) {
      const back = backOdds?.[bfOutcome];
      const lay = layOdds?.[bfOutcome];
      const implied = game.betfairMarket.prices[bfOutcome] ?? 0;
      console.log(
        `    ${bfOutcome.padEnd(24)} back=${back ?? 'N/A'}  lay=${lay ?? 'N/A'}` +
          `  implied=${(implied * 100).toFixed(2)}%`
      );
    }

    console.log('\n  MAKER ARB SCAN');
    for (const outcome of game.outcomes) {
      const existingOrder = game.activeOrders.get(outcome);
      if (existingOrder) {
        const age = Math.floor((Date.now() - existingOrder.postedAt) / 1_000);
        console.log(
          `    ${outcome.padEnd(24)} [${existingOrder.state}]` +
          `  orderId=${existingOrder.orderId.slice(0, 16)}…` +
          `  price=${(existingOrder.makerPrice * 100).toFixed(2)}%` +
          `  age=${age}s`
        );
        continue;
      }

      const opp = detectArbOpportunity(game, outcome);
      if (opp) {
        console.log(
          `    ${outcome.padEnd(24)} *** OPPORTUNITY ***` +
          `  ${opp.side.toUpperCase()} @ ${(opp.makerPrice * 100).toFixed(2)}%` +
          `  BF ${opp.side === 'buy' ? 'LAY' : 'BACK'} implied=${(opp.bfImplied * 100).toFixed(2)}%` +
          `  netEdge=${(opp.netEdgePerShare * 100).toFixed(2)}%/share`
        );
      } else {
        const p = game.polyPrices[outcome] ?? { bid: null, ask: null };
        const bfOutcome = game.betfairMarket.outcomes.find(
          (o) => teamNick(o) === teamNick(outcome)
        );
        const bfImplied = bfOutcome ? (game.betfairMarket.prices[bfOutcome] ?? 0) : 0;
        const polyMid =
          p.bid !== null && p.ask !== null ? (p.bid + p.ask) / 2 : null;
        const delta = polyMid !== null ? polyMid - bfImplied : null;
        const sign = delta !== null && delta >= 0 ? '+' : '';
        console.log(
          `    ${outcome.padEnd(24)} no-arb` +
          (delta !== null
            ? `  delta=${sign}${(delta * 100).toFixed(2)}%` +
              `  (Poly: ${(polyMid! * 100).toFixed(2)}%  BF: ${(bfImplied * 100).toFixed(2)}%)`
            : '')
        );
      }
    }
  } else {
    console.log('\n  BETFAIR: no matching market found');
  }

  console.log(sep);
}

// ─── WebSocket update handler ─────────────────────────────────────────────────

async function handleUpdate(
  tokenId: string,
  update: OrderbookUpdate,
  oddsApiKey: string
): Promise<void> {
  const game = tokenToGame.get(tokenId);
  if (!game) return;

  // Drop updates once a game enters the MIN_PRE_GAME_MS exclusion window
  if (game.gameStartTime) {
    const msUntil = game.gameStartTime.getTime() - Date.now();
    if (msUntil < MIN_PRE_GAME_MS) {
      // Cancel any outstanding orders for this game before dropping it
      for (const [, ao] of game.activeOrders) {
        if (ao.state === 'ORDER_POSTED') {
          await cancelMakerOrder(ao, 'game too close to tip-off');
        }
      }
      console.log(
        `[skip] ${game.question} – tip-off in ${Math.ceil(msUntil / 60_000)} min` +
        ` (< ${MIN_PRE_GAME_MS / 60_000} min threshold)`
      );
      return;
    }
  }

  const token = game.tokens.find((t) => t.tokenId === tokenId);
  if (!token) return;

  const orderbook: Orderbook = {
    bids: update.bids,
    asks: update.asks,
    timestamp: update.timestamp,
    assetId: tokenId,
    marketId: update.marketId,
  };

  game.polyPrices[token.outcome] = {
    bid: OrderbookUtils.bestBid(orderbook) ?? null,
    ask: OrderbookUtils.bestAsk(orderbook) ?? null,
    mid: OrderbookUtils.midPrice(orderbook) ?? null,
  };

  // ── Throttled Betfair refresh ──────────────────────────────────────────────
  const now = Date.now();
  if (now - lastBetfairFetch >= BETFAIR_COOLDOWN_MS) {
    lastBetfairFetch = now;
    try {
      allBetfairMarkets = await fetchBetfairNbaMarkets(oddsApiKey);
      for (const g of games.values()) {
        g.betfairMarket = matchBetfairMarket(g, allBetfairMarkets);
      }
      console.log(`[Betfair] refreshed – ${allBetfairMarkets.length} NBA markets`);
    } catch (err) {
      console.error('[Betfair] refresh error:', (err as Error).message);
    }
  }

  // ── Arb opportunity check ──────────────────────────────────────────────────
  // Only proceed once we have prices for ALL outcomes in this game.
  const allPricesReady = game.outcomes.every((o) => {
    const p = game.polyPrices[o];
    return p && p.bid !== null && p.ask !== null;
  });

  if (allPricesReady && game.betfairMarket) {
    for (const outcome of game.outcomes) {
      const opp = detectArbOpportunity(game, outcome);
      if (opp) {
        const t = game.tokens.find((tok) => tok.outcome === outcome);
        if (t) {
          await postMakerOrder(game, t, opp);
        }
      }
    }
  }

  logGameComparison(game);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const oddsApiKey = process.env.ODDS_API_KEY;
  if (!oddsApiKey) {
    console.error('Missing ODDS_API_KEY in .env');
    process.exit(1);
  }

  if (!DRY_RUN) {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      console.error('Missing PRIVATE_KEY in .env (required for live trading)');
      process.exit(1);
    }
    polyExchange = new Polymarket({ privateKey });
    console.log('[Polymarket] exchange initialized with private key');
  } else {
    console.log('[DRY RUN] Polymarket orders will be simulated – no real trades.');
  }

  // 1. Polymarket: fetch all active NBA games
  console.log('\nFetching NBA games from Polymarket...');
  const nbaGames = await fetchNbaGamesFromPolymarket();
  console.log(`Found ${nbaGames.length} active NBA games on Polymarket`);

  if (nbaGames.length === 0) {
    const windowH = PRE_GAME_LOOKAHEAD_MS / 3_600_000;
    console.error(
      `No pre-game NBA markets found within the next ${windowH} h.\n` +
      `Possible reasons:\n` +
      `  1. No NBA games scheduled in the next ${windowH} h.\n` +
      `  2. Today's games have already tipped off.\n` +
      `  3. Increase PRE_GAME_LOOKAHEAD_MS (currently ${windowH} h).\n`
    );
    process.exit(1);
  }

  for (const game of nbaGames) {
    games.set(game.slug, game);
    for (const token of game.tokens) {
      tokenToGame.set(token.tokenId, game);
    }
    const startLabel = game.gameStartTime
      ? `  @${game.gameStartTime.toISOString()}`
      : '';
    console.log(`  ${game.question.padEnd(40)}${startLabel}  (${game.tokens.length} tokens)`);
  }

  // 2. Betfair: initial fetch + match
  console.log('\nFetching Betfair NBA markets...');
  try {
    allBetfairMarkets = await fetchBetfairNbaMarkets(oddsApiKey);
    lastBetfairFetch = Date.now();
    console.log(`Found ${allBetfairMarkets.length} Betfair NBA h2h markets`);

    for (const game of games.values()) {
      game.betfairMarket = matchBetfairMarket(game, allBetfairMarkets);
      const label = game.betfairMarket?.question ?? '—not matched—';
      console.log(`  ${game.question.padEnd(40)} → ${label}`);
    }
  } catch (err) {
    console.error('[Betfair] initial fetch failed:', (err as Error).message);
  }

  // 3. Start order fill-monitoring interval
  const pollInterval = setInterval(() => {
    checkOrderFills().catch((err) =>
      console.error('[OrderPoll] error:', (err as Error).message)
    );
  }, ORDER_POLL_INTERVAL_MS);

  // 4. Subscribe to all NBA tokens via WebSocket
  const ws = new PolymarketWebSocket({ verbose: false });
  ws.on('error', (err: Error) => console.error('[WS] error:', err.message));

  console.log('\nConnecting to Polymarket WebSocket...');

  let tokenCount = 0;
  for (const game of games.values()) {
    for (const token of game.tokens) {
      await ws.watchOrderbookWithAsset(token.tokenId, token.tokenId, (_, update) =>
        handleUpdate(token.tokenId, update, oddsApiKey)
      );
      tokenCount++;
    }
  }

  console.log(
    `\nSubscribed to ${tokenCount} tokens across ${games.size} NBA games.` +
    `\nStrategy: Polymarket MAKER + Betfair TAKER` +
    `\nMode:     ${DRY_RUN ? 'DRY RUN (no real orders)' : 'LIVE'}` +
    `\nMin net edge: ${(REQUIRED_NET_EDGE * 100).toFixed(2)}%/share` +
    `  + slippage buffer: ${(BF_SLIPPAGE_BUFFER * 100).toFixed(1)}%  |  ` +
    `Order TTL: ${ORDER_TTL_MS / 1000}s` +
    '\nPress Ctrl+C to exit.\n'
  );

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    clearInterval(pollInterval);
    // Cancel all outstanding maker orders on exit
    for (const game of games.values()) {
      for (const [, ao] of game.activeOrders) {
        if (ao.state === 'ORDER_POSTED') {
          await cancelMakerOrder(ao, 'SIGINT shutdown');
        }
      }
    }
    await ws.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
