/**
 * Place a single order on Polymarket.
 * https://docs.polymarket.com/trading/orders/create
 * 
 */
import { OrderSide, Polymarket } from '../../src/index.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('Missing PRIVATE_KEY. Set it in the environment.');
    process.exit(1);
  }

  const polymarket = new Polymarket({
    privateKey: process.env.PRIVATE_KEY,
    chainId: 137, // polygon mainnet
  });

  // there might be some limitation for the market, e.g. min order size, min price, etc.
  const marketId = '0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75'; // conditionId
  const tokenId =
    '107505882767731489358349912513945399560393482969656700824895970500493757150417'; // clobTokenIds[Yes]
  const outcome = 'Yes';
  const side = OrderSide.BUY;
  const price = 0.2;
  const size = 5; // should >= orderMinSize in api response
  // price * size should >= 1

  console.log('Placing order:', { marketId, outcome, side, price, size, tokenId });

  try {
    const order = await polymarket.createOrder({
      marketId,
      outcome,
      side,
      price,
      size,
      tokenId,
    });
    console.log('Order placed:', order);
  } catch (err) {
    console.error('Failed to place order:', err);
    process.exit(1);
  }

  const balance = await polymarket.fetchBalance();
  console.log('USDC balance:', balance.USDC);
}

main();
