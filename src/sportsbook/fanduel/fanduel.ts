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
const DEFAULT_SPORT = 'basketball_nba';
const DEFAULT_MARKETS = 'h2h';
const DEFAULT_REGIONS = 'us';
const DEFAULT_BOOKMAKER = 'fanduel';

export interface FanDuelConfig extends ExchangeConfig {
  /** The Odds API key – can also be supplied as ExchangeConfig.apiKey */
  oddsApiKey?: string;
  /** Default sport to query when none is provided to fetchMarkets */
  defaultSport?: string;
}

export class FanDuel extends Exchange {
  readonly id = 'fanduel';
  readonly name = 'FanDuel';

  private readonly oddsApiKey: string;
  private readonly defaultSport: string;

  constructor(config: FanDuelConfig = {}) {
    super(config);
    this.oddsApiKey = config.oddsApiKey ?? config.apiKey ?? '';
    this.defaultSport = config.defaultSport ?? DEFAULT_SPORT;
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
        'FanDuel (The Odds API) requires an API key. ' +
          'Pass it as { apiKey: "..." } in createExchange config or set ODDS_API_KEY in the environment.'
      );
    }
  }

  /**
   * Convert decimal odds to implied probability (no-vig raw value).
   * e.g. odds 1.91 → 1/1.91 ≈ 0.5236
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

    const vig =
      rawProbs.reduce((s, p) => s + p, 0) - 1;

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

  async fetchMarkets(params?: FetchMarketsParams & SportsbookFetchMarketsParams): Promise<Market[]> {
    this.requireApiKey();

    return this.withRetry(async () => {
      const sportKey = params?.sportKey ?? this.defaultSport;
      const marketsParam = params?.markets ?? DEFAULT_MARKETS;
      const regionsParam = params?.regions ?? DEFAULT_REGIONS;
      const bookmakers = params?.bookmakers ?? DEFAULT_BOOKMAKER;
      const oddsFormat = params?.oddsFormat ?? 'decimal';

      const query = new URLSearchParams({
        apiKey: this.oddsApiKey,
        markets: marketsParam,
        regions: regionsParam,
        bookmakers,
        oddsFormat,
      });

      if (params?.commenceTimeFrom) query.set('commenceTimeFrom', params.commenceTimeFrom);
      if (params?.commenceTimeTo) query.set('commenceTimeTo', params.commenceTimeTo);

      const url = `${ODDS_API_BASE}/sports/${sportKey}/odds/?${query.toString()}`;

      console.log('url:', url);

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
          for (const oddsMarket of bookmaker.markets) {
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
    throw new ExchangeError('FanDuel does not support fetchMarket by ID via The Odds API');
  }

  async createOrder(_params: CreateOrderParams): Promise<Order> {
    throw new ExchangeError('FanDuel does not support order creation');
  }

  async cancelOrder(_orderId: string): Promise<Order> {
    throw new ExchangeError('FanDuel does not support order cancellation');
  }

  async fetchOrder(_orderId: string): Promise<Order> {
    throw new ExchangeError('FanDuel does not support fetchOrder');
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
