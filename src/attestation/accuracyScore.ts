import type { AssetId } from "../market-data/types.js";
import type { TrackRecordEntry } from "./trackRecord.js";

/**
 * CAMADA 2: transforma o histórico de atestações (o que dissemos, ancorado
 * on-chain no EAS) num SCORE DE ACURÁCIA legível por máquina — "quando eu
 * disse que X era o melhor, X continuou sendo o melhor?".
 *
 * Isto é o que nenhum feed gratuito tem: um robô decide em quem CONFIAR pelo
 * hit-rate comprovado, não pela promessa. O score é derivado 1:1 dos mesmos
 * `TrackRecordEntry` públicos (fonte = EAS, verificável de forma independente
 * por qualquer um consultando as UIDs), então não é auto-declarado.
 *
 * HONESTIDADE deliberada (mesma ressalva de trackRecord.ts): `stillBest`
 * compara a atestação passada contra o mercado ATUAL, não contra a APY
 * daquele bloco exato (isso exigiria indexação histórica própria). É acurácia
 * DIRECIONAL ("a chamada continua de pé?"), não um backtest de preço exato —
 * e o score diz isso explicitamente no campo `basis`.
 */

/**
 * Tolerância (bps) para a métrica JUSTA de acurácia: um sinal que apontou um
 * protocolo hoje até este tanto atrás do líder atual ainda conta como acerto.
 * 25 bps espelha o GAP_CHANGE_THRESHOLD_BPS do auto-attest — abaixo disso o
 * mercado é considerado praticamente empatado.
 */
export const ACCURACY_TOLERANCE_BPS = 25;

export interface AccuracyBreakdown {
  asset: AssetId;
  scored: number;
  stillBest: number;
  hitRate: number | null;
  /** Entradas com regret apurável neste asset (denominador de withinTolerance/avgRegret). */
  regretScored: number;
  /** Quantas ficaram dentro da tolerância (regret <= ACCURACY_TOLERANCE_BPS). */
  withinTolerance: number;
  /** withinTolerance / regretScored. null se nada apurável. */
  withinToleranceRate: number | null;
  /** Regret médio (bps) neste asset. null se nada apurável. */
  avgRegretBps: number | null;
}

export interface AccuracyScore {
  /** Como a acurácia é medida — string fixa, pra o consumidor máquina não confundir com backtest exato. */
  basis: "directional-vs-current-market";
  /** Total de atestações com veredito disponível (mercado legível agora). */
  scored: number;
  /** Quantas continuam sendo o melhor protocolo hoje. */
  stillBest: number;
  /** Atestações cujo veredito não deu pra apurar agora (mercado ilegível nesta consulta) — excluídas do hitRate. */
  indeterminate: number;
  /** stillBest / scored. `null` se nada foi apurável (sem base pra afirmar acurácia). */
  hitRate: number | null;
  /** Tolerância (bps) usada pela métrica justa — exposta pra o consumidor máquina saber o critério. */
  toleranceBps: number;
  /** Atestações com regret apurável (líder atual E protocolo atestado legíveis agora) — denominador de withinTolerance/avgRegret. */
  regretScored: number;
  /** Quantas ficaram DENTRO da tolerância (regret <= toleranceBps) — a métrica JUSTA, mais informativa que o stillBest binário. */
  withinTolerance: number;
  /** withinTolerance / regretScored. null se nada apurável. A taxa que responde "com que frequência o sinal aponta o líder OU quase". */
  withinToleranceRate: number | null;
  /** Regret médio (bps) atrás do líder atual — quão custoso, na média, foi seguir o sinal em vez do #1 de hoje. null se nada apurável. */
  avgRegretBps: number | null;
  /** Gap médio (bps) no momento da atestação — calibra a confiança: gaps maiores => chamadas mais fáceis de acertar. */
  avgGapBpsAtAttestation: number | null;
  perAsset: AccuracyBreakdown[];
  /** Momento em que este score foi calculado. */
  computedAt: string;
}

