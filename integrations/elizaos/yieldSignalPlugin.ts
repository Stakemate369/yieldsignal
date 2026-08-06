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
import { createYieldSignalClient, type LendingAsset, type YieldSignalAsset } from "yieldsignal-client";

export function parseAsset(text: string): YieldSignalAsset {
  // Checa staking ANTES do fallback genérico "eth" — "ETH staking"/"stake ETH"
  // bateria em /eth\b/ e seria classificado (errado) como WETH lending.
  if (/stak|lido|rocket.?pool/i.test(text)) return "ETH_STAKING";
  return /weth|eth\b/i.test(text) ? "WETH" : "USDC";
}

/**
 * Os quatro produtos analíticos só existem pra mercado de empréstimo. Reusar
 * `parseAsset` aqui deixaria "ETH staking" cair em ETH_STAKING e o agente
 * pagaria por uma rota que não existe — por isso a variante que nunca devolve
 * staking, em vez de um cast.
 */
export function parseLendingAsset(text: string): LendingAsset {
  return /weth|\beth\b/i.test(text) ? "WETH" : "USDC";
}

/**
 * `?positions=` a partir de texto livre: captura pares "protocolo 200000" ou
 * "protocolo:200000". Devolve `null` quando não achou nada reconhecível — a
 * ação então PEDE o dado em vez de chutar uma carteira, porque um relatório de
 * risco montado sobre posição inventada é pior que nenhum relatório.
 */
const KNOWN_PROTOCOLS = ["aave", "morpho", "compound", "moonwell", "euler", "fluid"] as const;

export function parsePositionsFromText(text: string): string | null {
  const found: string[] = [];
  for (const protocol of KNOWN_PROTOCOLS) {
    const m = new RegExp(`${protocol}\\s*[:=]?\\s*\\$?([0-9][0-9_.,]*)\\s*(k|m)?`, "i").exec(text);
    if (!m) continue;
    const base = Number(m[1]!.replace(/[_,]/g, ""));
    if (!Number.isFinite(base) || base <= 0) continue;
    const mult = m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2]?.toLowerCase() === "k" ? 1_000 : 1;
    found.push(`${protocol}:${Math.round(base * mult)}`);
  }
  return found.length > 0 ? found.join(",") : null;
}

/**
 * Paga $0.01 (x402, Base) por chamada via uma carteira CDP PRÓPRIA do
 * plugin (CDP_API_KEY_ID/SECRET/WALLET_SECRET no ambiente do runtime) — não
 * reaproveita nenhum wallet plugin da ElizaOS, pelo mesmo motivo documentado
 * no adapter do AgentKit (adaptar o signer é específico da versão instalada).
 */
const getYieldSignalAction: Action = {
  name: "GET_YIELD_SIGNAL",
  similes: ["CHECK_YIELD_SIGNAL", "BEST_LENDING_RATE", "USDC_WETH_APY", "ETH_STAKING_APY"],
  description:
    "Real-time risk-weighted yield signal: USDC/WETH lending APY on Base, or ETH staking APY on Ethereum mainnet. Costs $0.01 USDC per call via x402.",
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

      const text =
        signal.asset === "ETH_STAKING"
          ? `Best ETH staking rate right now: ${signal.bestProtocol} (${signal.gapBps}bps ahead of the runner-up).`
          : `Best ${signal.asset} lending rate on Base right now: ${signal.bestProtocol} (${signal.gapBps}bps ahead of the runner-up).`;
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

/**
 * Fábrica das ações analíticas. As quatro compartilham o mesmo esqueleto
 * (parsear o asset, chamar a rota paga, resumir em texto, nunca lançar), então
 * o esqueleto vive aqui e cada ação só passa o que muda. `summarize` recebe o
 * relatório íntegro — o resumo é pro humano, o `data` devolvido carrega tudo.
 */
function analyticsAction(params: {
  name: string;
  similes: string[];
  description: string;
  example: string;
  run: (asset: LendingAsset, text: string) => Promise<Record<string, unknown> | null>;
  summarize: (report: Record<string, unknown>, asset: LendingAsset) => string;
  missingInput?: string;
}): Action {
  return {
    name: params.name,
    similes: params.similes,
    description: params.description,
    validate: async (): Promise<boolean> => true,
    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state: State | undefined,
      _options: Record<string, unknown> | undefined,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const text = typeof message.content?.text === "string" ? message.content.text : "";
      const asset = parseLendingAsset(text);
      try {
        const report = await params.run(asset, text);
        if (!report) {
          const missing = params.missingInput ?? "I need more information to answer that.";
          await callback?.({ text: missing });
          return { success: false, error: missing };
        }
        const summary = params.summarize(report, asset);
        await callback?.({ text: summary, content: report });
        return { success: true, text: summary, data: report };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await callback?.({ text: `Failed to fetch the ${asset} report: ${error}` });
        return { success: false, error };
      }
    },
    examples: [
      [
        { name: "{{user}}", content: { text: params.example } },
        { name: "{{agent}}", content: { text: "Checking...", action: params.name } },
      ],
    ],
  };
}

const client = () => createYieldSignalClient(new CdpX402Client());

