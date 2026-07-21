import type { ProtocolId, RateReading } from "../market-data/types.js";
import { RISK_WEIGHTS } from "../strategy/riskWeights.js";
import { computeSignal, type YieldSignal, type SignalRate } from "./computeSignal.js";

/**
 * CAMADA 1 do produto premium: vende a DECISÃO, não o dado.
 *
 * `computeSignal` responde "qual protocolo paga o melhor juro ajustado por
 * risco agora" — um dado que a DefiLlama dá de graça. O que um agente que
 * aloca dinheiro real quer comprar é a resposta de "vale a pena eu MOVER meu
 * dinheiro pra lá, AGORA, considerando meu custo de gas e meu horizonte?".
 * Isso é uma decisão, não um número — e é o que esta camada gera.
 *
 * Reaproveita a mesma matemática de break-even já validada em produção no
 * YieldPilot (strategy/breakeven.ts): o ganho esperado no horizonte tem que
 * superar o custo de mover. Sem histerese aqui — o YieldSignal não guarda
 * posição do comprador entre chamadas; o comprador informa a posição atual
 * dele a cada chamada.
 */

export type MoveAction = "MOVE" | "HOLD";
export type Confidence = "high" | "medium" | "low";

export interface MoveDecisionInput {
  /** Onde o capital do comprador está agora. `null`/ausente = capital ocioso (rende 0). */
  currentProtocol: ProtocolId | null;
  /** Tamanho da posição em USD — escala o ganho absoluto e o break-even. */
  amountUsd: number;
  /** Custo estimado de mover (gas + eventual slippage), em USD. O comprador conhece o próprio custo melhor que nós. */
  moveCostUsd: number;
  /** Por quantos dias o comprador espera manter a posição antes de reavaliar. Ganho só conta até aqui. */
  horizonDays: number;
}

export interface MoveDecision {
  asset: YieldSignal["asset"];
  action: MoveAction;
  /** Protocolo de origem (posição atual do comprador). `null` se capital ocioso. */
  from: ProtocolId | null;
  /** Protocolo de destino recomendado (o melhor ajustado por risco). */
  to: ProtocolId;
  /** Ganho de APY líquido (ajustado por risco) de sair de `from` e entrar em `to`, em bps. Capital ocioso: é o APY inteiro do destino. */
  netApyGainBps: number;
  /** Ganho absoluto esperado no horizonte, DEPOIS de descontar `moveCostUsd`. Positivo => mover compensa. */
  expectedNetGainUsd: number;
  /** Dias até o ganho pagar o custo de mover. `null` se não há ganho positivo (nunca paga). */
  breakEvenDays: number | null;
  confidence: Confidence;
  reason: string;
  /** O sinal bruto que embasa a decisão — o comprador pode auditar os números. */
  signal: YieldSignal;
}

/**
 * Confiança na recomendação, derivada de sinais objetivos (não é um número
 * inventado): (1) quão à frente o melhor está do 2º colocado — um gap grande
 * é uma vantagem clara, um gap de 1-2bps é ruído; (2) a fonte do melhor —
 * leitura on-chain direta (Camada 1) é mais confiável que agregador
 * (DefiLlama, Camada 2). O peso de risco do protocolo já entrou no
 * weightedApy, então não é recontado aqui.
 */
export function confidenceFor(rates: SignalRate[]): Confidence {
  const [best, second] = rates;
  if (!best) return "low";
  const gapToSecond = second ? best.weightedApyBps - second.weightedApyBps : best.weightedApyBps;
  const directSource = best.source === "onchain" || best.source === "api";

  if (gapToSecond >= 50 && directSource) return "high";
  if (gapToSecond >= 20) return "medium";
  return "low";
}

/**
 * Núcleo determinístico — sem I/O, testável com fixtures. Recebe as leituras
 * já coletadas (mesmo padrão de computeSignal) mais o contexto do comprador,
 * e devolve MOVE ou HOLD com a conta explícita por trás.
 */
