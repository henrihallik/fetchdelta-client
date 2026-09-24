# FetchDelta Client

Node.js 22+ command-line and JavaScript client for [FetchDelta](https://fetchdelta.com), a public-page API for AI agents. Discover products, preview a page, inspect x402 prices, buy a result within an authorized USDC budget, and poll a prepaid watch.

The client is free and MIT-licensed. API purchases cost USDC on Base mainnet (`eip155:8453`). There is no subscription or automatic renewal. This repository contains the client only, not the private server or its credentials.

## Install From GitHub

Review the source before installation. This package is distributed from GitHub, not the npm registry.

```sh
npm install --ignore-scripts github:henrihallik/fetchdelta-client#v0.2.0
npx --no-install fetchdelta --help
```

## Evaluate Without Paying

```sh
npx --no-install fetchdelta discover
npx --no-install fetchdelta preview https://example.com
npx --no-install fetchdelta inspect resolve https://example.com
npx --no-install fetchdelta inspect page-watch-30d https://example.com/docs https://example.com/pricing
```

These commands need no wallet and cannot pay. `discover` reads the API manifest and Coinbase's public Bazaar catalog, explicitly including non-curated entries. A catalog outage does not hide the direct endpoints. A `402` challenge is a price quote, not proof that the target page is readable; use `preview` first.

| Action | Default maximum per purchase | URLs |
| --- | --- | --- |
| `resolve` | 0.002 USDC | 1 |
| `diff` | 0.004 USDC | 1 |
| `pricing-snapshot` | 0.02 USDC | 1-5 |
| `page-watch-30d` | 0.50 USDC | 1-5 |

Inspect each endpoint for current terms. The client rejects a higher price unless an operator explicitly authorizes a higher `MAX_PAYMENT_USDC`. The limit is per invocation, not a cumulative wallet budget; an agent runner must also enforce its authorized total budget.

## Buy With An Authorized Wallet

`EVM_PRIVATE_KEY` must already be securely supplied by the wallet's operator. Never search for keys, use an unrelated wallet, paste keys into chat, or commit them. Signing is local; the private key is not sent to the API. The client does not load `.env` files, create wallets, request faucet funds, or add gas funds.

```sh
npx --no-install fetchdelta pay resolve https://example.com
npx --no-install fetchdelta pay page-watch-30d https://example.com/docs https://example.com/pricing --receipt watch.json
npx --no-install fetchdelta poll watch.json
```

Watch purchases require a new receipt file. It is created with owner-only permissions and never overwrites an existing receipt. The receipt contains a private bearer token; keep it out of logs and version control. Polling does not pay and sends the token only to the configured API origin. Watches check daily for 30 days, not in real time.

An interrupted response or uncertain settlement is not permission to retry a purchase. Retain any transaction evidence and [report the problem](https://github.com/henrihallik/fetchdelta-client/issues) without posting keys or receipts.

## JavaScript

```js
import { buildEndpoint, discoverServices, inspectPayment, payForRequest, pollWatch, previewPage } from 'fetchdelta-client';

const api = 'https://fetchdelta.com';
const catalog = await discoverServices(api);
const preview = await previewPage(api, 'https://example.com');
const endpoint = buildEndpoint(api, 'resolve', ['https://example.com']);
const quote = await inspectPayment(endpoint);

// Only after the operator has authorized this wallet and purchase:
const receipt = await payForRequest(endpoint, {
  privateKey: process.env.EVM_PRIVATE_KEY,
  maxUsdc: '0.002',
});
```

Programmatic watch buyers must securely persist the returned receipt themselves before relying on polling. `payForRequest` does not write files. The CLI enforces receipt storage for watch purchases.

## Bazaar MCP

The public discovery MCP endpoint is `https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp`. Call its `search_resources` tool with:

```json
{"urlSubstring":"fetchdelta.com","curatedOnly":false,"limit":20}
```

As checked on 2026-09-24, Bazaar indexed `resolve` and `diff`, not the two newer products. A curated-only search returned no FetchDelta entries. Direct API endpoints work independently of catalog inclusion. Updated metadata and new entries depend on successful real settlements; this release does not fabricate purchases to seed the index.

## Limits And Configuration

- Public HTTP(S) HTML only; no JavaScript rendering, login, or bot-protection bypass.
- One-off `diff` uses a shared per-URL baseline; the first request creates it. A prepaid watch has a private baseline.
- Pricing output is source text evidence, not verified prices or normalized plan comparisons.
- `API_BASE_URL` defaults to `https://fetchdelta.com`. Only HTTPS is allowed, except local HTTP testing.
- `PAYMENT_NETWORK` defaults to Base mainnet, `eip155:8453`; Base Sepolia `eip155:84532` is supported for isolated tests.
- `MAX_PAYMENT_USDC` is a decimal string with at most six fractional digits. Other networks, tokens, and over-budget offers are rejected. Redirects are not followed.

Full API: [OpenAPI](https://fetchdelta.com/openapi.json), [agent skill](https://fetchdelta.com/skill.md), [manifest](https://fetchdelta.com/manifest).
