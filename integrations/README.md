# Integrations (reference, unverified)

Thin adapters exposing YieldSignal's `get_yield_signal` as a native action/tool for three agent frameworks where autonomous agents commonly discover paid tools: [Coinbase AgentKit](https://github.com/coinbase/agentkit), [ElizaOS](https://github.com/elizaos/eliza) and [GOAT SDK](https://github.com/goat-sdk/goat).

**Status: reference code, not smoke-tested against a real install of the target SDK.** These were written from each framework's known plugin/action-provider shape, without the actual package installed to typecheck or run against — API surface may have drifted since. Before using or contributing one of these upstream:

1. Install the target framework in a real project (`@coinbase/agentkit`, `@elizaos/core`, or `@goat-sdk/core` + `@goat-sdk/wallet-evm`).
2. Confirm the plugin/action shape still matches (constructor signature, decorator vs. factory API, etc. — these are the parts most likely to have changed).
3. Run an actual paid call end-to-end against `https://yieldsignal.vercel.app` (small dev-funded wallet, `$0.01`/call) before trusting the output.

Every adapter delegates the actual paid HTTP call to [`yieldsignal-client`](../client) + `CdpX402Client` from `@coinbase/cdp-sdk/x402` — the same client/payment path already proven in this repo's own scripts — rather than trying to wire each framework's own wallet abstraction into x402 signing (that adaptation is framework-specific and the part most worth double-checking).

- `agentkit/yieldSignalActionProvider.ts` — Coinbase AgentKit `ActionProvider`
- `elizaos/yieldSignalPlugin.ts` — ElizaOS `Plugin`/`Action`
- `goat/yieldSignalPlugin.ts` — GOAT SDK `PluginBase`/`Tool`

None of these are wired into this repo's build, tests, or CI (outside `tsconfig.json`'s `include` and vitest's default discovery) — they're standalone reference files meant to be copied into a project that already has the target framework installed.
