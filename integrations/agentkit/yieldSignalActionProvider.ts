/**
 * REFERÊNCIA NÃO TESTADA — ver integrations/README.md. Escrito a partir do
 * formato conhecido de Action Provider do Coinbase AgentKit (classe que
 * estende `ActionProvider`, método decorado com `@CreateAction`), sem o
 * pacote `@coinbase/agentkit` instalado pra confirmar contra a versão atual.
 * Confira a assinatura de `ActionProvider`/`CreateAction`/`Network` antes de
 * usar — é o ponto mais provável de ter mudado.
 *
 * npm install @coinbase/agentkit yieldsignal-client @coinbase/cdp-sdk zod
 */
import { ActionProvider, CreateAction } from "@coinbase/agentkit";
import type { Network } from "@coinbase/agentkit";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { createYieldSignalClient, YIELD_SIGNAL_ASSETS } from "yieldsignal-client";
import { z } from "zod";

const GetYieldSignalSchema = z.object({
  asset: z.enum(YIELD_SIGNAL_ASSETS).optional().default("USDC"),
});

/**
 * Paga $0.01 (x402, Base) por chamada via uma carteira CDP PRÓPRIA desta
 * action provider (CDP_API_KEY_ID/SECRET/WALLET_SECRET no ambiente do
 * agente) — não reaproveita o wallet provider do próprio AgentKit, porque
 * adaptar o signer nativo do AgentKit pro formato que `@x402/evm` espera é
 * específico da versão instalada e não dava pra verificar aqui sem o pacote.
 * Se o agente já tem uma carteira CDP funded, é a via mais direta.
 */
class YieldSignalActionProvider extends ActionProvider {
  constructor() {
    super("yieldsignal", []);
  }

  @CreateAction({
    name: "get_yield_signal",
    description:
      "Real-time risk-weighted yield signal: USDC/WETH lending APY on Base, or ETH_STAKING liquid staking APY on Ethereum mainnet. Costs $0.01 USDC per call via x402.",
    schema: GetYieldSignalSchema,
  })
  async getYieldSignal(args: z.infer<typeof GetYieldSignalSchema>): Promise<string> {
    const client = new CdpX402Client();
    const yieldSignal = createYieldSignalClient(client);
    const signal = await yieldSignal.getSignal(args.asset);
    return JSON.stringify(signal);
  }

  supportsNetwork = (_network: Network): boolean => true;
}

export const yieldSignalActionProvider = (): YieldSignalActionProvider => new YieldSignalActionProvider();
