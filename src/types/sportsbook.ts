/**
 * Sportsbook / The Odds API – type definitions
 */

// ---------------------------------------------------------------------------
// Request (input) params
// ---------------------------------------------------------------------------

/** Sports supported by The Odds API */
export type OddsApiSportKey =
  | 'basketball_nba'
  | 'americanfootball_nfl'
  | 'baseball_mlb'
  | 'icehockey_nhl'
  | string;

/** Market types */
export type OddsApiMarketKey = 'h2h' | 'spreads' | 'totals' | string;

/** Geographic regions */
export type OddsApiRegion = 'us' | 'us2' | 'uk' | 'eu' | 'au' | string;

/** Supported bookmaker keys */
export type OddsApiBookmakerKey = 'fanduel' | 'draftkings' | 'betmgm' | string;

/** Query parameters for GET /v4/sports/{sportKey}/odds */
export interface OddsApiRequestParams {
  /** Your API key */
  apiKey: string;
  /** Comma-separated market keys, e.g. "h2h,spreads,totals" */
  markets: string;
  /** Comma-separated region codes, e.g. "us" */
  regions: string;
  /** Comma-separated bookmaker keys to filter by, e.g. "fanduel" */
  bookmakers?: string;
  /** Odds format: "decimal" | "american" | "hongkong" | "indonesian" | "malay" */
  oddsFormat?: 'decimal' | 'american' | 'hongkong' | 'indonesian' | 'malay';
  /** ISO 8601 datetime – only return events after this time */
  commenceTimeFrom?: string;
  /** ISO 8601 datetime – only return events before this time */
  commenceTimeTo?: string;
  /** Date format for commence_time: "iso" | "unix" */
  dateFormat?: 'iso' | 'unix';
}

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

/** A single outcome within a market (h2h / spreads / totals) */
export interface OddsApiOutcome {
  /** Team or side name, e.g. "Dallas Mavericks", "Over" */
  name: string;
  /** Decimal odds price */
  price: number;
  /** Spread / total point value (only present for spreads & totals markets) */
  point?: number;
}

/** A betting market (h2h, spreads, or totals) offered by a bookmaker */
export interface OddsApiMarket {
  /** Market type key */
  key: OddsApiMarketKey;
  /** ISO 8601 timestamp of last odds update */
  last_update: string;
  /** Available outcomes and their prices */
  outcomes: OddsApiOutcome[];
}

/** Bookmaker entry within an event */
export interface OddsApiBookmaker {
  /** Bookmaker identifier */
  key: OddsApiBookmakerKey;
  /** Human-readable bookmaker name */
  title: string;
  /** ISO 8601 timestamp of last update */
  last_update: string;
  /** All markets offered by this bookmaker for the event */
  markets: OddsApiMarket[];
}

/** A single sports event returned by The Odds API */
export interface OddsApiEvent {
  /** Unique event identifier */
  id: string;
  /** Sport key, e.g. "basketball_nba" */
  sport_key: OddsApiSportKey;
  /** Human-readable sport title, e.g. "NBA" */
  sport_title: string;
  /** ISO 8601 scheduled start time */
  commence_time: string;
  /** Home team name */
  home_team: string;
  /** Away team name */
  away_team: string;
  /** Bookmaker odds entries */
  bookmakers: OddsApiBookmaker[];
}

/** Full response from GET /v4/sports/{sportKey}/odds */
export type OddsApiResponse = OddsApiEvent[];

/** fetchMarkets params specific to sportsbook / Odds API exchanges */
export interface SportsbookFetchMarketsParams {
  /** Sport to fetch – defaults to "basketball_nba" */
  sportKey?: OddsApiSportKey;
  /** Comma-separated market keys, e.g. "h2h,spreads,totals" – defaults to "h2h" */
  markets?: string;
  /** Comma-separated region codes, e.g. "us" – defaults to "us" */
  regions?: string;
  /** Comma-separated bookmaker keys to filter by */
  bookmakers?: string;
  /** Odds format – defaults to "decimal" */
  oddsFormat?: OddsApiRequestParams['oddsFormat'];
  /** ISO 8601 datetime – only return events after this time */
  commenceTimeFrom?: string;
  /** ISO 8601 datetime – only return events before this time */
  commenceTimeTo?: string;
  /** Maximum number of markets to return */
  limit?: number;
  /** Additional exchange-specific filters */
  [key: string]: unknown;
}
