import { APY_BASIS, type AssetId, type ProtocolId, type RateReading } from "../market-data/types.js";

/**
 * TESTE DE ESTRESSE DE INCENTIVO — "quanto desta APY sobra se o incentivo parar?"
 *
 * NÃO é previsão de data. Foi assim de propósito, e a decisão custou pesquisa:
 * a fonte óbvia pra "quando a campanha acaba" seria a API da Merkl
 * (`earliestCampaignEnd` por oportunidade). Checado ao vivo em 2026-08-05 contra
 * `api.merkl.xyz/v4/opportunities?chainId=8453&status=LIVE` (top 100 por TVL):
 *
 * - Aave, Compound, Euler e Fluid: ZERO campanhas com `action=LEND`. Os
 *   protocolos onde o incentivo mais pesa simplesmente não estão lá.
 * - Morpho e Moonwell: só aparecem como vaults MetaMorpho curados, que NÃO são
 *   os mesmos mercados que `market-data/morpho.ts` e `defillamaPools.ts` leem —
 *   casar os dois exigiria adivinhar qual dos 12 vaults corresponde ao pool.
 * - `status=PAST` devolve `earliestCampaignStart`/`latestCampaignEnd` nulos,
 *   então nem histórico de renovação dá pra medir.
 *
 * Cobrir 2 de 6 protocolos com casamento adivinhado produziria exatamente o que
 * este serviço não vende: número que parece preciso e não é. Pior, a maioria das
 * campanhas na Merkl é SEMANAL e renova — publicar "acaba em 0,8 dia" viraria
 * alarme falso recorrente. Sem data, então, até existir fonte que cubra os seis.
 *
 * O que sobra é integralmente medido, sem estimativa nenhuma: cada `RateReading`
 * já traz `apyBaseBps` e `apyRewardBps` separados, e `rewardBasis` dizendo com
 * que força a separação pode ser afirmada. O piso pós-incentivo é o próprio
 * `apyBaseBps` — não um modelo, o número que já foi lido.
 */

/** Só estas duas bases sustentam decompor a APY. Ver `rewardBasis` em types.ts. */
const DECOMPOSABLE_BASES: ReadonlySet<RateReading["rewardBasis"]> = new Set(["reported", "inferred"]);

export interface DurabilityEntry {
  protocol: ProtocolId;
  /** APY total hoje (base + incentivo), o mesmo número que o ranking do sinal usa. */
  supplyApyBps: number;
  apyBaseBps: number | null;
  apyRewardBps: number | null;
  rewardBasis: RateReading["rewardBasis"];
  /**
   * Fatia da APY que vem de incentivo, em pontos percentuais (0-100).
   * `null` quando a fonte não separa os componentes — nunca 0 nesse caso, porque
   * "não sei" e "sabidamente sem incentivo" são afirmações diferentes.
   */
  incentiveSharePct: number | null;
  /** O que sobra se TODO incentivo for a zero. `null` quando não decomponível. */
  postIncentiveApyBps: number | null;
  /** `true` só quando `postIncentiveApyBps` pôde ser afirmado a partir de dado lido. */
  decomposable: boolean;
}

export interface DurabilityReport {
  asset: AssetId;
  apyBasis: typeof APY_BASIS;
  /** Declara o que este número É — mesma disciplina do `basis` do /accuracy.json. */
  basis: "incentive-stress-test";
  bestProtocolNow: ProtocolId | null;
  /**
   * Quem lidera se todo incentivo parar. Calculado SÓ entre os decomponíveis.
   * `null` quando não há decomponível suficiente pra afirmar.
   */
  bestProtocolPostIncentive: ProtocolId | null;
  /**
   * `true`/`false` só quando a comparação é legítima; `null` quando não dá pra
   * afirmar (ver `comparability`). Um `false` aqui significa "medi e o líder não
   * muda", jamais "não consegui medir".
   */
  rankingChangesWithoutIncentives: boolean | null;
  comparability: {
    comparable: boolean;
    /** Por que a comparação vale (ou não) — legível por máquina e por humano. */
    reason: string;
  };
  /**
   * Melhor piso que se consegue PROVAR, e de quem. Existe porque a resposta
   * honesta quando o líder é opaco ("não dá pra afirmar se o ranking muda")
   * deixaria o comprador de mãos vazias — e ainda assim há uma afirmação forte e
   * inteiramente medida disponível: "o maior rendimento que eu consigo provar
   * que NÃO depende de incentivo é este". Calculado só entre os decomponíveis,
   * `null` quando não há nenhum.
   */
  bestVerifiableFloor: { protocol: ProtocolId; apyBps: number } | null;
  /** Protocolos cuja APY não pôde ser decomposta, com o motivo por protocolo. */
  undecomposable: { protocol: ProtocolId; rewardBasis: RateReading["rewardBasis"] }[];
  coverage: { decomposable: number; total: number };
  entries: DurabilityEntry[];
  asOf: string;
}

