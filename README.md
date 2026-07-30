# YieldSignal

[![CI](https://github.com/Stakemate369/yieldsignal/actions/workflows/ci.yml/badge.svg)](https://github.com/Stakemate369/yieldsignal/actions/workflows/ci.yml)

Risk-weighted yield signals for autonomous agents, paid per call via the [x402](https://x402.org) protocol — no API key, no signup. First 3 calls/day per IP are free via `?trial=1`.

- **ETH liquid staking** (Ethereum mainnet) across **Lido, Rocket Pool, Coinbase Wrapped Staked ETH, Frax Ether and Binance Staked ETH**
- **USDC and WETH lending** (Base) across **Aave, Compound, Morpho, Moonwell, Euler and Fluid**

Two tiers: the raw **signal** (what pays best right now) and the **decision** (given where your money already sits, is moving it worth the cost — MOVE/HOLD with expected net gain and break-even in days).

**Live:** `https://yieldsignal.vercel.app`

```
GET https://yieldsignal.vercel.app/signal/eth-staking-yield
GET https://yieldsignal.vercel.app/signal/usdc-base-yield
GET https://yieldsignal.vercel.app/signal/weth-base-yield

GET https://yieldsignal.vercel.app/decision/eth-staking-yield?position=lido&amountUsd=25000&horizonDays=30
```

Bare `/signal` and `/decision` (no asset) redirect to the ETH staking route — the asset with the strongest verified track record. Short forms like `/signal/usdc` redirect to the canonical path.

### Which asset should you trust?

Don't take our word for it: `GET /accuracy.json` is **free** and returns the per-asset within-tolerance hit-rate and average regret in bps, computed 1:1 from the public on-chain [EAS](https://attest.org) track record. As of writing, the staking signal holds up far better than the USDC lending one (Base USDC churns too fast for a call to stay true) — which is exactly why the flagship is staking. The numbers are recomputed from chain data, not asserted here, so check them yourself before paying.

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

### MCP

Also available as paid MCP tools at `https://yieldsignal.vercel.app/mcp` — `get_yield_signal` and `get_yield_decision`, both with an optional `asset` (`"ETH_STAKING"`, `"USDC"` or `"WETH"`; defaults to `"USDC"` for backwards compatibility with already-published integrations). Most autonomous-agent frameworks discover/call tools via MCP rather than hand-rolled x402 HTTP clients. Uses the official [`@x402/mcp`](https://www.npmjs.com/package/@x402/mcp) package; payment is gated per tool call (`tools/list`/`initialize` stay free, only the tool call requires payment). There's also an [elizaOS plugin](https://www.npmjs.com/package/elizaos-plugin-yieldsignal) in the official registry.

### Response shape

Every rate is tagged with **where it came from** — `onchain`/`api` (Aave, Compound, Morpho — read directly from the protocol) or `defillama` (Moonwell, Euler, Fluid — via the DefiLlama yields API). No estimated or fabricated numbers: a source that fails or returns invalid data is omitted from the response, never guessed at.

Every rate is also compared on **one explicit basis** (`apyBasis: "supply-apy-total-incl-rewards"`): base interest **plus** incentives. This matters because the raw sources disagree on what "APY" means — an on-chain `liquidityRate`/`getSupplyRate` is base-only, while DefiLlama's aggregate and Morpho's `netApy` already include reward tokens. Ranking them side by side without reconciling that compares different things. Each rate itemizes `apyBaseBps`/`apyRewardBps` where the source separates them, and `rewardBasis` says how the incentive component was obtained (`reported`, `inferred`, `included-not-itemized`, `unavailable`). Any protocol whose incentive could not be established at all is listed in `incompleteRewardData` — its APY is a floor, not a verdict.

```json
{
  "asset": "USDC",
  "bestProtocol": "compound",
  "gapBps": 150,
  "rates": [
    { "protocol": "compound", "apyBps": 601, "apyBaseBps": 601, "apyRewardBps": 0, "rewardBasis": "reported", "weightedApyBps": 595, "source": "onchain", "asOf": "2026-07-30T..." },
    { "protocol": "moonwell", "apyBps": 434, "apyBaseBps": 403, "apyRewardBps": 31, "rewardBasis": "reported", "weightedApyBps": 382, "source": "defillama", "asOf": "..." }
  ],
  "omittedProtocols": ["euler"],
  "coverage": { "read": 5, "expected": 6 },
  "apyBasis": "supply-apy-total-incl-rewards",
  "incompleteRewardData": [],
  "asOf": "2026-07-30T..."
}
```

### How long is a signal good for?

`GET /accuracy.json` (free) carries two independent measures, both derived from the public on-chain attestations:

- `score` — directional: was the flagged protocol still the leader (or within 25bps) **when scored against the market right now**.
- `windowedScore` — each attestation judged over **its own validity window**, i.e. until the next attestation for that asset replaced it. `medianWindowHours` is the practical answer to "how often should I re-check?" and it differs sharply per market: on the record as of 2026-07-30, **13h for ETH liquid staking and WETH lending, 1h for USDC lending on Base**. USDC rotates fast; that is a property of the market, not a defect the endpoint hides.

## Verifiability

> Full write-up with every on-chain artifact, the exact command to verify each one, and an honest list of what the stack does **not** solve: [`docs/verifiable-agent-trust.md`](./docs/verifiable-agent-trust.md).

Two independent ways to check a response wasn't tampered with or fabricated, neither requiring you to trust this server's uptime at the moment you check:

- **Signed responses** — every REST/MCP response is signed (EIP-712 typed data) by the same `payTo` address the 402 payment requirement names. The struct (`asset`, `bestProtocol`, `weightedApyBps`, `gapBps`, `asOf`, `contentHash`) mirrors the on-chain EAS schema below, plus a `contentHash` (`keccak256` of the exact response body) binding it to the full response. REST: `X-Signal-Signature`/`X-Signal-Signer`/`X-Signal-Eip712-Payload` headers. MCP: a sibling content block. Verify with [viem's `verifyTypedData`](https://viem.sh/docs/actions/wallet/verifyTypedData) — or just call `getSignalVerified()` from the [`yieldsignal-client`](./client) package, which does both checks for you.
- **On-chain attestations** ([EAS](https://attest.org), Base mainnet) — periodic, public, permanent records of "at time T, protocol X paid Y bps, Z ahead of the runner-up," independently checkable on [easscan.org](https://base.easscan.org) without trusting this server at all. Same attester address as the signed responses above. Published automatically whenever the signal changes materially (best protocol flips, or the gap moves ≥25bps) or gets stale (>12h since the last one) — see `src/attestation/autoAttest.ts` and `POST /internal/auto-attest` (cron-triggered, not on every paid call — that would have no cost ceiling). `npm run attest` still exists for manual, on-demand publishing. Full history at `GET /track-record` (or `/track-record.json`).
- **Agent discovery** ([ERC-8004](https://eips.ethereum.org/EIPS/eip-8004), Base mainnet) — `GET /agent-card.json` is the registration file; agentId `59272` already minted on `IdentityRegistry`. Any REAL buyer (a wallet other than the service's own — the contract blocks owner/operator self-feedback) can leave verifiable feedback on `ReputationRegistry` by running `npm run give-feedback` — addresses/ABI in `src/attestation/erc8004.ts`.

## Architecture

Sibling project to YieldPilot (a personal Aave/Morpho/Compound rebalancer), but **fully separate**: own CDP credentials, own receiver wallet, no shared runtime code. See `CLAUDE.md` and `SECURITY.md` for the full technical writeup and threat model.

- `src/expressApp.ts` — the Express app + x402 payment gate (`createX402Server`, `@x402/express`), reused by both the local dev server (`src/server.ts`) and the Vercel serverless entrypoint (`api/index.ts`). Registers one payment-protected route per asset (`RESOURCE_PATHS`) plus an unpaid `/health` liveness check.
- `src/signal/` — the pure, deterministic comparison logic (no I/O, fully unit tested).
- `src/market-data/` — the two-layer data sourcing (direct reads + DefiLlama), parametrized by asset (`AssetId`, `USDC`/`WETH`) via `config/networks.ts`'s `BASE_ASSETS`.
- `src/wallet/walletLock.ts` — pins the receiver wallet address (via `EXPECTED_WALLET_ADDRESS` in production, since serverless has no persistent disk) so a CDP credential rotation is caught loudly instead of silently redirecting payments.
- `src/mcp.ts` — the `get_yield_signal` MCP tool (optional `asset` param), gated per-call with `@x402/mcp`'s `createPaymentWrapper` (not the whole-route Express middleware, which would paywall `tools/list`/`initialize` too).
- `src/market-data/cache.ts` — 30s TTL on every rate reader (direct + DefiLlama), one cache instance per asset, so a burst of concurrent paid calls doesn't hammer public RPC/API endpoints.
- `src/freeTrial.ts` — 3 free calls/day per IP (in-memory, best-effort — not a hard cap across serverless instances, just adoption-friction removal). Only applied on `?trial=1`; a bare `GET` always 402s so x402 discovery crawlers (x402scan, Bazaar, trust indexes) correctly detect this as a paid endpoint.
- `src/notify/paymentLog.ts` — logs payer/tx/network/amount for every settled payment (`onAfterSettle`, both the REST and MCP payment servers) and alerts on a payment from a wallet that isn't the owner's (a real sale).
- `src/usage/` — durable funnel counters (`usageStore.ts` + `usageMiddleware.ts`), readable at `GET /usage.json` (auth required). Counts 402s served, free trials, paid attempts, settlements, failures and 404s per route/asset. Exists because platform runtime logs aren't reachable from outside, so the only auditable signal used to be on-chain revenue — which can't distinguish "nobody arrives" from "they arrive and don't pay". Backend is any Redis with a REST API; credential discovery matches by env-var **suffix**, so a store connected through the Vercel dashboard (which prefixes the vars it injects) is picked up with no code change. With no store configured it degrades to per-instance in-memory counters and reports `"durable": false`.
- `src/cli/withdraw.ts` — sweeps accumulated USDC to the owner's personal wallet, manual `CONFIRM` required, never automatic.
- `src/wallet/signerAccount.ts` — resolves the same receiver wallet with `signMessage`/`signTypedData`/`sendTransaction` exposed (`createX402Server` only exposes the address); used for response signing and EAS attestation.
- `src/attestation/` — EAS schema definition and calldata encoding (pure, unit tested); `publishAttestation.ts` (shared tx-sending logic), `queryAttestations.ts` (EASScan GraphQL client + decoder), `autoAttest.ts` (pure decision logic + orchestration for the automatic trigger), `trackRecord.ts` (then-vs-now comparison), `erc8004.ts` (ERC-8004 registry addresses/ABI).
- `src/cli/registerSchema.ts` / `src/cli/attestSignal.ts` / `src/cli/registerAgent.ts` / `src/cli/giveFeedback.ts` — one-time schema registration, manual per-attestation publishing, one-time ERC-8004 identity mint, and buyer-side reputation feedback, same `CONFIRM` pattern as `withdraw.ts`. `giveFeedback.ts` is the one script that deliberately resolves a DIFFERENT wallet than `wallet/signerAccount.ts` — the contract rejects feedback from the service's own address.

## Local development

```bash
npm install
npm test                # automated tests (market-data readers, signal logic, retry, wallet lock, free trial)
npm run signal            # live signal, real data, zero credentials needed (`npm run signal -- ETH_STAKING` / `-- WETH` for the other assets)
npm run dev               # local x402 server (reads X402_ENVIRONMENT from .env)
npm run test:paid         # spins up a test buyer wallet, funds it via the CDP faucet, pays for real (testnet only, REST endpoint)
npm run withdraw          # sweep accumulated USDC — asks for typed "CONFIRM"
npm run register-schema   # one-time EAS schema registration (mainnet, real gas) — asks for typed "CONFIRM"
npm run attest             # publish one on-chain attestation of the current signal (mainnet, real gas) — asks for typed "CONFIRM"
npm run register-agent    # one-time ERC-8004 identity mint (mainnet, real gas) — asks for typed "CONFIRM"
npm run give-feedback     # a REAL buyer leaves feedback on ReputationRegistry (mainnet, real gas) — asks for typed "CONFIRM". Fails with "Self-feedback not allowed" if run from the service's own wallet.
```

See `.env.example` for the required variables. Generate your own dedicated CDP project/credentials at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com/) — never reuse another project's.

## Source

[github.com/Stakemate369/yieldsignal](https://github.com/Stakemate369/yieldsignal) — open source, CI runs typecheck + full test suite on every push/PR.

## Why Spark, Seamless and Silo aren't in the protocol list

Checked against `yields.llama.fi/pools` on 2026-07-16, filtering `chain=Base` + `symbol=USDC`: Spark only has a USDS pool (not USDC) on Base; Seamless and Silo have no indexed Base pool at all right now. Rather than fabricate a number, these three are left out until a real USDC market exists for them on Base — see the comment in `src/market-data/types.ts`.

## Why WETH but not WBTC/cbBTC

Checked live against `yields.llama.fi/pools` on 2026-07-17: there's no canonical "WBTC" market on Base, only Coinbase's `cbBTC` (a different asset), and where it does have a market its supply APY sits at ~0-0.2% across all six protocols — a signal too flat to be worth selling ("which is best" barely matters when everyone's tied near zero). WETH, by contrast, has real, distinct yield across all six protocols (0.66%-3.7%), so it's the asset that got added instead.
