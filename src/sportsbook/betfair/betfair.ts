import { Exchange, type ExchangeConfig } from '../../core/exchange.js';
import { AuthenticationError, ExchangeError, NetworkError } from '../../errors/index.js';
import type { CreateOrderParams, FetchMarketsParams, Market, Order, Position } from '../../types/index.js';
import type {
  OddsApiEvent,
  OddsApiMarket,
  OddsApiOutcome,
  SportsbookFetchMarketsParams,
} from '../../types/sportsbook.js';

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const DEFAULT_SPORT = 'soccer_epl';
const DEFAULT_MARKETS = 'h2h';
const DEFAULT_REGION = 'uk';
const DEFAULT_BOOKMAKER = 'betfair_ex_uk';

export interface BetfairConfig extends ExchangeConfig {
  /** The Odds API key. Can also be supplied as ExchangeConfig.apiKey */
  oddsApiKey?: string;
  /** Default sport to query when none is provided to fetchMarkets */
  defaultSport?: string;
  /**
   * Default bookmaker key. Defaults to 'betfair_ex_uk'.
   * Other options: 'betfair_ex_eu', 'betfair_ex_au', 'betfair_sb_uk'
   */
  defaultBookmaker?: string;
}

/** fetchMarkets params for Betfair (via The Odds API) */
export type BetfairFetchMarketsParams = SportsbookFetchMarketsParams;

export class Betfair extends Exchange {
  readonly id = 'betfair';
  readonly name = 'Betfair';

  private readonly oddsApiKey: string;
  private readonly defaultSport: string;
  private readonly defaultBookmaker: string;

  constructor(config: BetfairConfig = {}) {
    super(config);
    this.oddsApiKey = config.oddsApiKey ?? config.apiKey ?? '';
    this.defaultSport = config.defaultSport ?? DEFAULT_SPORT;
    this.defaultBookmaker = config.defaultBookmaker ?? DEFAULT_BOOKMAKER;
  }

