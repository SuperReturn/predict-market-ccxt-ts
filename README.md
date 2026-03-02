# superReturn CCXT

CCXT-style unified API for prediction markets in TypeScript.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## Supported Exchanges

| Exchange | REST | WebSocket | Chain |
|----------|------|-----------|-------|
| [Polymarket](https://polymarket.com) | ✅ | ✅ | Polygon |
| [Limitless](https://limitless.exchange) | ✅ | ✅ | Base |

## Installation

```bash
npm install @superreturn/ccxt
# or
pnpm add @superreturn/ccxt
# or
yarn add @superreturn/ccxt
```

## Examples

See the [examples/](examples/) directory:

| Example | Description | Exchanges |
|---------|-------------|-----------|
| **list-markets.ts** | Fetch and display markets from all exchanges | All |
| **websocket-orderbook.ts** | Real-time orderbook streaming via WebSocket | Polymarket |
| **spread-strategy.ts** | Market making strategy with inventory management | All |
| **spike-strategy.ts** | Mean reversion strategy - buys price spikes | All |
| **weather-bot-strategy.ts** | London temperature bucket mispricing strategy | Polymarket |

### Order Examples

#### Poly

Refer to [`examples/order/place-order-poly.ts`](examples/order/place-order-poly.ts) and [`examples/order/cancel-order-poly.ts`](examples/order/cancel-order-poly.ts)

**Place GTC Order**

Response when open:
```
{
  id: '0xbb1e9d1ad6d2a4f0bc72e9a5eeab4abed819747c16fa0ba2d70741984655f7db',
  marketId: '0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75',
  outcome: 'Yes',
  side: 'buy',
  price: 0.1,
  size: 10,
  filled: 0,
  status: 'open',
  orderType: 'GTC',
  createdAt: 2026-03-02T08:07:36.177Z,
  updatedAt: 2026-03-02T08:07:36.177Z
}
```

Response when filled:
```
{
  id: '0x5606e16247864621b9a8e45c223fce193f57654a5ca50979bf7662582a2127c1',
  marketId: '0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75',
  outcome: 'Yes',
  side: 'buy',
  price: 0.2,
  size: 2,
  filled: 2,
  status: 'filled',
  orderType: 'GTC',
  createdAt: 2026-03-02T08:09:13.029Z,
  updatedAt: 2026-03-02T08:09:13.029Z
}
```

**Cancel GTC Order**
```
{
  id: '0xbb1e9d1ad6d2a4f0bc72e9a5eeab4abed819747c16fa0ba2d70741984655f7db',
  marketId: '0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75',
  outcome: '',
  side: 'buy',
  price: 0,
  size: 0,
  filled: 0,
  status: 'cancelled',
  orderType: '',
  createdAt: 2026-03-02T08:09:49.798Z,
  updatedAt: 2026-03-02T08:09:49.798Z
}
```

**Place FOK Order**

Response when filled:
```
{
  id: '0x90acd7e01e62204f205656a9eacc577f1a1679526b2db19917fa9e27b9e749c6',
  marketId: '0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75',
  outcome: 'Yes',
  side: 'buy',
  price: 0.2,
  size: 1,
  filled: 5,
  status: 'filled',
  orderType: 'FOK',
  createdAt: 2026-03-02T08:12:41.172Z,
  updatedAt: 2026-03-02T08:12:41.172Z
}
```

If canceled: returns 400 error

#### Limitless

Refer to [`examples/order/place-order-limitless.ts`](examples/order/place-order-limitless.ts) and [`examples/order/cancel-order-limitless.ts`](examples/order/cancel-order-limitless.ts)

**Place GTC Order**

Response when open:
```
{
  id: 'e01350c8-35f6-4059-a0da-521ac0a2c2f6',
  marketId: 'dollarxrp-above-dollar13537-on-mar-2-1000-utc-1772442002314',
  outcome: 'Yes',
  side: 'buy',
  price: 0.1,
  size: 2,
  filled: 0,
  status: 'open',
  orderType: 'GTC',
  createdAt: 2026-03-02T09:22:00.717Z
}
```

Response when filled: 
```
{
  id: '8e98bae1-73a1-4e1f-9922-333059bf14fe',
  marketId: 'dollartrx-above-dollar028121-on-mar-3-0800-utc-1772438402355',
  outcome: 'No',
  side: 'buy',
  price: 0.3,
  size: 1,
  filled: 1,
  status: 'filled',
  orderType: 'GTC',
  createdAt: 2026-03-02T16:32:40.070Z
}
```

**Cancel GTC Order**

```
{
  id: 'e01350c8-35f6-4059-a0da-521ac0a2c2f6',
  marketId: 'dollarxrp-above-dollar13537-on-mar-2-1000-utc-1772442002314',
  outcome: '',
  side: 'buy',
  price: 0,
  size: 0,
  filled: 0,
  status: 'cancelled',
  orderType: '',
  createdAt: 2026-03-02T09:23:29.547Z
}
```

**Place FOK Order**

If canceled: TODO

Response when filled: 
```
{
  id: '3b2ef891-81c8-4a98-9a7a-c8ce30642f1d',
  marketId: 'dollartrx-above-dollar028121-on-mar-3-0800-utc-1772438402355',
  outcome: 'No',
  side: 'buy',
  price: 0.349001,
  size: 0.1,
  filled: 0.286532,
  status: 'filled',
  orderType: 'FOK',
  createdAt: 2026-03-02T16:49:56.563Z
}
```

## Requirements

- Node.js >= 20.0.0
- TypeScript >= 5.0 (for development)

## License

MIT
