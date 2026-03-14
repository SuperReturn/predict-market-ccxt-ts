import dotenv from 'dotenv';
import { createExchange, listExchanges, MarketUtils } from '../../src/index.js';
import type { SportsbookFetchMarketsParams } from '../../src/types/index.js';

type BetfairFetchMarketsParams = SportsbookFetchMarketsParams;

dotenv.config();

async function main() {
  console.log('Available exchanges:', listExchanges().join(', '));

  const oddsApiKey = process.env.ODDS_API_KEY;
  if (!oddsApiKey) {
    console.error('Missing ODDS_API_KEY. Set it in the environment.');
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // FanDuel (via The Odds API)
  // ---------------------------------------------------------------------------

  // const fanduel = createExchange('fanduel', { apiKey: oddsApiKey });
  // console.log(`\nExchange: ${fanduel.name}`);

  // const fanduelParams: SportsbookFetchMarketsParams = {
  //   sportKey: 'basketball_nba',
  //   markets: 'h2h,spreads,totals',
  //   regions: 'us',
  //   bookmakers: 'fanduel',
  //   limit: 5,
  // };

  // const fanduelMarkets = await fanduel.fetchMarkets(fanduelParams);

  // for (const market of fanduelMarkets) {
  //   console.log('\n---');
  //   console.log(`ID:        ${market.id}`);
  //   console.log(`Question:  ${market.question}`);
  //   console.log(`Outcomes:  ${market.outcomes.join(' | ')}`);
  //   console.log(`Is Binary: ${MarketUtils.isBinary(market)}`);
  //   console.log(`Is Open:   ${MarketUtils.isOpen(market)}`);
  //   console.log(`Close Time:${market.closeTime?.toISOString()}`);
  //   console.log(`Vig:       ${((market.metadata.vig as number) * 100).toFixed(4)}%`);
  //   for (const [outcome, price] of Object.entries(market.prices)) {
  //     console.log(`  ${outcome}: ${(price * 100).toFixed(2)}%`);
  //   }
  // }

  // ---------------------------------------------------------------------------
  // Betfair Exchange (via The Odds API)
  // ---------------------------------------------------------------------------

  const betfair = createExchange('betfair', { apiKey: oddsApiKey });
  console.log(`\nExchange: ${betfair.name}`);

  const fetchParams: BetfairFetchMarketsParams = {
    sportKey: 'soccer_epl',      // Premier League
    markets: 'h2h',              // h2h_lay is fetched automatically alongside h2h
    regions: 'uk',
    bookmakers: 'betfair_ex_uk', // betfair_ex_eu | betfair_ex_au | betfair_sb_uk
    limit: 5,
  };

  console.log('\nFetching markets with params:', JSON.stringify(fetchParams));

  const markets = await betfair.fetchMarkets(fetchParams);

  for (const market of markets) {
    const backOdds = market.metadata.backOdds as Record<string, number> | undefined;
    const layOdds = market.metadata.layOdds as Record<string, number> | undefined;
    const overround = market.metadata.overround as number | undefined;

    console.log('\n---');
    console.log(`ID:         ${market.id}`);
    console.log(`Question:   ${market.question}`);
    console.log(`Outcomes:   ${market.outcomes.join(' | ')}`);
    console.log(`Is Binary:  ${MarketUtils.isBinary(market)}`);
    console.log(`Is Open:    ${MarketUtils.isOpen(market)}`);
    console.log(`Close Time: ${market.closeTime?.toISOString() ?? 'N/A'}`);
    console.log(`Overround:  ${overround !== undefined ? (overround * 100).toFixed(4) + '%' : 'N/A'}`);

    console.log('Back / Lay odds:');
    for (const outcome of market.outcomes) {
      const back = backOdds?.[outcome];
      const lay = layOdds?.[outcome];
      const backProb = market.prices[outcome] ?? 0;
      const layProb = lay ? 1 / lay : undefined;
      const spread = back && lay ? (lay - back).toFixed(2) : 'N/A';
      console.log(
        `  ${outcome}: back ${back ?? 'N/A'} (${(backProb * 100).toFixed(2)}%)` +
          ` | lay ${lay ?? 'N/A'} (${layProb !== undefined ? (layProb * 100).toFixed(2) + '%' : 'N/A'})` +
          ` | spread ${spread}`
      );
    }
  }
}

main().catch(console.error);
