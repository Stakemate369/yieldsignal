# YieldSignal

Real-time, risk-weighted USDC lending APY across **Aave, Compound, Morpho, Moonwell, Euler and Fluid** on Base — paid per call via the [x402](https://x402.org) protocol. $0.01 USDC, no API key, no signup.

**Live:** `https://yieldsignal.vercel.app`

```
GET https://yieldsignal.vercel.app/signal/usdc-base-yield
```

Call it without payment first and you'll get a `402 Payment Required` with the exact price/asset/network to pay. Any x402-compatible client can complete the payment automatically — for example with [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch):

```ts
import { wrapFetchWithPayment } from "@x402/fetch";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402"; // or any other x402 client/signer

const client = new CdpX402Client(); // needs CDP_API_KEY_ID/SECRET/WALLET_SECRET + a funded wallet
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const res = await fetchWithPayment("https://yieldsignal.vercel.app/signal/usdc-base-yield");
console.log(await res.json());
// { bestProtocol: "compound", gapBps: 57, rates: [...], asOf: "..." }
```

### Response shape

Every rate is tagged with **where it came from** — `onchain`/`api` (Aave, Compound, Morpho — read directly from the protocol) or `defillama` (Moonwell, Euler, Fluid — via the DefiLlama yields API). No estimated or fabricated numbers: a source that fails or returns invalid data is omitted from the response, never guessed at.

```json
{
  "bestProtocol": "compound",
  "gapBps": 57,
  "rates": [
    { "protocol": "compound", "apyBps": 490, "weightedApyBps": 485, "source": "onchain", "asOf": "2026-07-17T..." },
    { "protocol": "aave", "apyBps": 307, "weightedApyBps": 307, "source": "onchain", "asOf": "..." }
  ],
  "asOf": "2026-07-17T..."
}
```

## Architecture

Sibling project to YieldPilot (a personal Aave/Morpho/Compound rebalancer), but **fully separate**: own CDP credentials, own receiver wallet, no shared runtime code. See `CLAUDE.md` and `SECURITY.md` for the full technical writeup and threat model.

- `src/app.ts` — the Express app + x402 payment gate (`createX402Server`, `@x402/express`), reused by both the local dev server (`src/server.ts`) and the Vercel serverless entrypoint (`api/index.ts`).
- `src/signal/` — the pure, deterministic comparison logic (no I/O, fully unit tested).
- `src/market-data/` — the two-layer data sourcing (direct reads + DefiLlama).
- `src/wallet/walletLock.ts` — pins the receiver wallet address (via `EXPECTED_WALLET_ADDRESS` in production, since serverless has no persistent disk) so a CDP credential rotation is caught loudly instead of silently redirecting payments.
- `src/cli/withdraw.ts` — sweeps accumulated USDC to the owner's personal wallet, manual `CONFIRM` required, never automatic.

## Local development

```bash
npm install
npm test                # 33 automated tests
npm run signal           # live signal, real data, zero credentials needed
npm run dev               # local x402 server (reads X402_ENVIRONMENT from .env)
npm run test:paid         # spins up a test buyer wallet, funds it via the CDP faucet, pays for real (testnet only)
npm run withdraw          # sweep accumulated USDC — asks for typed "CONFIRM"
```

See `.env.example` for the required variables. Generate your own dedicated CDP project/credentials at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com/) — never reuse another project's.

## Why Spark, Seamless and Silo aren't in the protocol list

Checked against `yields.llama.fi/pools` on 2026-07-16, filtering `chain=Base` + `symbol=USDC`: Spark only has a USDS pool (not USDC) on Base; Seamless and Silo have no indexed Base pool at all right now. Rather than fabricate a number, these three are left out until a real USDC market exists for them on Base — see the comment in `src/market-data/types.ts`.
