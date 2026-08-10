# Verifiable trust for agent-to-agent commerce: a working reference implementation

When one autonomous agent pays another for data, payment is the easy part. The hard part is
everything payment doesn't answer:

- **Who am I paying?** An HTTPS domain is not a portable identity.
- **Did I get what the seller actually produced?** A response body proves nothing about its origin.
- **Was the seller ever right before?** Every service claims accuracy. None of them let you check.
- **What happens if it's wrong?** Usually nothing.

YieldSignal is a small, live service — it sells risk-weighted yield signals for ETH liquid staking
and Base lending markets — but the interesting part isn't the product. It's that all four questions
above are answered by **on-chain artifacts you can verify without trusting the server at all**, and
the whole stack runs in production on a hobby-tier serverless deploy.

This document lists every artifact and the exact command to check it. Nothing here is a claim you
have to take on faith; if a command below doesn't reproduce, the claim is wrong.

## The four primitives

| Question | Primitive | Artifact |
|---|---|---|
| How do I pay? | [x402](https://x402.org) (HTTP 402 + on-chain settlement) | per-call USDC settlement on Base |
| Who am I paying? | [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) Identity Registry | `agentId` **59272** on Base |
| Is this response authentic? | EIP-712 typed-data signature bound to the body by `contentHash` | `X-Signal-Signature` header |
| Was it right before? | [EAS](https://attest.org) attestations + an accuracy score derived from them | schema `0xe74a27f6…dd272` |

All four use the **same address**: `0x561143BFE9E2D975D92e915B8EfFEAa54119472a`. It receives the
payments, signs the responses, holds the agent identity and publishes the attestations. That
single-address property matters: it's what makes "the thing that got paid" and "the thing that
signed" provably the same actor, with no extra registry to trust.

### 1. Identity — ERC-8004

```
IdentityRegistry   eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
ReputationRegistry eip155:8453:0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
agentId            59272
mint tx            0x11529ab3ce854afc41f8ec4bd04bbe74bdff2f7f6c9c3ca508ee72b5fa210239
```

The registration file that `agentURI` resolves to is served at
[`/agent-card.json`](https://yieldsignal.vercel.app/agent-card.json). A buyer that has never seen
this service can go from an on-chain `agentId` to a callable endpoint without any x402-specific
directory, and can leave verifiable feedback on the `ReputationRegistry` afterwards. The registry
blocks self-feedback, so reputation can't be manufactured by the seller.

### 2. Response integrity — EIP-712 bound to the body

Every REST and MCP response is signed as typed data, and the signed struct includes
`contentHash = keccak256(exact response body bytes)`. That binding is the point: a signature over a
summary would let the server sign one thing and serve another.

```bash
# 402 challenge — this is what a discovery probe sees, and what EVERY unpaid
# request sees: there is no free tier and no bypass parameter.
curl -i https://yieldsignal.vercel.app/signal/eth-staking-yield

# paid call, with the signature headers (any x402 client settles the 402 for you)
curl -sD /tmp/h https://yieldsignal.vercel.app/signal/eth-staking-yield -o /tmp/b
grep -i '^x-signal-' /tmp/h
```

```ts
import { verifyTypedData, keccak256, toBytes } from "viem";
const raw = readFileSync("/tmp/b", "utf8");           // exact bytes, never re-serialized
const payload = JSON.parse(headers["x-signal-eip712-payload"]);
const ok =
  payload.message.contentHash === keccak256(toBytes(raw)) &&
  (await verifyTypedData({ ...payload, signature: headers["x-signal-signature"],
                           address: headers["x-signal-signer"] }));
// and: signer === the payTo address named in the 402 challenge for this route
```

Three checks, not one: the signature is valid, the `contentHash` matches the body you actually
received, **and** the signer is the same address the 402 challenge told you to pay. Skipping the
third makes the first two decorative.

### 3. Track record — EAS, then a score computed from it

Attestations are published automatically when the signal changes materially (best protocol flips, or
the gap moves ≥25bps) or goes stale (>12h) — not per call, which would have no cost ceiling.

```
EAS schema UID  0xe74a27f6c216134a1a3aef4c26e29bd8866ac679a8023ddde34faa0bb05dd272
attester        0x561143BFE9E2D975D92e915B8EfFEAa54119472a
browse          https://base.easscan.org/schema/view/0xe74a27f6c216134a1a3aef4c26e29bd8866ac679a8023ddde34faa0bb05dd272
```

On top of that history sits the piece that's actually hard to copy:

```bash
curl -s https://yieldsignal.vercel.app/accuracy.json   # free, no payment, no key
```

It returns, per asset, a **within-tolerance hit-rate** ("when we flagged a protocol, was it still the
leader — or at most 25bps behind — when scored against the current market?") and the **average
regret in bps**. Both are recomputed 1:1 from the public attestations on every request. A buyer can
audit the seller's history before deciding to pay, and can recompute the same number straight from
EAS without this server.

This is the only real moat in the stack. The underlying data is a commodity — DefiLlama gives it
away — but a dated, on-chain record of calls that can't be backdated takes calendar time to
accumulate, and it accrues whether or not anyone is buying.

### 4. Payment — x402, and evidence it works with a stranger

Self-testing proves plumbing, not demand. On **2026-07-27 23:45:41 UTC** a wallet with no
relationship to the operator paid for a call:

```
payer     0xfe2d5E9c5aE6E48B7F8b0b82AC4dE8B423bA0557   (a smart contract wallet, not an EOA)
amount    $0.01 USDC on Base
tx        0xeb0728bd0f9d9e141fba125b4178339510a3bbdbc869632ae68cb7c7d9bc16c9
```

The full receipt history is auditable by anyone: scan `Transfer` events of Base USDC
(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) with `to` = the payee address and group by sender.
That's how this payment was found in the first place, and it's the reason the accounting in this
document can't be fudged — the payee's balance has to equal the sum of the receipts, and it does.

There is also a fully verified end-to-end trace from an independent buyer wallet on a `$0.05`
`/decision` call (payer `0xC243…3c15`, distinct from the seller), where all three signature checks
passed. See `scripts/evidenceE2E.mts`.

## What this does *not* solve

Publishing the limitations is part of the point — a trust stack that only advertises its strengths
is asking for the same faith it claims to remove.

- **The accuracy metric is directional, not a backtest.** It scores past calls against the *current*
  market, because scoring against the APY at that exact historical block would need a private
  indexer. The endpoint says so in its own `basis` field: `directional-vs-current-market`. Read it
  as "does the call still hold up?", not as a return series.
- **Accuracy is not uniform across products, and the flagship isn't the oldest product.** Measured
  over 100 attestations, the staking signal held up far better than the Base USDC lending signal —
  USDC lending churns fast enough that a call decays quickly. That's why bare `/signal` resolves to
  the staking route. The weak number stays published; hiding it would defeat the exercise.
- **There is no economic guarantee.** A bonded guarantee — where the seller stakes capital and pays
  out on a breach — is implemented as a deterministic resolution engine
  (`src/guarantee/resolveGuarantee.ts`) but **the escrow is not deployed and no bond is funded**.
  `/guarantee/terms.json` reports `status: engine-ready:escrow-not-deployed` rather than implying a
  payout that cannot happen. Promising a machine a payout you can't honor is worse than promising it
  to a human: the machine will believe you.
- **Reputation is thin.** The `ReputationRegistry` path works and self-feedback is blocked by the
  contract, which also means the seller cannot bootstrap it. It stays near-empty until real buyers
  choose to write to it.
- **Availability is ordinary.** Signed responses and EAS attestations mean you don't have to trust
  the server's uptime to *verify* history, but you still need it up to get a fresh signal.

## Layout

- `src/signal/` — pure comparison and MOVE/HOLD logic, no I/O, fully unit tested
- `src/signal/signResponse.ts` — EIP-712 struct + `contentHash` binding
- `src/attestation/` — EAS schema/encoding, auto-attest trigger, track record, accuracy score, ERC-8004
- `src/usage/` — durable funnel counters (platform runtime logs aren't reachable from outside)
- `src/guarantee/` — resolution engine and honest terms; escrow deliberately absent
- `src/mcp.ts` — paid MCP tools (`tools/list`/`initialize` stay free, only the call is paid)

Everything above is MIT-licensed and reproducible from the repo:
[github.com/Stakemate369/yieldsignal](https://github.com/Stakemate369/yieldsignal).

## If you're building something similar

Four things that cost real time to discover:

1. **A free trial is a leak, not a sample — it was removed on 2026-08-10.** First it broke
   discovery: x402 crawlers classify an endpoint by seeing a `402`, so while the first call from any
   new IP silently succeeded, the service was invisible to every directory. Moving it behind an
   explicit `?trial=1` fixed discovery and created a worse problem — the opt-in was advertised in
   `/openapi.json`, and the audience that reads discovery documents *is* the automated crawler. With
   the quota held in per-instance memory (3 calls per IP, reset on every cold start) there was no
   real ceiling: 125 product responses were served against 26 payments in the service's entire
   history, and on 2026-08-09 alone 12 responses went out with zero on-chain settlement. Every
   product route is now paid, with no bypass parameter.
2. **Sign the exact bytes you send.** Re-serializing the object for the signature (`res.json()` on
   one path, `JSON.stringify` on the other) produces a `contentHash` mismatch that only shows up in
   a buyer's verifier, not in your tests.
3. **A wallet-carrying plugin gets a real security review.** The elizaOS registry pulled the first
   published version because it loaded a wallet with no spend controls, no timeout and no signature
   verification — even though it compiled and its tests passed. Ship spend caps, an allowlist, an
   `AbortController` and adversarial tests with a real signer from day one.
4. **Don't measure your product with the flattering metric.** A binary "is it still the single best?"
   punished calls that were 5bps behind the leader, and read as a much worse service than it is. A
   tolerance band plus average regret describes reality better — and it's harder to game, because
   both numbers are recomputed from public data.
