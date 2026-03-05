/**
 * Cancel an existing order on Polymarket.
 * https://docs.polymarket.com/trading/orders/cancel
 *
 */
import { Polymarket } from '../../src/index.js';
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

  // The order ID returned when the order was created
  const orderId = '0xbb1e9d1ad6d2a4f0bc72e9a5eeab4abed819747c16fa0ba2d70741984655f7db';
  // Optional: the market conditionId the order belongs to
  const marketId = '0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75';

  console.log('Cancelling order:', { orderId, marketId });

  try {
    const cancelled = await polymarket.cancelOrder(orderId, marketId);
    console.log('Order cancelled:', cancelled);
  } catch (err) {
    console.error('Failed to cancel order:', err);
    process.exit(1);
  }

  const balance = await polymarket.fetchBalance();
  console.log('USDC balance:', balance.USDC);
}

main();
