import dotenv from 'dotenv';
import {
  type Orderbook,
  type OrderbookUpdate,
  OrderbookUtils,
  PolymarketWebSocket,
  createExchange,
  type Market,
} from '../../src/index.js';

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const GAMMA_API = 'https://gamma-api.polymarket.com';
/** Polymarket NBA 2026 daily series ID (confirmed via /events?series_id=10345) */
const NBA_SERIES_ID = 10345;

/** Minimum USD liquidity to include a Polymarket game */
const MIN_LIQUIDITY = 1_000;

/**
 * Only include games whose start time is within this window from now.
 * e.g. 48 h ahead keeps "tonight" and "tomorrow" games.
 */
const PRE_GAME_LOOKAHEAD_MS = 48 * 60 * 60 * 1_000;

/** Betfair data is refreshed at most once per this interval (ms) */
const BETFAIR_COOLDOWN_MS = 60_000;

/**
 * Minimum time before tip-off to still track a game.
 * Games starting sooner than this are skipped – spreads widen and execution
 * risk increases too close to tip-off for reliable pre-match arb.
 */
const MIN_PRE_GAME_MS = 30 * 60 * 1_000; // 30 minutes

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

interface NbaGame {
  slug: string;
  question: string;
  outcomes: string[];
  tokens: GameToken[];
  polyPrices: Record<string, TeamPrice>;
  betfairMarket: Market | null;
  gameStartTime: Date | null;
}

// ─── State ────────────────────────────────────────────────────────────────────

/** slug → game */
const games = new Map<string, NbaGame>();
/** tokenId → game */
const tokenToGame = new Map<string, NbaGame>();

let lastBetfairFetch = 0;
let allBetfairMarkets: Market[] = [];

// ─── Polymarket data fetch ────────────────────────────────────────────────────

async function fetchNbaGamesFromPolymarket(): Promise<NbaGame[]> {
  /**
   * Correct endpoint: /events?series_id=10345
   *
   * Structure returned per event:
   *   ev.title        "Celtics vs. Spurs"
   *   ev.startTime    "2026-03-11T00:00:00Z"   ← game tip-off (ISO 8601)
   *   ev.eventDate    "2026-03-10"
   *   ev.period       "NS" | "1H" | "VFT" …
   *   ev.markets[]
   *     .sportsMarketType  "moneyline"
   *     .question          "Celtics vs. Spurs"
   *     .outcomes          "[\"Celtics\",\"Spurs\"]"
   *     .clobTokenIds      "[\"<tokenA>\",\"<tokenB>\"]"
   *     .liquidityNum      number
   *     .acceptingOrders   boolean
   */
  const now = Date.now();

  // Note: the Gamma API does not support date-range query params –
  // time-window filtering (MIN_PRE_GAME_MS / PRE_GAME_LOOKAHEAD_MS) is done
  // in-process on the full result set below.
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
    // Game start time is on the event itself
    const gameStartRaw = String(ev.startTime ?? ev.endDate ?? '');
    const gameStart = gameStartRaw ? new Date(gameStartRaw) : null;

    // ── Pre-game filter ───────────────────────────────────────────────────────
    if (gameStart && !Number.isNaN(gameStart.getTime())) {
      const msUntilStart = gameStart.getTime() - now;
      if (msUntilStart <= 0) { skippedStarted++; continue; }
      if (msUntilStart < MIN_PRE_GAME_MS) { skippedTooClose++; continue; }
      if (msUntilStart > PRE_GAME_LOOKAHEAD_MS) { skippedFuture++; continue; }
    } else {
      // No parseable start time: only keep "NS" (Not Started)
      if (String(ev.period ?? '') !== 'NS') continue;
    }

    // Find the moneyline market inside the event
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

/**
 * Reduce a team name to its last meaningful word (the "nickname").
 * "Boston Celtics" → "celtics", "San Antonio Spurs" → "spurs"
 */
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
    const backOdds = game.betfairMarket.metadata.backOdds as
      | Record<string, number>
      | undefined;
    const layOdds = game.betfairMarket.metadata.layOdds as
      | Record<string, number>
      | undefined;

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

    console.log('\n  DELTA (Polymarket mid − Betfair implied)');
    for (const outcome of game.outcomes) {
      const p = game.polyPrices[outcome];
      if (!p || p.mid === null) continue;

      const bfOutcome = game.betfairMarket.outcomes.find(
        (o) => teamNick(o) === teamNick(outcome)
      );
      if (!bfOutcome) continue;

      const bfImplied = game.betfairMarket.prices[bfOutcome] ?? 0;
      const delta = p.mid - bfImplied;
      const sign = delta >= 0 ? '+' : '';
      console.log(
        `    ${outcome.padEnd(24)} ${sign}${(delta * 100).toFixed(2)}%` +
          `  (Poly: ${(p.mid * 100).toFixed(2)}%  Betfair: ${(bfImplied * 100).toFixed(2)}%)`
      );
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

  // Drop updates once a game enters the MIN_PRE_GAME_MS exclusion window at runtime
  if (game.gameStartTime) {
    const msUntil = game.gameStartTime.getTime() - Date.now();
    if (msUntil < MIN_PRE_GAME_MS) {
      console.log(
        `[skip] ${game.question} – tip-off in ${Math.ceil(msUntil / 60_000)} min (< ${MIN_PRE_GAME_MS / 60_000} min threshold)`
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

  // Throttled Betfair refresh – re-matches all games after each refresh
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

  logGameComparison(game);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const oddsApiKey = process.env.ODDS_API_KEY;
  if (!oddsApiKey) {
    console.error('Missing ODDS_API_KEY in .env');
    process.exit(1);
  }

  // 1. Polymarket: fetch all active NBA games
  console.log('Fetching NBA games from Polymarket...');
  const nbaGames = await fetchNbaGamesFromPolymarket();
  console.log(`Found ${nbaGames.length} active NBA games on Polymarket`);

  if (nbaGames.length === 0) {
    const windowH = PRE_GAME_LOOKAHEAD_MS / 3_600_000;
    console.error(
      `No pre-game NBA markets found within the next ${windowH} h.\n` +
      `Possible reasons:\n` +
      `  1. No NBA games scheduled in the next ${windowH} h (check nba.com schedule).\n` +
      `  2. Today's games have already tipped off (gameStartTime <= now).\n` +
      `  3. Increase PRE_GAME_LOOKAHEAD_MS (currently ${windowH} h) to look further ahead.\n`
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

  // 3. Subscribe to all NBA tokens
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
      ' Press Ctrl+C to exit.\n'
  );

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await ws.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
