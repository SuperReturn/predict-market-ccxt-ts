/**
 * Place a single order on Limitless.
 * https://docs.limitless.exchange/trading/orders/create
 */
import { Limitless, OrderSide } from '../../src/index.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('Missing PRIVATE_KEY. Set it in the environment.');
    process.exit(1);
  }

  const limitless = new Limitless({
    privateKey,
    chainId: 8453, // Base mainnet
  });

  // Replace with a real market slug from https://limitless.exchange
  const marketId = 'dollartrx-above-dollar028121-on-mar-3-0800-utc-1772438402355'; // market slug
  const outcome = 'No';
  const side = OrderSide.BUY;

  try {
    // GTC (Good-Til-Cancelled): rests on the orderbook until filled or cancelled
    // const order = await limitless.createOrder({
    //   marketId,
    //   outcome,
    //   side,
    //   price: 0.3, // probability between 0 and 1 (exclusive)
    //   size: 1,    // whole number of shares
    //   orderType: 'GTC',
    // });

    // FOK (Fill-Or-Kill): executes immediately against the live orderbook or is rejected entirely.
    // Use `makerAmount` instead of price/size:
    //   BUY  → makerAmount = USDC to spend
    //   SELL → makerAmount = shares to sell
    const order = await limitless.createOrder({
      marketId,
      outcome,
      side,
      makerAmount: 0.1, // spend 5 USDC (BUY FOK)
      orderType: 'FOK',
    });
    console.log('Order placed:', order);
    console.log('Order ID:', order.id);

    // fetch open orders
    const orders = await limitless.fetchOpenOrders(marketId);
    console.log("open orders amount:", orders.length);
    console.log("open orders:")
    console.log(orders);
  } catch (err) {
    console.error('Failed to place order:', err);
    process.exit(1);
  }

  const balance = await limitless.fetchBalance();
  console.log('USDC balance:', balance.USDC);
}

main();