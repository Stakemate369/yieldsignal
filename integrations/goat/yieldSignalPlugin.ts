/**
 * Verificado contra @goat-sdk/core@0.5.0 real (typecheck + teste unitário em
 * test/integrations/goat.test.ts) — não é mais referência não testada.
 * Desvio real encontrado contra a suposição inicial: `@Tool` lê o schema do
 * parâmetro via `design:paramtypes` (emitDecoratorMetadata), que só existe
 * pra CLASSES — um `z.infer<typeof Schema>` (tipo puro, sem classe em
 * runtime) não é capturável por reflection, então o parâmetro precisa ser
 * tipado com a classe que `createToolParameters(schema)` gera, não com o
 * tipo inferido do Zod diretamente. Typecheck não pega isso (compila igual
 * do jeito errado); só falharia em runtime na hora do GOAT tentar achar o
 * schema associado à tool.
 *
 * npm install @goat-sdk/core yieldsignal-client @coinbase/cdp-sdk zod
 */
import { PluginBase, Tool, createToolParameters } from "@goat-sdk/core";
import type { Chain, WalletClientBase } from "@goat-sdk/core";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { createYieldSignalClient, YIELD_SIGNAL_ASSETS, LENDING_ASSETS } from "yieldsignal-client";
import { z } from "zod";

class GetYieldSignalParameters extends createToolParameters(
  z.object({ asset: z.enum(YIELD_SIGNAL_ASSETS).optional().default("USDC") }),
) {}

// Cada tool precisa da PRÓPRIA classe de parâmetros: o `@Tool` do GOAT resolve
// o schema por `design:paramtypes`, que só enxerga classes — reaproveitar uma
// única classe entre tools faria todas apontarem pro mesmo schema.
class LendingAssetParameters extends createToolParameters(
  z.object({ asset: z.enum(LENDING_ASSETS).optional().default("USDC") }),
) {}

class SensitivityParameters extends createToolParameters(
  z.object({ asset: z.enum(LENDING_ASSETS).optional().default("USDC") }),
) {}

class CapacityParameters extends createToolParameters(
  z.object({
    asset: z.enum(LENDING_ASSETS).optional().default("USDC"),
    amountUsd: z.number().optional(),
  }),
) {}

class ExposureParameters extends createToolParameters(
  z.object({
    asset: z.enum(LENDING_ASSETS).optional().default("USDC"),
    positions: z.string(),
  }),
) {}

/**
 * Paga $0.01 (x402, Base) por chamada via uma carteira CDP PRÓPRIA do
 * plugin (CDP_API_KEY_ID/SECRET/WALLET_SECRET no ambiente do agente) — não
 * reaproveita o `WalletClientBase` do próprio GOAT, pelo mesmo motivo
 * documentado nos outros dois adapters (adaptar o signer é específico da
 * versão instalada, não dava pra verificar aqui sem o pacote).
 */
class YieldSignalToolset {
  @Tool({
    name: "get_yield_signal",
    description:
      "Real-time risk-weighted yield signal: USDC/WETH lending APY on Base, or ETH_STAKING liquid staking APY on Ethereum mainnet. Costs $0.01 USDC per call via x402.",
  })
  async getYieldSignal(parameters: GetYieldSignalParameters): Promise<string> {
    const client = new CdpX402Client();
    const yieldSignal = createYieldSignalClient(client);
    const signal = await yieldSignal.getSignal(parameters.asset);
    return JSON.stringify(signal);
  }

  @Tool({
    name: "get_yield_durability",
    description:
      "How much of the current APY survives if incentives stop: base-vs-reward split, the post-incentive floor, and whether the leader changes without incentives. Undecomposable sources are named, never assumed incentive-free. Base lending only. Costs $0.01 USDC per call via x402.",
  })
  async getYieldDurability(parameters: LendingAssetParameters): Promise<string> {
    const yieldSignal = createYieldSignalClient(new CdpX402Client());
    return JSON.stringify(await yieldSignal.getDurability(parameters.asset));
  }

  @Tool({
    name: "get_exit_capacity",
    description:
      "Can you actually withdraw? Per-protocol utilization and free liquidity from the protocol's own books, plus whether your size can exit now. Unmeasured protocols are never reported as executable. Costs $0.01 USDC per call via x402.",
  })
  async getExitCapacity(parameters: CapacityParameters): Promise<string> {
    const yieldSignal = createYieldSignalClient(new CdpX402Client());
    return JSON.stringify(await yieldSignal.getCapacity(parameters.asset, parameters.amountUsd));
  }

  @Tool({
    name: "get_rate_sensitivity",
    description:
      "How close the market is to the kink where borrow rates explode: utilization, the kink read from the protocol's own curve, headroom in bps, and the multiple just past it. Aave and Compound only. Costs $0.01 USDC per call via x402.",
  })
  async getRateSensitivity(parameters: SensitivityParameters): Promise<string> {
    const yieldSignal = createYieldSignalClient(new CdpX402Client());
    return JSON.stringify(await yieldSignal.getSensitivity(parameters.asset));
  }

  @Tool({
    name: "get_shared_exposure",
    description:
      "How much of a portfolio sits behind the same collateral, oracle or curator, and via which venues. Pass positions as protocol:usd pairs, e.g. 'aave:200000,morpho:150000'. Costs $0.01 USDC per call via x402.",
  })
  async getSharedExposure(parameters: ExposureParameters): Promise<string> {
    const yieldSignal = createYieldSignalClient(new CdpX402Client());
    return JSON.stringify(await yieldSignal.getExposure(parameters.asset, parameters.positions));
  }
}

export class YieldSignalPlugin extends PluginBase<WalletClientBase> {
  constructor() {
    super("yieldsignal", [new YieldSignalToolset()]);
  }

  supportsChain = (chain: Chain): boolean => chain.type === "evm";
}

export function yieldsignal(): YieldSignalPlugin {
  return new YieldSignalPlugin();
}
