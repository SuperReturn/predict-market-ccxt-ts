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
  const marketId = 'dollareth-above-dollar196287-on-mar-1-0200-utc-1772326802268'; // market slug
  const outcome = 'No';
  const side = OrderSide.BUY;
  const price = 0.88; // must be between 0 and 1
  const size = 2; // number of shares

  console.log('Placing order:', { marketId, outcome, side, price, size });

  try {
    const order = await limitless.createOrder({
      marketId,
      outcome,
      side,
      price,
      size,
    });
    console.log('Order placed:', order);
  } catch (err) {
    console.error('Failed to place order:', err);
    process.exit(1);
  }

  const balance = await limitless.fetchBalance();
  console.log('USDC balance:', balance.USDC);
}

main();