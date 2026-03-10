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
const NBA_SERIES_SLUG = 'nba-2026';

/** Minimum USD liquidity to include a Polymarket game */
const MIN_LIQUIDITY = 1_000;

/**
 * Only include games whose start time is within this window from now.
 * e.g. 48 h ahead keeps "tonight" and "tomorrow" games.
 */
const PRE_GAME_LOOKAHEAD_MS = 48 * 60 * 60 * 1_000;

/** Betfair data is refreshed at most once per this interval (ms) */
const BETFAIR_COOLDOWN_MS = 60_000;

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
  const url =
    `${GAMMA_API}/events?series_slug=${NBA_SERIES_SLUG}` +
    `&active=true&closed=false&limit=100`;

  console.log("polymarket url:", url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);

  const events = (await res.json()) as Array<Record<string, unknown>>;
  const result: NbaGame[] = [];

  for (const event of events) {
    const slug = String(event.slug ?? event.ticker ?? '');
    const title = String(event.title ?? '');
    const rawMarkets = (event.markets ?? []) as Array<Record<string, unknown>>;

    for (const m of rawMarkets) {
      // Only moneyline (h2h) markets
      if (String(m.sportsMarketType ?? '') !== 'moneyline') continue;
      if (m.closed || !m.active) continue;

      // Pre-game only: period must be "NS" (Not Started) or gameStartTime in future
      const period = String(m.period ?? event.period ?? '');
      const gameStartRaw = String(m.gameStartTime ?? event.gameStartTime ?? event.startTime ?? '');
      const gameStart = gameStartRaw ? new Date(gameStartRaw) : null;
      const now = Date.now();

      if (gameStart) {
        const msUntilStart = gameStart.getTime() - now;
        // Skip games that have already started or are too far in the future
        if (msUntilStart <= 0) continue;
        if (msUntilStart > PRE_GAME_LOOKAHEAD_MS) continue;
      } else if (period && period !== 'NS') {
        // If no gameStartTime but period is known and not "NS", skip
        continue;
      }

      const liquidity = Number(m.liquidityNum ?? m.liquidity ?? 0);
      if (liquidity < MIN_LIQUIDITY) continue;

      let outcomes: string[] = [];
      try {
        outcomes = typeof m.outcomes === 'string'
          ? (JSON.parse(m.outcomes) as string[])
          : (m.outcomes as string[]) ?? [];
      } catch { continue; }

      let tokenIds: string[] = [];
      try {
        tokenIds = typeof m.clobTokenIds === 'string'
          ? (JSON.parse(m.clobTokenIds) as string[])
          : (m.clobTokenIds as string[]) ?? [];
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
        slug,
        question: String(m.question ?? title),
        outcomes,
        tokens,
        polyPrices,
        betfairMarket: null,
        gameStartTime: gameStart,
      });

      break; // one moneyline per event
    }
  }

  return result;
}

// ─── Betfair data fetch ───────────────────────────────────────────────────────

async function fetchBetfairNbaMarkets(oddsApiKey: string): Promise<Market[]> {
  const betfair = createExchange('betfair', { apiKey: oddsApiKey });
  const now = new Date();
  const lookahead = new Date(now.getTime() + PRE_GAME_LOOKAHEAD_MS);
  return betfair.fetchMarkets({
    sportKey: 'basketball_nba',
    markets: 'h2h',
    regions: 'uk',
    bookmakers: 'betfair_ex_uk',
    // Only games that haven't started yet (commence_time in the future)
    commenceTimeFrom: now.toISOString(),
    commenceTimeTo: lookahead.toISOString(),
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
    console.error('No active NBA games found – exiting');
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
