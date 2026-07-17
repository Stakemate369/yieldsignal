import type { ProtocolId, RateReading } from "../market-data/types.js";
import { weightedApyBps } from "../strategy/riskWeights.js";

export interface SignalRate {
  protocol: ProtocolId;
  apyBps: number;
  weightedApyBps: number;
  source: RateReading["source"];
  asOf: string;
}

export interface YieldSignal {
  bestProtocol: ProtocolId;
  /** Diferença em bps entre o 1º e o 2º colocado (ponderado por risco) — quanto maior, mais clara a vantagem. */
  gapBps: number;
  rates: SignalRate[];
  asOf: string;
}

/**
 * Núcleo determinístico do produto vendido — sem I/O, testável com fixtures.
 * Mesmo espírito do strategy/decision.ts do YieldPilot, mas sem histerese:
 * aqui não existe posição pra manter, cada chamada só reporta o estado atual
 * do mercado. Aceita uma lista parcial de leituras (alguma fonte pode ter
 * falhado nesta chamada) — só falha se não sobrar nenhuma leitura.
 */
export function computeSignal(readings: RateReading[]): YieldSignal {
  if (readings.length === 0) {
    throw new Error("nenhuma leitura de taxa disponível — não é seguro gerar sinal sem dado");
  }

  const rates: SignalRate[] = readings
    .map((r) => ({
      protocol: r.protocol,
      apyBps: r.supplyApyBps,
      weightedApyBps: weightedApyBps(r.protocol, r.supplyApyBps),
      source: r.source,
      asOf: r.readAt.toISOString(),
    }))
    .sort((a, b) => b.weightedApyBps - a.weightedApyBps);

  const [best, second] = rates;
  const gapBps = second ? best.weightedApyBps - second.weightedApyBps : 0;

  return {
    bestProtocol: best.protocol,
    gapBps,
    rates,
    asOf: new Date().toISOString(),
  };
}
