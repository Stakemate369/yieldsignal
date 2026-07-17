# yieldsignal-client

Thin [x402](https://x402.org) client for [YieldSignal](https://yieldsignal.vercel.app) — real-time, risk-weighted USDC/WETH lending APY across Aave, Compound, Morpho, Moonwell, Euler and Fluid on Base. $0.01 per call.

This package only wraps the paid HTTP request (via [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch)). It does not provision a wallet or pick a signer for you — bring your own `x402Client`/`x402HTTPClient` with a funded Base wallet.

## Install

```bash
npm install yieldsignal-client
```

## Usage

```ts
import { createYieldSignalClient } from "yieldsignal-client";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402"; // or any other x402Client/x402HTTPClient implementation

const client = new CdpX402Client(); // needs CDP_API_KEY_ID/SECRET/WALLET_SECRET + a funded Base wallet
const yieldSignal = createYieldSignalClient(client);

const usdc = await yieldSignal.getSignal("USDC");
const weth = await yieldSignal.getSignal(); // defaults to USDC

console.log(usdc.bestProtocol, usdc.gapBps, usdc.rates);
```

## Local development

Point at a local `npm run dev` instance instead of the live service:

```ts
const yieldSignal = createYieldSignalClient(client, { baseUrl: "http://localhost:4021" });
```

## Source

[github.com/Stakemate369/yieldsignal](https://github.com/Stakemate369/yieldsignal/tree/main/client)