  override describe() {
    return {
      id: this.id,
      name: this.name,
      has: {
        fetchMarkets: true,
        fetchMarket: false,
        createOrder: false,
        cancelOrder: false,
        fetchOrder: false,
        fetchOpenOrders: false,
        fetchPositions: false,
        fetchBalance: false,
        websocket: false,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireApiKey(): void {
    if (!this.oddsApiKey) {
      throw new AuthenticationError(
        'Betfair (The Odds API) requires an API key. ' +
          'Pass it as { apiKey: "..." } in createExchange config or set ODDS_API_KEY in the environment.'
      );
    }
  }

  /**
   * Convert decimal odds to implied probability.
   * e.g. odds 2.0 → 1/2.0 = 0.5
   */
  private decimalToImpliedProb(decimalOdds: number): number {
    if (decimalOdds <= 0) return 0;
    return 1 / decimalOdds;
  }

  /**
   * Remove vig from raw implied probabilities so they sum to ~1.
   */
  private removeVig(rawProbs: number[]): number[] {
    const total = rawProbs.reduce((s, p) => s + p, 0);
    if (total === 0) return rawProbs;
    return rawProbs.map((p) => p / total);
  }

  // -------------------------------------------------------------------------
  // Parse helpers
  // -------------------------------------------------------------------------

  /**
   * Parse a Betfair Exchange h2h market.
   * Combines the back (h2h) and lay (h2h_lay) markets into a single Market.
   * Back prices are used as-is (exchange markets are already fair – no vig removal;
   * commission is charged separately). Lay odds are stored in metadata.
   */
  private parseExchangeH2hMarket(
    event: OddsApiEvent,
    h2hMarket: OddsApiMarket,
    h2hLayMarket: OddsApiMarket | undefined,
    bookmakerKey: string
  ): Market {
    const id = `${event.id}_${bookmakerKey}_h2h`;
    const question = `${event.sport_title}: ${event.home_team} vs ${event.away_team} (h2h)`;

    const outcomes: string[] = h2hMarket.outcomes.map((o: OddsApiOutcome) => o.name);

    // Back prices – raw implied probs (exchange is already fair)
    const backOdds: Record<string, number> = {};
    const prices: Record<string, number> = {};
    for (const o of h2hMarket.outcomes) {
      backOdds[o.name] = o.price;
      prices[o.name] = this.decimalToImpliedProb(o.price);
    }

    // Lay prices (present when h2h_lay is in the response)
    const layOdds: Record<string, number> = {};
    if (h2hLayMarket) {
      for (const o of h2hLayMarket.outcomes) {
        layOdds[o.name] = o.price;
      }
    }

    const closeTime = new Date(event.commence_time);

    // Overround from back prices; negative = underround, typical for betting exchanges
    const overround =
      Object.values(backOdds).reduce((s, o) => s + this.decimalToImpliedProb(o), 0) - 1;

    return {
      id,
      question,
      outcomes,
      closeTime,
      volume: 0,
      liquidity: 0,
      prices,
      tickSize: 0.001,
      description: `${event.sport_title} – ${event.home_team} vs ${event.away_team}`,
      metadata: {
        eventId: event.id,
        sportKey: event.sport_key,
        sportTitle: event.sport_title,
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        commenceTime: event.commence_time,
        marketKey: 'h2h',
        bookmaker: bookmakerKey,
        lastUpdate: h2hMarket.last_update,
        backOdds,
        layOdds: Object.keys(layOdds).length > 0 ? layOdds : undefined,
        overround: Number(overround.toFixed(6)),
      },
    };
  }

  /**
   * Parse a non-h2h market (spreads, totals).
   * Mirrors FanDuel's parseOddsMarket – applies vig removal.
   */
  private parseOddsMarket(
    event: OddsApiEvent,
    oddsMarket: OddsApiMarket,
    bookmakerKey: string
  ): Market {
    const marketKey = oddsMarket.key;
    const id = `${event.id}_${bookmakerKey}_${marketKey}`;

    const question = `${event.sport_title}: ${event.home_team} vs ${event.away_team} (${marketKey})`;

    const outcomes: string[] = oddsMarket.outcomes.map((o: OddsApiOutcome) => {
      if (marketKey === 'spreads' && o.point !== undefined) {
        const sign = o.point > 0 ? '+' : '';
        return `${o.name} ${sign}${o.point}`;
      }
      if (marketKey === 'totals' && o.point !== undefined) {
        return `${o.name} ${o.point}`;
      }
      return o.name;
    });

    const rawProbs = oddsMarket.outcomes.map((o: OddsApiOutcome) =>
      this.decimalToImpliedProb(o.price)
    );
    const fairProbs = this.removeVig(rawProbs);

    const prices: Record<string, number> = {};
    outcomes.forEach((name, i) => {
      prices[name] = fairProbs[i] ?? 0;
    });

    const closeTime = new Date(event.commence_time);
    const vig = rawProbs.reduce((s, p) => s + p, 0) - 1;

    return {
      id,
      question,
      outcomes,
      closeTime,
      volume: 0,
      liquidity: 0,
      prices,
      tickSize: 0.001,
      description: `${event.sport_title} – ${event.home_team} vs ${event.away_team}`,
      metadata: {
        eventId: event.id,
        sportKey: event.sport_key,
        sportTitle: event.sport_title,
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        commenceTime: event.commence_time,
        marketKey,
        bookmaker: bookmakerKey,
        lastUpdate: oddsMarket.last_update,
        rawOdds: oddsMarket.outcomes,
        vig: Number(vig.toFixed(6)),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async fetchMarkets(params?: FetchMarketsParams & BetfairFetchMarketsParams): Promise<Market[]> {
    this.requireApiKey();

    return this.withRetry(async () => {
      const sportKey = params?.sportKey ?? this.defaultSport;
      const marketsParam = params?.markets ?? DEFAULT_MARKETS;
      const regionsParam = params?.regions ?? DEFAULT_REGION;
      const bookmakers = params?.bookmakers ?? this.defaultBookmaker;
      const oddsFormat = params?.oddsFormat ?? 'decimal';

      // Always fetch h2h_lay alongside h2h to expose the full back/lay spread
      const wantsH2h = marketsParam.split(',').some((m) => m.trim() === 'h2h');
      const fetchMarketsParam =
        wantsH2h && !marketsParam.includes('h2h_lay')
          ? `${marketsParam},h2h_lay`
          : marketsParam;

      const query = new URLSearchParams({
        apiKey: this.oddsApiKey,
        markets: fetchMarketsParam,
        regions: regionsParam,  
        bookmakers,
        oddsFormat,
      });

      if (params?.commenceTimeFrom) query.set('commenceTimeFrom', params.commenceTimeFrom);
      if (params?.commenceTimeTo) query.set('commenceTimeTo', params.commenceTimeTo);

      const url = `${ODDS_API_BASE}/sports/${sportKey}/odds/?${query.toString()}`;

      console.log("url:", url);

      const response = await fetch(url);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new AuthenticationError(`The Odds API authentication failed (HTTP ${response.status})`);
        }
        if (response.status === 429) {
          throw new NetworkError('The Odds API rate limit reached');
        }
        throw new ExchangeError(`The Odds API error: HTTP ${response.status}`);
      }

      const events = (await response.json()) as OddsApiEvent[];

      const markets: Market[] = [];
      const bookmakersFilter = bookmakers.split(',').map((b) => b.trim().toLowerCase());

      for (const event of events) {
        for (const bookmaker of event.bookmakers) {
          if (!bookmakersFilter.includes(bookmaker.key.toLowerCase())) continue;

          const h2hMarket = bookmaker.markets.find((m) => m.key === 'h2h');
          const h2hLayMarket = bookmaker.markets.find((m) => m.key === 'h2h_lay');

          // Combine h2h + h2h_lay into one exchange market (back + lay view)
          if (h2hMarket) {
            markets.push(this.parseExchangeH2hMarket(event, h2hMarket, h2hLayMarket, bookmaker.key));
          }

          // Parse spreads / totals the same way FanDuel does
          for (const oddsMarket of bookmaker.markets) {
            if (oddsMarket.key === 'h2h' || oddsMarket.key === 'h2h_lay') continue;
            markets.push(this.parseOddsMarket(event, oddsMarket, bookmaker.key));
          }
        }
      }

      if (params?.limit && params.limit > 0) {
        return markets.slice(0, params.limit);
      }
      return markets;
    });
  }

  // -------------------------------------------------------------------------
  // Unsupported methods (required by abstract base)
  // -------------------------------------------------------------------------

  async fetchMarket(_marketId: string): Promise<Market> {
    throw new ExchangeError('Betfair does not support fetchMarket by ID via The Odds API');
  }

  async createOrder(_params: CreateOrderParams): Promise<Order> {
    throw new ExchangeError('Betfair does not support order creation via The Odds API');
  }

  async cancelOrder(_orderId: string): Promise<Order> {
    throw new ExchangeError('Betfair does not support order cancellation via The Odds API');
  }

  async fetchOrder(_orderId: string): Promise<Order> {
    throw new ExchangeError('Betfair does not support fetchOrder via The Odds API');
  }

  async fetchOpenOrders(): Promise<Order[]> {
    return [];
  }

  async fetchPositions(): Promise<Position[]> {
    return [];
  }

  async fetchBalance(): Promise<Record<string, number>> {
    return {};
  }
}
