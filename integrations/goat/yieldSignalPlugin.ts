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
import { createYieldSignalClient, YIELD_SIGNAL_ASSETS } from "yieldsignal-client";
import { z } from "zod";

class GetYieldSignalParameters extends createToolParameters(
  z.object({ asset: z.enum(YIELD_SIGNAL_ASSETS).optional().default("USDC") }),
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