export function decideMove(readings: RateReading[], input: MoveDecisionInput): MoveDecision {
  const signal = computeSignal(readings);
  const best = signal.rates[0];

  // Dois casos distintos de "sem taxa de referência":
  //  - currentProtocol === null: comprador está OCIOSO (não tem posição) —
  //    a referência é 0 e faz sentido recomendar deployar o capital.
  //  - currentProtocol setado mas NÃO lido nesta chamada (fonte falhou agora):
  //    não dá pra comparar honestamente. Tratar como 0 inflaria o ganho e
  //    empurraria um MOVE às cegas — o certo é HOLD com aviso (ver branch
  //    "positionUnreadable" abaixo). Bug corrigido em auto-revisão 2026-07-21.
  const positionUnreadable =
    input.currentProtocol !== null &&
    signal.rates.find((r) => r.protocol === input.currentProtocol) === undefined;

  const currentRate = input.currentProtocol === null
    ? 0
    : signal.rates.find((r) => r.protocol === input.currentProtocol)?.weightedApyBps ?? 0;

  // netApyGain: quanto o destino rende a mais que a origem, já ajustado por
  // risco. (No caso ilegível o valor é irrelevante — o branch abaixo força HOLD.)
  const netApyGainBps = best.weightedApyBps - currentRate;

  const annualGainUsd = (input.amountUsd * netApyGainBps) / 10_000;
  const gainInHorizonUsd = annualGainUsd * (input.horizonDays / 365);
  const expectedNetGainUsd = gainInHorizonUsd - input.moveCostUsd;

  // break-even em dias: custo / ganho-diário. Só definido se há ganho positivo.
  const dailyGainUsd = annualGainUsd / 365;
  const breakEvenDays = dailyGainUsd > 0 ? input.moveCostUsd / dailyGainUsd : null;

  const confidence = positionUnreadable ? "low" : confidenceFor(signal.rates);
  const alreadyThere = input.currentProtocol !== null && input.currentProtocol === best.protocol;

  let action: MoveAction;
  let reason: string;

  // `reason` é vendido ao robô-comprador (superfície internacional) — em
  // inglês pra bater com o resto do produto (descrições de rota, sinal,
  // README, plugins). Comentários seguem em pt pro dono/mantenedor.
  if (positionUnreadable) {
    action = "HOLD";
    reason = `Could not read your current position (${input.currentProtocol}) on this call — without a reliable comparison it is not safe to recommend moving. HOLD (retry shortly).`;
  } else if (alreadyThere) {
    action = "HOLD";
    reason = `Already in the best risk-adjusted protocol (${best.protocol}). Nothing to move.`;
  } else if (netApyGainBps <= 0) {
    action = "HOLD";
    reason = `Your current position already yields the same or more than the best alternative on a risk-adjusted basis (gain of ${netApyGainBps}bps). Moving would only cost gas. HOLD.`;
  } else if (expectedNetGainUsd <= 0) {
    action = "HOLD";
    const beStr = breakEvenDays !== null ? ` (break-even in ~${breakEvenDays.toFixed(0)} days, past your ${input.horizonDays}-day horizon)` : "";
    reason = `The ${netApyGainBps}bps gain does not cover the move cost ($${input.moveCostUsd.toFixed(4)}) over your ${input.horizonDays}-day horizon${beStr}. HOLD.`;
  } else {
    action = "MOVE";
    reason = `Moving ${input.currentProtocol ?? "idle capital"} → ${best.protocol} yields +${netApyGainBps}bps risk-adjusted; estimated net gain of $${expectedNetGainUsd.toFixed(4)} over ${input.horizonDays} days after the move cost${breakEvenDays !== null ? ` (break-even in ~${breakEvenDays.toFixed(1)} days)` : ""}.`;
  }

  return {
    asset: signal.asset,
    action,
    from: input.currentProtocol,
    to: best.protocol,
    netApyGainBps,
    expectedNetGainUsd,
    breakEvenDays,
    confidence,
    reason,
    signal,
  };
}

// Reexporta pra quem consome só o tipo do peso sem importar riskWeights direto.
export { RISK_WEIGHTS };
