# yieldsignal-client

Thin [x402](https://x402.org) client for [YieldSignal](https://yieldsignal.vercel.app) — real-time, risk-weighted USDC/WETH lending APY across Aave, Compound, Morpho, Moonwell, Euler and Fluid on Base, plus ETH liquid staking APY across Lido, Rocket Pool, Coinbase Wrapped Staked ETH, Frax Ether and Binance Staked ETH on Ethereum mainnet. $0.01 per call.

**Six products, not one.** The signal answers *what pays best right now* — which is a commodity. The other five answer questions nothing else sells:

| Method | Question it answers |
|---|---|
| `getSignal` | What pays best right now |
| `getDecision` | Given where my money already sits, is moving it worth the cost? |
| `getDurability` | Is this yield real, or a promotion about to end? |
| `getCapacity` | Can I actually withdraw my size from that market? |
| `getSensitivity` | How close is this market to the kink where borrow rates explode? |
| `getExposure` | I'm in N venues — but behind how many distinct risks? |

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
const weth = await yieldSignal.getSignal("WETH");
const ethStaking = await yieldSignal.getSignal("ETH_STAKING");
const defaultsToUsdc = await yieldSignal.getSignal(); // defaults to USDC

console.log(usdc.bestProtocol, usdc.gapBps, usdc.rates);
```

## The other five

The four analytics products are **Base lending only** (`"USDC"` or `"WETH"`) — liquid staking has no utilization, no interest-rate curve, and no itemised incentive to decompose, so the types refuse `"ETH_STAKING"` at compile time instead of letting you pay for a 404.

```ts
// Is the yield real, or a promotion about to end?
const dur = await yieldSignal.getDurability("WETH");
// → bestProtocolNow: "euler" (299bps, 57.9% of it incentive, floor 126bps)
//   bestProtocolPostIncentive: "aave" (153bps, entirely base)
//   rankingChangesWithoutIncentives: true

// Can I actually get $200k out of there?
const cap = await yieldSignal.getCapacity("USDC", 200_000);
// → bestProtocolExecutable, per-protocol utilization and free liquidity

// How close is this market to repricing against me?
const sens = await yieldSignal.getSensitivity("USDC");
// → tightestToKink: { protocol: "compound", headroomBps: 18 }
//   i.e. 0.18 percentage points from where borrowing goes 4% → 16%

// I'm in three venues — am I actually diversified?
const exp = await yieldSignal.getExposure("USDC", { aave: 200_000, compound: 50_000, morpho: 150_000 });
// → topFactor: 81% of attributable capital behind one collateral (cbBTC),
//   reaching it through BOTH compound and morpho

// Should I move, given what it costs?
const dec = await yieldSignal.getDecision("USDC", { position: "aave", amountUsd: 25_000, horizonDays: 30 });
```

**What "unmeasured" means.** Every report names what it could not establish, and never fills the gap with a guess. A protocol whose collateral composition cannot be read is reported `unattributed` with the reason — not split across assets to imply diversification that does not exist. A market with no readable rate curve is `unmeasured` — not assumed stable. Percentages in `getExposure` are of *attributable* capital, and `coverage` tells you how much that was.

## Verifying the response wasn't tampered with

Every response is signed (EIP-712 typed data) by the same address the x402 payment went to. `getSignalVerified` fetches the signal AND checks the signature for you (via `viem.verifyTypedData` + a `contentHash` check against the exact response body):

```ts
const { signal, verified, signer } = await yieldSignal.getSignalVerified("USDC");
if (!verified) throw new Error("signature check failed — don't trust this response");
console.log(signal.bestProtocol, "signed by", signer);
```

## Local development

Point at a local `npm run dev` instance instead of the live service:

```ts
const yieldSignal = createYieldSignalClient(client, { baseUrl: "http://localhost:4021" });
```

## Source

[github.com/Stakemate369/yieldsignal](https://github.com/Stakemate369/yieldsignal/tree/main/client)
