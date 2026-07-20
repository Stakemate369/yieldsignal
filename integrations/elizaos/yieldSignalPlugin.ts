/**
 * Verificado contra @elizaos/core@1.7.2 real (typecheck + teste unitário em
 * test/integrations/elizaos.test.ts) — não é mais referência não testada.
 * Único desvio real encontrado contra a suposição inicial: `Handler` exige
 * retorno `Promise<ActionResult | void | undefined>`, não `Promise<boolean>`
 * (API mudou desde a versão em que este adapter foi escrito de memória).
 *
 * npm install @elizaos/core yieldsignal-client @coinbase/cdp-sdk
 */
import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, Plugin, State } from "@elizaos/core";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { createYieldSignalClient, type YieldSignalAsset } from "yieldsignal-client";

function parseAsset(text: string): YieldSignalAsset {
  return /weth|eth\b/i.test(text) ? "WETH" : "USDC";
}

/**
 * Paga $0.01 (x402, Base) por chamada via uma carteira CDP PRÓPRIA do
 * plugin (CDP_API_KEY_ID/SECRET/WALLET_SECRET no ambiente do runtime) — não
 * reaproveita nenhum wallet plugin da ElizaOS, pelo mesmo motivo documentado
 * no adapter do AgentKit (adaptar o signer é específico da versão instalada).
 */
const getYieldSignalAction: Action = {
  name: "GET_YIELD_SIGNAL",
  similes: ["CHECK_YIELD_SIGNAL", "BEST_LENDING_RATE", "USDC_WETH_APY"],
  description:
    "Real-time risk-weighted USDC or WETH lending APY across Aave, Compound, Morpho, Moonwell, Euler and Fluid on Base. Costs $0.01 USDC per call via x402.",
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const asset = parseAsset(typeof message.content?.text === "string" ? message.content.text : "");
    try {
      const client = new CdpX402Client();
      const yieldSignal = createYieldSignalClient(client);
      const signal = await yieldSignal.getSignal(asset);

      const text = `Best ${signal.asset} lending rate on Base right now: ${signal.bestProtocol} (${signal.gapBps}bps ahead of the runner-up).`;
      await callback?.({ text, content: signal });
      return { success: true, text, data: signal as unknown as Record<string, unknown> };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await callback?.({ text: `Failed to fetch the ${asset} yield signal: ${error}` });
      return { success: false, error };
    }
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "What's the best USDC lending rate on Base right now?" } },
      { name: "{{agent}}", content: { text: "Checking...", action: "GET_YIELD_SIGNAL" } },
    ],
  ],
};

export const yieldSignalPlugin: Plugin = {
  name: "yieldsignal",
  description: "Paid (x402) real-time lending yield signal for USDC/WETH on Base.",
  actions: [getYieldSignalAction],
};
