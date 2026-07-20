# Integrations

Thin adapters exposing YieldSignal's `get_yield_signal` as a native action/tool for three agent frameworks where autonomous agents commonly discover paid tools: [Coinbase AgentKit](https://github.com/coinbase/agentkit), [ElizaOS](https://github.com/elizaos/eliza) and [GOAT SDK](https://github.com/goat-sdk/goat).

**Status: typechecked and runtime-verified against real installs of all three SDKs** (`@coinbase/agentkit`, `@elizaos/core`, `@goat-sdk/core`+`@goat-sdk/wallet-evm`, all in this repo's `devDependencies`). Verification method per framework:

- **ElizaOS** (`elizaos/yieldSignalPlugin.ts`) — plain object (`Plugin`/`Action`, no decorators). Covered by a normal vitest test, `test/integrations/elizaos.test.ts`, which runs in CI on every push.
- **AgentKit** and **GOAT** (`agentkit/yieldSignalActionProvider.ts`, `goat/yieldSignalPlugin.ts`) — class-based, decorator-driven (`@CreateAction`, `@Tool`). **Important:** both frameworks resolve the action/tool's parameter schema at runtime via `emitDecoratorMetadata` + `reflect-metadata` (`Reflect.getMetadata("design:paramtypes", ...)`). esbuild-based toolchains — **tsx, Vite, Vitest, esbuild-register** — do not emit that metadata, so importing either file under one of those throws `Failed to get parameters for ...` immediately on import. This is not a bug in this repo's code; it's a documented esbuild limitation. Consequence: **these two adapters only work when compiled with the real TypeScript compiler (`tsc`)** — they cannot be `tsx`'d directly or bundled with esbuild/Vite without a metadata-aware transform (e.g. `unplugin-swc`) in front of them. If you're wiring one of these into a project that runs on tsx/Vite, either pre-compile just these files with `tsc` first, or swap in an SWC-based transform that supports `emitDecoratorMetadata`.
  - Verified via `npm run verify-integrations` (`scripts/verifyIntegrations.mjs`): builds the whole repo with `tsc -p tsconfig.json`, then imports the **compiled** `dist/integrations/{agentkit,goat}/...` output under plain `node` (no esbuild anywhere in that path) and asserts the registered action/tool name, description and schema. Runs in CI on every push.

Real bugs this verification pass caught (all fixed):
- GOAT's `@Tool` needs the method's parameter typed as the class `createToolParameters(schema)` returns — not a bare `z.infer<typeof schema>` — because the schema is recovered via parameter-type reflection, not passed to the decorator directly. A plain inferred type compiles fine but fails at runtime.
- ElizaOS's `Handler` return type is `Promise<ActionResult | void | undefined>`, not `Promise<boolean>` (the shape the adapter was originally written against had drifted).
- AgentKit's `@CreateAction` always prefixes the registered action name with the class name (`${ClassName}_${name}`, see `actionDecorator.js`) — the actual name an agent calls is `YieldSignalActionProvider_get_yield_signal`, not the bare `get_yield_signal` passed into the decorator params. Also fires a Coinbase analytics event (`sendAnalyticsEvent`) on every real invocation — framework behavior, not something this adapter can opt out of.

Every adapter delegates the actual paid HTTP call to [`yieldsignal-client`](../client) + `CdpX402Client` from `@coinbase/cdp-sdk/x402` — the same client/payment path already proven in this repo's own scripts — rather than trying to wire each framework's own wallet abstraction into x402 signing (that adaptation is framework-specific and was the part most worth double-checking; each file's header comment states why).

## Local setup (this repo, before `yieldsignal-client` is published to npm)

1. `npm --prefix client install && npm --prefix client run build` (produces `client/dist`, gitignored — must be rebuilt after any change to `client/src`).
2. Root `npm install` — `yieldsignal-client` is wired as `file:./client` in root `devDependencies` (temporary, until the npm publish blocked in [`feedback_npm_publish_flow`] is resolved), so it resolves locally.
3. `npx tsc --noEmit -p tsconfig.json` — typechecks `integrations/**` along with the rest of the repo (root `tsconfig.json` has `experimentalDecorators`/`emitDecoratorMetadata` enabled specifically for this directory).
4. `npm run verify-integrations` — real runtime check for AgentKit/GOAT (see above). `npm test` (vitest) covers ElizaOS.

Once `yieldsignal-client` is on npm, a real consumer just runs the three-line install shown in each file's header comment against their own project — no need to touch this repo's `client/` folder.

## Files

- `agentkit/yieldSignalActionProvider.ts` — Coinbase AgentKit `ActionProvider`
- `elizaos/yieldSignalPlugin.ts` — ElizaOS `Plugin`/`Action`
- `goat/yieldSignalPlugin.ts` — GOAT SDK `PluginBase`/`Tool`

None of these are wired into this repo's production `build`/`dev` — they're meant to be copied into (or, once upstreamed, installed inside) a project that already has the target framework installed. They ARE wired into this repo's own typecheck and verification (`verify-integrations`, `test/integrations/elizaos.test.ts`), both run in CI, specifically so this directory can't silently drift out of sync with the real SDKs again.
