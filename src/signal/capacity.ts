import type { AssetId, ProtocolId, RateReading } from "../market-data/types.js";

/**
 * CAPACIDADE DE SAÍDA — "eu consigo tirar meu dinheiro deste mercado?"
 *
 * A APY de supply não responde isso, e o TVL também não: um mercado com US$ 100M
 * fornecidos e US$ 99M emprestados tem o MESMO `tvlUsd` de um com US$ 10M
 * emprestados, e só o primeiro prende quem quer sair. Pior, o primeiro paga
 * MAIS — a taxa alta é o sintoma da utilização alta, não um prêmio de graça.
 * Um agente que ranqueia só por APY caminha exatamente pra armadilha.
 *
 * Tudo aqui vem dos livros do próprio protocolo (ver `MarketLiquidity`), sem
 * modelo e sem estimativa. O que NÃO é medido fica explicitamente marcado como
 * não medido: `measured: false` nunca deve ser lido como "ilíquido", e nenhum
 * campo de veredito é preenchido nesse caso.
 *
 * Deliberadamente FORA do escopo: o impacto em bps que a sua entrada/saída causa
 * na taxa. Calcular isso exige a curva do modelo de juros de cada protocolo
 * (contrato de InterestRateStrategy na Aave, `perSecondInterestRate*` no Comet),
 * que nenhuma leitura atual busca. Sem a curva, qualquer número seria chute com
 * cara de precisão — e a fatia da posição sobre o total fornecido
 * (`positionShareOfSuppliedPct`, esse sim medido) já responde a pergunta
 * prática de "eu sou grande demais pra este mercado?".
 */

/** Acima disto, sair na hora depende de alguém pagar empréstimo antes. Ver nota em `liquidityTier`. */
const TIGHT_UTILIZATION_BPS = 9_000;
const MODERATE_UTILIZATION_BPS = 8_000;

export type LiquidityTier = "ample" | "moderate" | "tight" | "unmeasured";

/**
 * Faixa de utilização, sem juízo de valor embutido além do que o número diz.
 * Os cortes (80%/90%) não são previsão: são onde as curvas de juros dos próprios
 * protocolos viram o "kink" e a taxa dispara justamente porque a liquidez ficou
 * escassa. Descrevem o estado atual do mercado, não o que vai acontecer.
 */
function liquidityTier(utilizationBps: number | null): LiquidityTier {
  if (utilizationBps === null) return "unmeasured";
  if (utilizationBps >= TIGHT_UTILIZATION_BPS) return "tight";
  if (utilizationBps >= MODERATE_UTILIZATION_BPS) return "moderate";
  return "ample";
}

export interface CapacityEntry {
  protocol: ProtocolId;
  supplyApyBps: number;
  /** `false` = este leitor não mede liquidez. Nunca significa "mercado ilíquido". */
  measured: boolean;
  utilizationBps: number | null;
  liquidityTier: LiquidityTier;
  availableLiquidityUsd: number | null;
  totalSuppliedUsd: number | null;
  /** Liquidez livre ÷ posição consultada. `null` sem `amountUsd` ou sem valor em USD. */
  exitCoverageRatio: number | null;
  /** Só afirmado quando os dois lados da conta são conhecidos. */
  canExitNow: boolean | null;
  /** Que fatia do mercado a posição consultada representaria. */
  positionShareOfSuppliedPct: number | null;
}

export interface CapacityReport {
  asset: AssetId;
  basis: "onchain-protocol-books";
  amountUsd: number | null;
  bestProtocolNow: ProtocolId | null;
  /**
   * Melhor APY ENTRE os que comprovadamente comportam a saída de `amountUsd`.
   * `null` quando não há `amountUsd`, quando nada foi medido, ou quando nenhum
   * dos medidos comporta — e nesse último caso `entries` mostra o porquê.
   */
  bestProtocolExecutable: ProtocolId | null;
  unmeasured: ProtocolId[];
  coverage: { measured: number; total: number };
  entries: CapacityEntry[];
  asOf: string;
}

function toEntry(reading: RateReading, amountUsd: number | null): CapacityEntry {
  const liq = reading.liquidity;
  const utilizationBps = liq?.utilizationBps ?? null;
  const availableLiquidityUsd = liq?.availableLiquidityUsd ?? null;
  const totalSuppliedUsd = liq?.totalSuppliedUsd ?? null;

  const usdComparable = amountUsd !== null && amountUsd > 0 && availableLiquidityUsd !== null;

  return {
    protocol: reading.protocol,
    supplyApyBps: reading.supplyApyBps,
    measured: liq !== undefined,
    utilizationBps,
    liquidityTier: liquidityTier(utilizationBps),
    availableLiquidityUsd,
    totalSuppliedUsd,
    exitCoverageRatio: usdComparable ? Math.round((availableLiquidityUsd / amountUsd) * 100) / 100 : null,
    canExitNow: usdComparable ? availableLiquidityUsd >= amountUsd : null,
    positionShareOfSuppliedPct:
      amountUsd !== null && amountUsd > 0 && totalSuppliedUsd !== null && totalSuppliedUsd > 0
        ? Math.round((amountUsd / totalSuppliedUsd) * 1000) / 10
        : null,
  };
}

/**
 * Puro, sem I/O — mesma disciplina de `computeSignal`/`computeDurability`.
 * `amountUsd` é opcional: sem ele a rota ainda entrega utilização e liquidez
 * livre por protocolo, só não emite veredito de saída.
 */
export function computeCapacity(
  asset: AssetId,
  readings: RateReading[],
  amountUsd: number | null,
  now: Date = new Date(),
): CapacityReport {
  const normalizedAmount = amountUsd !== null && Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : null;
  const entries = readings.map((r) => toEntry(r, normalizedAmount)).sort((a, b) => b.supplyApyBps - a.supplyApyBps);

  // `canExitNow === true` é o único filtro aceito aqui: `null` (não medido) não
  // entra nem como aprovado nem como reprovado. Recomendar um mercado cuja
  // liquidez não foi medida seria vender exatamente a falsa confiança que esta
  // rota existe pra desfazer.
  const executable = entries.find((e) => e.canExitNow === true) ?? null;

  return {
    asset,
    basis: "onchain-protocol-books",
    amountUsd: normalizedAmount,
    bestProtocolNow: entries[0]?.protocol ?? null,
    bestProtocolExecutable: executable?.protocol ?? null,
    unmeasured: entries.filter((e) => !e.measured).map((e) => e.protocol),
    coverage: { measured: entries.filter((e) => e.measured).length, total: entries.length },
    entries,
    asOf: now.toISOString(),
  };
}