const getYieldDurabilityAction = analyticsAction({
  name: "GET_YIELD_DURABILITY",
  similes: ["IS_THE_YIELD_REAL", "INCENTIVE_DEPENDENCE", "POST_INCENTIVE_FLOOR"],
  description:
    "How much of the current APY survives if incentives stop, per protocol, plus whether the leader changes without them. Costs $0.01 USDC per call via x402.",
  example: "Is the USDC yield on Base real or just incentives?",
  run: async (asset) => (await client().getDurability(asset)) as unknown as Record<string, unknown>,
  summarize: (r, asset) => {
    const muda = r.rankingChangesWithoutIncentives;
    const piso = r.bestVerifiableFloor as { protocol: string; apyBps: number } | null;
    const cabeca =
      muda === true
        ? `Without incentives the ${asset} leader changes: ${r.bestProtocolNow} → ${r.bestProtocolPostIncentive}.`
        : muda === false
          ? `The ${asset} leader (${r.bestProtocolNow}) holds up without incentives.`
          : `Cannot say whether the ${asset} ranking changes — the current leader (${r.bestProtocolNow}) does not itemize its reward component.`;
    return piso
      ? `${cabeca} Highest yield provably independent of incentives: ${piso.protocol} at ${piso.apyBps}bps.`
      : cabeca;
  },
});

const getExitCapacityAction = analyticsAction({
  name: "GET_EXIT_CAPACITY",
  similes: ["CAN_I_WITHDRAW", "EXIT_LIQUIDITY", "MARKET_UTILIZATION"],
  description:
    "Whether you can actually withdraw: per-protocol utilization and free liquidity from the protocol's own books. Costs $0.01 USDC per call via x402.",
  example: "Can I pull $200k out of USDC lending on Base right now?",
  run: async (asset, text) => {
    const m = /\$?\s*([0-9][0-9_.,]*)\s*(k|m)?/i.exec(text.replace(/\b(usdc|weth|eth)\b/gi, ""));
    let amountUsd: number | undefined;
    if (m) {
      const base = Number(m[1]!.replace(/[_,]/g, ""));
      const mult = m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2]?.toLowerCase() === "k" ? 1_000 : 1;
      if (Number.isFinite(base) && base > 0) amountUsd = Math.round(base * mult);
    }
    return (await client().getCapacity(asset, amountUsd)) as unknown as Record<string, unknown>;
  },
  summarize: (r, asset) => {
    const exec = r.bestProtocolExecutable;
    const cov = r.coverage as { measured: number; total: number };
    return exec
      ? `For ${asset} on Base, the best market that can actually absorb your exit right now is ${exec} (${cov.measured} of ${cov.total} protocols measured).`
      : `No ${asset} market was confirmed able to absorb that size right now (${cov.measured} of ${cov.total} measured — unmeasured is not the same as liquid).`;
  },
});

const getRateSensitivityAction = analyticsAction({
  name: "GET_RATE_SENSITIVITY",
  similes: ["DISTANCE_TO_KINK", "WILL_RATES_SPIKE", "UTILIZATION_HEADROOM"],
  description:
    "How close the market is to the kink where borrow rates explode, read from the protocol's own rate curve. Costs $0.01 USDC per call via x402.",
  example: "How close is Base USDC lending to a rate spike?",
  run: async (asset) => (await client().getSensitivity(asset)) as unknown as Record<string, unknown>,
  summarize: (r, asset) => {
    const t = r.tightestToKink as { protocol: string; headroomBps: number } | null;
    if (!t) return `No ${asset} market with a readable rate curve is currently below its kink.`;
    return `Tightest ${asset} market: ${t.protocol}, ${(t.headroomBps / 100).toFixed(2)} percentage points of utilization from the kink where borrow rates jump.`;
  },
});

const getSharedExposureAction = analyticsAction({
  name: "GET_SHARED_EXPOSURE",
  similes: ["AM_I_DIVERSIFIED", "CONCENTRATION_RISK", "SHARED_COLLATERAL"],
  description:
    "How much of a portfolio sits behind the same collateral, oracle or vault curator across venues. Costs $0.01 USDC per call via x402.",
  example: "I have 200k in aave and 150k in morpho — am I actually diversified?",
  missingInput:
    "I need your positions to answer that — tell me the protocol and size, e.g. 'aave 200000, morpho 150000'.",
  run: async (asset, text) => {
    const positions = parsePositionsFromText(text);
    if (!positions) return null;
    return (await client().getExposure(asset, positions)) as unknown as Record<string, unknown>;
  },
  summarize: (r) => {
    const top = r.topFactor as { kind: string; key: string; pctOfAttributed: number; via: string[] } | null;
    const cov = r.coverage as { attributedUsd: number; totalUsd: number };
    if (!top) return `Nothing could be attributed across those positions (0 of $${cov.totalUsd} traceable).`;
    return `${r.nominalVenues} venues, but ${top.pctOfAttributed}% of the $${cov.attributedUsd} that can be traced sits behind one ${top.kind} (${top.key}), reaching it via ${top.via.join(" and ")}.`;
  },
});

export const yieldSignalPlugin: Plugin = {
  name: "yieldsignal",
  description:
    "Paid (x402) yield and risk intelligence: the signal (USDC/WETH lending on Base, ETH staking on mainnet), plus durability, exit capacity, rate sensitivity and shared exposure for Base lending.",
  actions: [
    getYieldSignalAction,
    getYieldDurabilityAction,
    getExitCapacityAction,
    getRateSensitivityAction,
    getSharedExposureAction,
  ],
};
