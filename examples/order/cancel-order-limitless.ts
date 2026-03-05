/**
 * Cancel an existing order on Limitless.
 * https://docs.limitless.exchange/trading/orders/cancel
 */
import { Limitless } from '../../src/index.js';
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

  // The order ID returned when the order was created
  const orderId = 'e01350c8-35f6-4059-a0da-521ac0a2c2f6';
  const marketId = 'dollarxrp-above-dollar13537-on-mar-2-1000-utc-1772442002314'; // market slug

  console.log('Cancelling order:', { orderId, marketId });

  try {
    const cancelled = await limitless.cancelOrder(orderId, marketId);
    console.log('Order cancelled:', cancelled);
    console.log('Order ID:', cancelled.id);
  } catch (err) {
    console.error('Failed to cancel order:', err);
    process.exit(1);
  }

  const balance = await limitless.fetchBalance();
  console.log('USDC balance:', balance.USDC);
}

main();