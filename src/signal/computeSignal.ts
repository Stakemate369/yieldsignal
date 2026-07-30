import { APY_BASIS } from "../market-data/types.js";
import type { AssetId, ProtocolId, RateReading } from "../market-data/types.js";
import { weightedApyBps } from "../strategy/riskWeights.js";
import { omittedProtocols } from "./expectedProtocols.js";

export interface SignalRate {
  protocol: ProtocolId;
  /** APY total (juro base + incentivo) — a base única de comparação, ver APY_BASIS. */
  apyBps: number;
  /** Componente de juro base, quando a fonte separa. `null` = não itemizado. */
  apyBaseBps: number | null;
  /** Componente de incentivo. `0` = sabidamente sem campanha; `null` = desconhecido nesta leitura. */
  apyRewardBps: number | null;
  /** Procedência do componente de incentivo — ver RateReading.rewardBasis. */
  rewardBasis: RateReading["rewardBasis"];
  /** Profundidade do mercado em USD. `null` = não apurável nesta leitura. Ver RateReading.tvlUsd. */
  tvlUsd: number | null;
  /** O que `tvlUsd` mede — as fontes NÃO medem a mesma coisa. Ver RateReading.tvlBasis. */
  tvlBasis: RateReading["tvlBasis"];
  weightedApyBps: number;
  source: RateReading["source"];
  asOf: string;
}

export interface YieldSignal {
  asset: AssetId;
  bestProtocol: ProtocolId;
  /** Diferença em bps entre o 1º e o 2º colocado (ponderado por risco) — quanto maior, mais clara a vantagem. */
  gapBps: number;
  rates: SignalRate[];
  /**
   * Protocolos que o serviço TENTA ler pra este asset mas que não entraram
   * nesta resposta (fonte falhou ou devolveu dado inválido). Vazio = cobertura
   * total. Sem isto, o comprador não conseguia distinguir "protocolo X não é
   * competitivo" de "protocolo X não foi lido" — e `bestProtocol` era
   * apresentado como o melhor do mercado quando era só o melhor do que sobrou.
   */
  omittedProtocols: ProtocolId[];
  /** Quantos protocolos entraram / quantos eram esperados — leitura rápida da confiabilidade desta chamada. */
  coverage: { read: number; expected: number };
  /** Base de comparação das APYs desta resposta — fixa, pra o consumidor máquina não precisar adivinhar. */
  apyBasis: typeof APY_BASIS;
  /**
   * Protocolos cujo componente de INCENTIVO não pôde ser apurado nesta chamada:
   * a APY deles é base-only e pode estar subestimada, então a posição no ranking
   * é um piso, não um veredito. Vazio = todo mundo comparado na mesma base.
   */
  incompleteRewardData: ProtocolId[];
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
      apyBaseBps: r.apyBaseBps,
      apyRewardBps: r.apyRewardBps,
      rewardBasis: r.rewardBasis,
      tvlUsd: r.tvlUsd,
      tvlBasis: r.tvlBasis,
      weightedApyBps: weightedApyBps(r.protocol, r.supplyApyBps),
      source: r.source,
      asOf: r.readAt.toISOString(),
    }))
    .sort((a, b) => b.weightedApyBps - a.weightedApyBps);

  const [best, second] = rates;
  const gapBps = second ? best.weightedApyBps - second.weightedApyBps : 0;

  // Todas as leituras de uma chamada vêm de collectRates(asset) pro MESMO
  // asset — seguro pegar do primeiro item em vez de exigir o parâmetro de
  // novo aqui (computeSignal continua puro, sem I/O, só dados que já chegam).
  const asset = readings[0].asset;
  const omitted = omittedProtocols(
    asset,
    rates.map((r) => r.protocol),
  );

  return {
    asset,
    bestProtocol: best.protocol,
    gapBps,
    rates,
    omittedProtocols: omitted,
    coverage: { read: rates.length, expected: rates.length + omitted.length },
    apyBasis: APY_BASIS,
    incompleteRewardData: rates.filter((r) => r.rewardBasis === "unavailable").map((r) => r.protocol),
    asOf: new Date().toISOString(),
  };
}