function toEntry(reading: RateReading): DurabilityEntry {
  const decomposable = DECOMPOSABLE_BASES.has(reading.rewardBasis) && reading.apyBaseBps !== null;
  // `apyRewardBps` pode ser null mesmo em base decomponível (fonte separou o
  // base mas não o reward); nesse caso a fatia de incentivo fica indeterminada
  // ainda que o piso — o próprio base — seja afirmável.
  const share =
    decomposable && reading.apyRewardBps !== null && reading.supplyApyBps > 0
      ? Math.round((reading.apyRewardBps / reading.supplyApyBps) * 1000) / 10
      : null;

  return {
    protocol: reading.protocol,
    supplyApyBps: reading.supplyApyBps,
    apyBaseBps: reading.apyBaseBps,
    apyRewardBps: reading.apyRewardBps,
    rewardBasis: reading.rewardBasis,
    incentiveSharePct: share,
    postIncentiveApyBps: decomposable ? reading.apyBaseBps : null,
    decomposable,
  };
}

/**
 * Puro, sem I/O — mesma disciplina de `computeSignal`. Recebe as leituras que o
 * sinal já coletou e devolve o relatório de durabilidade.
 */
export function computeDurability(asset: AssetId, readings: RateReading[], now: Date = new Date()): DurabilityReport {
  const entries = readings.map(toEntry).sort((a, b) => b.supplyApyBps - a.supplyApyBps);
  const decomposables = entries.filter((e) => e.decomposable && e.postIncentiveApyBps !== null);

  const bestNow = entries[0]?.protocol ?? null;
  const topFloor =
    decomposables.length > 0
      ? decomposables.reduce((best, e) => (e.postIncentiveApyBps! > best.postIncentiveApyBps! ? e : best))
      : null;
  const bestPost = topFloor?.protocol ?? null;

  // A comparação só vale se o LÍDER ATUAL for decomponível. Se ele não for, o
  // piso dele é desconhecido e ele poderia continuar liderando depois do corte —
  // dizer "o ranking muda" nesse caso seria inventar. Este é o guarda que
  // impede a rota inteira de virar gerador de alarme falso.
  const leaderDecomposable = entries[0]?.decomposable === true;
  const comparable = leaderDecomposable && decomposables.length >= 2;

  let reason: string;
  if (entries.length === 0) {
    reason = "no readings available";
  } else if (!leaderDecomposable) {
    reason = `current leader (${bestNow}) reports rewardBasis="${entries[0]!.rewardBasis}", so its post-incentive floor cannot be established — no ranking claim is made`;
  } else if (decomposables.length < 2) {
    reason = "fewer than two protocols could be decomposed — nothing to rank against";
  } else {
    reason = `${decomposables.length} of ${entries.length} protocols decomposed from reported/inferred reward components`;
  }

  return {
    asset,
    apyBasis: APY_BASIS,
    basis: "incentive-stress-test",
    bestProtocolNow: bestNow,
    bestProtocolPostIncentive: comparable ? bestPost : null,
    rankingChangesWithoutIncentives: comparable ? bestPost !== bestNow : null,
    comparability: { comparable, reason },
    // Independente de `comparable`: este número não depende de comparar com o
    // líder opaco, só de ter pelo menos um piso medido.
    bestVerifiableFloor: topFloor ? { protocol: topFloor.protocol, apyBps: topFloor.postIncentiveApyBps! } : null,
    undecomposable: entries
      .filter((e) => !e.decomposable)
      .map((e) => ({ protocol: e.protocol, rewardBasis: e.rewardBasis })),
    coverage: { decomposable: decomposables.length, total: entries.length },
    entries,
    asOf: now.toISOString(),
  };
}
