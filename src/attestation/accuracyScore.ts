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

export interface AccuracyBreakdown {
  asset: AssetId;
  scored: number;
  stillBest: number;
  hitRate: number | null;
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
  /** Gap médio (bps) no momento da atestação — calibra a confiança: gaps maiores => chamadas mais fáceis de acertar. */
  avgGapBpsAtAttestation: number | null;
  perAsset: AccuracyBreakdown[];
  /** Momento em que este score foi calculado. */
  computedAt: string;
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

  const gaps = entries.map((e) => e.gapBpsAtAttestation).filter((g) => Number.isFinite(g));
  const avgGapBpsAtAttestation = gaps.length > 0 ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;

  // Agrupa por asset preservando ordem de primeira aparição.
  const byAsset = new Map<AssetId, { scored: number; stillBest: number }>();
  for (const e of determinate) {
    const acc = byAsset.get(e.asset) ?? { scored: 0, stillBest: 0 };
    acc.scored += 1;
    if (e.stillBest === true) acc.stillBest += 1;
    byAsset.set(e.asset, acc);
  }
  // Garante que assets só-indeterminados também apareçam (scored 0, hitRate null).
  for (const e of entries) {
    if (!byAsset.has(e.asset)) byAsset.set(e.asset, { scored: 0, stillBest: 0 });
  }

  const perAsset: AccuracyBreakdown[] = Array.from(byAsset.entries()).map(([asset, v]) => ({
    asset,
    scored: v.scored,
    stillBest: v.stillBest,
    hitRate: v.scored > 0 ? v.stillBest / v.scored : null,
  }));

  return {
    basis: "directional-vs-current-market",
    scored,
    stillBest,
    indeterminate,
    hitRate,
    avgGapBpsAtAttestation,
    perAsset,
    computedAt: new Date().toISOString(),
  };
}
