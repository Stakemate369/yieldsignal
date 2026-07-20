# YieldSignal

[![CI](https://github.com/Stakemate369/yieldsignal/actions/workflows/ci.yml/badge.svg)](https://github.com/Stakemate369/yieldsignal/actions/workflows/ci.yml)

Real-time, risk-weighted USDC and WETH lending APY across **Aave, Compound, Morpho, Moonwell, Euler and Fluid** on Base — paid per call via the [x402](https://x402.org) protocol. $0.01 USDC, no API key, no signup. First 3 calls/day per IP are free via `?trial=1`.

**Live:** `https://yieldsignal.vercel.app`

```
GET https://yieldsignal.vercel.app/signal/usdc-base-yield
GET https://yieldsignal.vercel.app/signal/weth-base-yield
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

### MCP

Also available as a paid MCP tool at `https://yieldsignal.vercel.app/mcp` (`get_yield_signal`, optional `asset`: `"USDC"` or `"WETH"`, defaults to USDC) — most autonomous-agent frameworks discover/call tools via MCP rather than hand-rolled x402 HTTP clients. Uses the official [`@x402/mcp`](https://www.npmjs.com/package/@x402/mcp) package; payment is gated per tool call (`tools/list`/`initialize` stay free, only `get_yield_signal` requires payment).

### Response shape

Every rate is tagged with **where it came from** — `onchain`/`api` (Aave, Compound, Morpho — read directly from the protocol) or `defillama` (Moonwell, Euler, Fluid — via the DefiLlama yields API). No estimated or fabricated numbers: a source that fails or returns invalid data is omitted from the response, never guessed at.

```json
{
  "asset": "USDC",
  "bestProtocol": "compound",
  "gapBps": 57,
  "rates": [
    { "protocol": "compound", "apyBps": 490, "weightedApyBps": 485, "source": "onchain", "asOf": "2026-07-17T..." },
    { "protocol": "aave", "apyBps": 307, "weightedApyBps": 307, "source": "onchain", "asOf": "..." }
  ],
  "asOf": "2026-07-17T..."
}
```

## Verifiability

Two independent ways to check a response wasn't tampered with or fabricated, neither requiring you to trust this server's uptime at the moment you check:

- **Signed responses** — every REST/MCP response is signed (EIP-712 typed data) by the same `payTo` address the 402 payment requirement names. The struct (`asset`, `bestProtocol`, `weightedApyBps`, `gapBps`, `asOf`, `contentHash`) mirrors the on-chain EAS schema below, plus a `contentHash` (`keccak256` of the exact response body) binding it to the full response. REST: `X-Signal-Signature`/`X-Signal-Signer`/`X-Signal-Eip712-Payload` headers. MCP: a sibling content block. Verify with [viem's `verifyTypedData`](https://viem.sh/docs/actions/wallet/verifyTypedData) — or just call `getSignalVerified()` from the [`yieldsignal-client`](./client) package, which does both checks for you.
- **On-chain attestations** ([EAS](https://attest.org), Base mainnet) — periodic, public, permanent records of "at time T, protocol X paid Y bps, Z ahead of the runner-up," independently checkable on [easscan.org](https://base.easscan.org) without trusting this server at all. Same attester address as the signed responses above. Published automatically whenever the signal changes materially (best protocol flips, or the gap moves ≥25bps) or gets stale (>12h since the last one) — see `src/attestation/autoAttest.ts` and `POST /internal/auto-attest` (cron-triggered, not on every paid call — that would have no cost ceiling). `npm run attest` still exists for manual, on-demand publishing. Full history at `GET /track-record` (or `/track-record.json`).
- **Agent discovery** ([ERC-8004](https://eips.ethereum.org/EIPS/eip-8004), Base mainnet) — `GET /agent-card.json` is the registration file; once registered on-chain (`npm run register-agent`, `IdentityRegistry`), any buyer can leave verifiable feedback via the `ReputationRegistry` — addresses in `src/attestation/erc8004.ts`.

## Architecture

Sibling project to YieldPilot (a personal Aave/Morpho/Compound rebalancer), but **fully separate**: own CDP credentials, own receiver wallet, no shared runtime code. See `CLAUDE.md` and `SECURITY.md` for the full technical writeup and threat model.

- `src/expressApp.ts` — the Express app + x402 payment gate (`createX402Server`, `@x402/express`), reused by both the local dev server (`src/server.ts`) and the Vercel serverless entrypoint (`api/index.ts`). Registers one payment-protected route per asset (`RESOURCE_PATHS`) plus an unpaid `/health` liveness check.
- `src/signal/` — the pure, deterministic comparison logic (no I/O, fully unit tested).
- `src/market-data/` — the two-layer data sourcing (direct reads + DefiLlama), parametrized by asset (`AssetId`, `USDC`/`WETH`) via `config/networks.ts`'s `BASE_ASSETS`.
- `src/wallet/walletLock.ts` — pins the receiver wallet address (via `EXPECTED_WALLET_ADDRESS` in production, since serverless has no persistent disk) so a CDP credential rotation is caught loudly instead of silently redirecting payments.
- `src/mcp.ts` — the `get_yield_signal` MCP tool (optional `asset` param), gated per-call with `@x402/mcp`'s `createPaymentWrapper` (not the whole-route Express middleware, which would paywall `tools/list`/`initialize` too).
- `src/market-data/cache.ts` — 30s TTL on every rate reader (direct + DefiLlama), one cache instance per asset, so a burst of concurrent paid calls doesn't hammer public RPC/API endpoints.
- `src/freeTrial.ts` — 3 free calls/day per IP (in-memory, best-effort — not a hard cap across serverless instances, just adoption-friction removal). Only applied on `?trial=1`; a bare `GET` always 402s so x402 discovery crawlers (x402scan, Bazaar, trust indexes) correctly detect this as a paid endpoint.
- `src/notify/paymentLog.ts` — logs payer/tx/network/amount for every settled payment (`onAfterSettle`, both the REST and MCP payment servers), plus a usage line per call (paid or free) — revenue/usage visibility, not just a live product.
- `src/cli/withdraw.ts` — sweeps accumulated USDC to the owner's personal wallet, manual `CONFIRM` required, never automatic.
- `src/wallet/signerAccount.ts` — resolves the same receiver wallet with `signMessage`/`signTypedData`/`sendTransaction` exposed (`createX402Server` only exposes the address); used for response signing and EAS attestation.
- `src/attestation/` — EAS schema definition and calldata encoding (pure, unit tested); `publishAttestation.ts` (shared tx-sending logic), `queryAttestations.ts` (EASScan GraphQL client + decoder), `autoAttest.ts` (pure decision logic + orchestration for the automatic trigger), `trackRecord.ts` (then-vs-now comparison), `erc8004.ts` (ERC-8004 registry addresses/ABI).
- `src/cli/registerSchema.ts` / `src/cli/attestSignal.ts` / `src/cli/registerAgent.ts` — one-time schema registration, manual per-attestation publishing, and one-time ERC-8004 identity mint, same `CONFIRM` pattern as `withdraw.ts`.

## Local development

```bash
npm install
npm test                # automated tests (market-data readers, signal logic, retry, wallet lock, free trial)
npm run signal            # live signal, real data, zero credentials needed (USDC by default; `npm run signal -- WETH` for the other asset)
npm run dev               # local x402 server (reads X402_ENVIRONMENT from .env)
npm run test:paid         # spins up a test buyer wallet, funds it via the CDP faucet, pays for real (testnet only, REST endpoint)
npm run withdraw          # sweep accumulated USDC — asks for typed "CONFIRM"
npm run register-schema   # one-time EAS schema registration (mainnet, real gas) — asks for typed "CONFIRM"
npm run attest             # publish one on-chain attestation of the current signal (mainnet, real gas) — asks for typed "CONFIRM"
npm run register-agent    # one-time ERC-8004 identity mint (mainnet, real gas) — asks for typed "CONFIRM"
```

See `.env.example` for the required variables. Generate your own dedicated CDP project/credentials at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com/) — never reuse another project's.

## Source

[github.com/Stakemate369/yieldsignal](https://github.com/Stakemate369/yieldsignal) — open source, CI runs typecheck + full test suite on every push/PR.

## Why Spark, Seamless and Silo aren't in the protocol list

Checked against `yields.llama.fi/pools` on 2026-07-16, filtering `chain=Base` + `symbol=USDC`: Spark only has a USDS pool (not USDC) on Base; Seamless and Silo have no indexed Base pool at all right now. Rather than fabricate a number, these three are left out until a real USDC market exists for them on Base — see the comment in `src/market-data/types.ts`.

## Why WETH but not WBTC/cbBTC

Checked live against `yields.llama.fi/pools` on 2026-07-17: there's no canonical "WBTC" market on Base, only Coinbase's `cbBTC` (a different asset), and where it does have a market its supply APY sits at ~0-0.2% across all six protocols — a signal too flat to be worth selling ("which is best" barely matters when everyone's tied near zero). WETH, by contrast, has real, distinct yield across all six protocols (0.66%-3.7%), so it's the asset that got added instead.