/** Média inteira de uma lista (bps), ou null se vazia. */
function avgBps(values: number[]): number | null {
  return values.length > 0 ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

/**
 * Núcleo puro — sem I/O, testável com fixtures. Recebe as entradas do track
 * record (já montadas por buildTrackRecord) e agrega. `stillBest === null`
 * (mercado ilegível agora) é contado como INDETERMINADO e sai do denominador
 * — nunca como acerto nem como erro, pra não inflar nem punir o score por uma
 * falha de leitura transitória.
 */
export function computeAccuracyScore(entries: TrackRecordEntry[]): AccuracyScore {
  const determinate = entries.filter((e) => e.stillBest !== null);
  const indeterminate = entries.length - determinate.length;
  const scored = determinate.length;
  const stillBest = determinate.filter((e) => e.stillBest === true).length;
  const hitRate = scored > 0 ? stillBest / scored : null;

  // Métrica JUSTA: regret é apurável de forma independente do stillBest (pode
  // haver regret sem stillBest e vice-versa se só o protocolo atestado ficou
  // ilegível). Denominador próprio = entradas com regretBps não-nulo.
  const regretEntries = entries.filter((e) => e.regretBps !== null);
  const regretScored = regretEntries.length;
  const withinTolerance = regretEntries.filter((e) => (e.regretBps as number) <= ACCURACY_TOLERANCE_BPS).length;
  const withinToleranceRate = regretScored > 0 ? withinTolerance / regretScored : null;
  const avgRegretBps = avgBps(regretEntries.map((e) => e.regretBps as number));

  const avgGapBpsAtAttestation = avgBps(entries.map((e) => e.gapBpsAtAttestation).filter((g) => Number.isFinite(g)));

  // Agrupa por asset preservando ordem de primeira aparição. Acumula tanto o
  // stillBest (denominador determinate) quanto o regret (denominador próprio).
  interface AssetAcc {
    scored: number;
    stillBest: number;
    regretScored: number;
    withinTolerance: number;
    regretSum: number;
  }
  const byAsset = new Map<AssetId, AssetAcc>();
  const accFor = (asset: AssetId): AssetAcc => {
    const acc = byAsset.get(asset) ?? { scored: 0, stillBest: 0, regretScored: 0, withinTolerance: 0, regretSum: 0 };
    byAsset.set(asset, acc);
    return acc;
  };
  for (const e of determinate) {
    const acc = accFor(e.asset);
    acc.scored += 1;
    if (e.stillBest === true) acc.stillBest += 1;
  }
  for (const e of regretEntries) {
    const acc = accFor(e.asset);
    acc.regretScored += 1;
    acc.regretSum += e.regretBps as number;
    if ((e.regretBps as number) <= ACCURACY_TOLERANCE_BPS) acc.withinTolerance += 1;
  }
  // Garante que assets sem nenhuma entrada apurável também apareçam (tudo 0/null).
  for (const e of entries) accFor(e.asset);

  const perAsset: AccuracyBreakdown[] = Array.from(byAsset.entries()).map(([asset, v]) => ({
    asset,
    scored: v.scored,
    stillBest: v.stillBest,
    hitRate: v.scored > 0 ? v.stillBest / v.scored : null,
    regretScored: v.regretScored,
    withinTolerance: v.withinTolerance,
    withinToleranceRate: v.regretScored > 0 ? v.withinTolerance / v.regretScored : null,
    avgRegretBps: v.regretScored > 0 ? Math.round(v.regretSum / v.regretScored) : null,
  }));

  return {
    basis: "directional-vs-current-market",
    scored,
    stillBest,
    indeterminate,
    hitRate,
    toleranceBps: ACCURACY_TOLERANCE_BPS,
    regretScored,
    withinTolerance,
    withinToleranceRate,
    avgRegretBps,
    avgGapBpsAtAttestation,
    perAsset,
    computedAt: new Date().toISOString(),
  };
}
