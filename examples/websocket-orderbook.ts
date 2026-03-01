import {
  type Orderbook,
  OrderbookUtils,
  PolymarketWebSocket,
  LimitlessWebSocket,
} from '../src/index.js';

const TOKEN_IDS = [
  '55087250670040717711131370018408221134109122974378698780636020561523521220754',
  '108145967398435925971960442906832714254932011684365058146885679351681137451999',
];

/**
 * Limitless: subscribe by market slug (see https://docs.limitless.exchange).
 * Uses subscribe_market_prices (marketSlugs). For OrderbookManager yes/no tokens, set assetIds.
 */
const LIMITLESS_MARKET_SLUG = 'dollarleo-above-dollar87576-on-feb-26-0700-utc-1772002802372'; // one market to listen to (CLOB)
const LIMITLESS_ASSET_IDS: [string, string] = ['', '']; // optional: [yesTokenId, noTokenId] from market

async function main() {
  const ws = new PolymarketWebSocket({ verbose: true });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });

  console.log('Connecting to Polymarket WebSocket...');

  for (const tokenId of TOKEN_IDS) {
    await ws.watchOrderbookWithAsset(tokenId, tokenId, (marketId, update) => {
      const orderbook: Orderbook = {
        bids: update.bids,
        asks: update.asks,
        timestamp: update.timestamp,
        assetId: tokenId,
        marketId,
      };

      const bid = OrderbookUtils.bestBid(orderbook);
      const ask = OrderbookUtils.bestAsk(orderbook);
      const spread = OrderbookUtils.spread(orderbook);
      const mid = OrderbookUtils.midPrice(orderbook);

      console.log(
        `[${tokenId.slice(0, 8)}...] Bid: ${bid?.toFixed(3) ?? 'N/A'} | Ask: ${ask?.toFixed(3) ?? 'N/A'} | Spread: ${spread?.toFixed(4) ?? 'N/A'} | Mid: ${mid?.toFixed(3) ?? 'N/A'}`
      );
    });
  }

  // Limitless WebSocket — subscribe_market_prices (one market by slug)
  const limitlessWs = new LimitlessWebSocket({ verbose: true });
  limitlessWs.onError((msg) => console.error('[Limitless] WebSocket error:', msg));
  console.log('Connecting to Limitless WebSocket...');
  await limitlessWs.watchOrderbookByMarket(
    LIMITLESS_MARKET_SLUG,
    LIMITLESS_ASSET_IDS,
    (marketId, update) => {
      const orderbook: Orderbook = {
        bids: update.bids,
        asks: update.asks,
        timestamp: update.timestamp,
        assetId: LIMITLESS_ASSET_IDS[0] || marketId,
        marketId,
      };
      const bid = OrderbookUtils.bestBid(orderbook);
      const ask = OrderbookUtils.bestAsk(orderbook);
      const spread = OrderbookUtils.spread(orderbook);
      const mid = OrderbookUtils.midPrice(orderbook);
      console.log(
        `[Limitless ${marketId}] Bid: ${bid?.toFixed(3) ?? 'N/A'} | Ask: ${ask?.toFixed(3) ?? 'N/A'} | Spread: ${spread?.toFixed(4) ?? 'N/A'} | Mid: ${mid?.toFixed(3) ?? 'N/A'}`
      );
    }
  );

  console.log('Subscribed to orderbook updates. Press Ctrl+C to exit.\n');

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await Promise.all([ws.disconnect(), limitlessWs.disconnect()]);
    process.exit(0);
  });
}

main().catch(console.error);
