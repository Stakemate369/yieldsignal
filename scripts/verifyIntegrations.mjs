// Verifica os adapters de AgentKit/GOAT contra o output REAL do `tsc` (não
// tsx/vitest/esbuild) — os dois usam `emitDecoratorMetadata` +
// `reflect-metadata` pra resolver o schema/parâmetros de cada action/tool via
// `design:paramtypes`, e esbuild (o transform por trás de tsx/vite/vitest)
// não emite esse metadado: importar esses dois arquivos sob um bundler
// esbuild-based lança "Failed to get parameters for ..." na hora do import.
// Isso não é um bug nosso — é uma limitação documentada do esbuild — mas
// precisa rodar contra `dist/` (build real via `tsc -p tsconfig.json`) pra
// ter qualquer valor. Rode via `npm run verify-integrations` (builda antes).
//
// ElizaOS não usa decorators (Plugin/Action são objetos simples) — coberto
// normalmente em test/integrations/elizaos.test.ts (vitest, roda em CI).
import "reflect-metadata";
import assert from "node:assert/strict";
import { yieldSignalActionProvider } from "../dist/integrations/agentkit/yieldSignalActionProvider.js";
import { yieldsignal } from "../dist/integrations/goat/yieldSignalPlugin.js";

async function verifyAgentKit() {
  const provider = yieldSignalActionProvider();
  const actions = provider.getActions({});
  // O AgentKit prefixa o nome da action com o da classe do provider
  // (`YieldSignalActionProvider_get_yield_signal`) — comparar sem tirar o
  // prefixo falha por formato, não por conteúdo.
  const nomes = actions.map((a) => a.name.replace(/^.*?_(?=get_)/, "")).sort();
  assert.deepEqual(
    nomes,
    ["get_exit_capacity", "get_rate_sensitivity", "get_shared_exposure", "get_yield_durability", "get_yield_signal"],
    `AgentKit: conjunto de actions inesperado — ${nomes.join(", ")}`,
  );

  const action = actions.find((a) => a.name.endsWith("get_yield_signal"));
  // AgentKit prefixa o nome com o nome da classe (`${ClassName}_${name}`,
  // ver CreateAction em actionDecorator.js) — não é "get_yield_signal" puro,
  // suposição inicial errada que só o teste contra o dist real revelou.
  assert.equal(action.name, "YieldSignalActionProvider_get_yield_signal");
  assert.match(action.description, /USDC\/WETH lending APY/);
  assert.equal(action.schema.safeParse({}).success, true, "schema deve aceitar asset omitido (default USDC)");
  assert.equal(action.schema.safeParse({ asset: "WETH" }).success, true);
  assert.equal(action.schema.safeParse({ asset: "DAI" }).success, false, "schema deve rejeitar asset fora do enum");
  assert.equal(provider.supportsNetwork({}), true);
  console.log("✓ AgentKit action provider: registro, schema e supportsNetwork corretos (dist real)");
}

async function verifyGoat() {
  const plugin = yieldsignal();
  assert.equal(plugin.supportsChain({ type: "evm" }), true);
  assert.equal(plugin.supportsChain({ type: "solana" }), false);

  const tools = await plugin.getTools({});
  const nomesGoat = tools.map((t) => t.name).sort();
  assert.deepEqual(
    nomesGoat,
    ["get_exit_capacity", "get_rate_sensitivity", "get_shared_exposure", "get_yield_durability", "get_yield_signal"],
    `GOAT: conjunto de tools inesperado — ${nomesGoat.join(", ")}`,
  );
  assert.match(tools[0].description, /USDC\/WETH lending APY/);
  console.log("✓ GOAT plugin: registro de tool, supportsChain e parâmetros (createToolParameters) corretos (dist real)");
}

async function main() {
  await verifyAgentKit();
  await verifyGoat();
  console.log("\nOK — integrações AgentKit e GOAT verificadas contra build tsc real.");
}

main().catch((err) => {
  console.error("\nFALHOU:", err);
  process.exit(1);
});
