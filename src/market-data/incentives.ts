import { logger } from "../notify/logger.js";
import { fetchDefiLlamaPools, matchDefiLlamaPool, splitPoolApy } from "./defillamaClient.js";
import type { LendingAssetId } from "./types.js";

/**
 * Componente de INCENTIVO (reward token) dos protocolos lidos on-chain.
 *
 * Aave (`liquidityRate`) e Compound (`getSupplyRate`) devolvem só o juro base:
 * o token de incentivo é distribuído por um contrato separado
 * (RewardsController / baseTrackingSupplySpeed do Comet) e converter emissão em
 * APY exige preço em USD do token de reward, preço do subjacente e supply total
 * — três oráculos a mais, cada um um modo de falha novo dentro de uma chamada
 * que o comprador já pagou. Como o serviço já consome a DefiLlama pra Camada 2,
 * o componente de incentivo vem de lá, aditivo e best-effort: falhar aqui NUNCA
 * derruba a leitura on-chain, só marca o incentivo como desconhecido.
 *
 * Sem isto o ranking comparava definições diferentes — ver APY_BASIS em types.ts.
 */

/**
 * Mesma disciplina de defillamaPools.ts: UUID do pool específico MAIS
 * project/chain/symbol conferidos. Verificado ao vivo em 2026-07-30 contra
 * yields.llama.fi/pools (chain=Base, maior TVL do projeto pro símbolo):
 * aave-v3 USDC $21M / WETH $39M; compound-v3 USDC e WETH (as duas entradas de
 * maior TVL do projeto que trazem `apyReward` numérico — a outra entrada WETH,
 * `d83fac…`, vem com `apy: 0` e `apyBase: null`, dado quebrado que não serve
 * nem de referência de incentivo).
 */
const INCENTIVE_POOLS: Record<"aave" | "compound", Record<LendingAssetId, { poolId: string; project: string; symbol: string }>> = {
  aave: {
    USDC: { poolId: "7e0661bf-8cf3-45e6-9424-31916d4c7b84", project: "aave-v3", symbol: "USDC" },
    WETH: { poolId: "23405eee-97e7-4b8e-8625-19c3a36047e8", project: "aave-v3", symbol: "WETH" },
  },
  compound: {
    USDC: { poolId: "0c8567f8-ba5b-41ad-80de-00a71895eb19", project: "compound-v3", symbol: "USDC" },
    WETH: { poolId: "7993b97d-12c3-4a36-b6b6-5b37bac4f8ae", project: "compound-v3", symbol: "WETH" },
  },
};

/**
 * Acima de quantos bps uma diferença entre o agregado da DefiLlama e o juro base
 * lido on-chain deixa de ser ruído e passa a ser tratada como incentivo.
 *
 * As duas leituras são de instantes e metodologias diferentes (a DefiLlama
 * amostra periodicamente; a nossa é do bloco atual), então elas nunca batem na
 * casa do bps. 25 bps é o mesmo limiar já usado como "praticamente empatado" em
 * accuracyScore.ts/autoAttest.ts — abaixo disso, atribuir a diferença a
 * incentivo seria inventar rendimento.
 */
export const INCENTIVE_INFERENCE_MIN_BPS = 25;

/**
 * Teto da inferência: um excedente acima de `múltiplo × juro base` deixa de ser
 * tratado como incentivo.
 *
 * Guarda contra o modo de falha que esta inferência criou e um teste pegou na
 * hora: com `liquidityRate` degenerado (RPC devolvendo zero, mercado
 * momentaneamente ilegível), TODO o agregado da DefiLlama virava "incentivo" —
 * o serviço inventaria 3,5% de rendimento do nada. Divergência grande entre
 * duas fontes quase sempre é amostragem/metodologia diferente, não campanha; na
 * dúvida a resposta marca o incentivo como desconhecido em vez de inflar a APY.
 * Mesma direção conservadora do bug já corrigido em decideMove (posição
 * ilegível vira HOLD, não MOVE às cegas).
 */
export const INCENTIVE_INFERENCE_MAX_MULTIPLE = 2;

/**
 * Prazo da consulta de incentivo. É uma chamada a terceiro dentro do caminho de
 * uma resposta JÁ PAGA — sem prazo, um agregador lento vira lentidão do
 * produto. Estourar o prazo degrada pra "incentivo desconhecido", nunca falha.
 */
export const INCENTIVE_LOOKUP_TIMEOUT_MS = 3_000;

export interface IncentiveComponent {
  rewardBps: number | null;
  basis: "reported" | "inferred" | "unavailable";
  /**
   * Profundidade do mercado em USD, do mesmo pool de referência. Vem junto
   * porque a consulta já foi feita — Aave e Compound expõem o saldo on-chain em
   * unidades do token, e convertê-lo pra USD exigiria um oráculo de preço a
   * mais dentro do caminho de uma resposta paga. Ver RateReading.tvlUsd.
   */
  tvlUsd: number | null;
}

const UNAVAILABLE: IncentiveComponent = { rewardBps: null, basis: "unavailable", tvlUsd: null };

/**
 * Componente de incentivo pra um protocolo lido on-chain, em bps.
 *
 * Ordem de preferência:
 * 1. `apyReward` informado pela fonte (inclusive `0`, que é informação real:
 *    "sabidamente sem campanha agora" ≠ "não sei").
 * 2. Se a fonte não separa mas o agregado dela ficou materialmente ACIMA do
 *    juro base on-chain, a diferença é atribuída a incentivo — cobre o caso
 *    perigoso de uma campanha ativa que só aparece no agregado e que, ignorada,
 *    faria o protocolo ser ranqueado abaixo do que realmente paga.
 * 3. Caso contrário, desconhecido — e a resposta diz isso.
 */
export async function readIncentiveComponent(
  protocol: "aave" | "compound",
  asset: LendingAssetId,
  onchainBaseBps: number,
): Promise<IncentiveComponent> {
  try {
    const { poolId, project, symbol } = INCENTIVE_POOLS[protocol][asset];
    const pools = await withTimeout(fetchDefiLlamaPools(), INCENTIVE_LOOKUP_TIMEOUT_MS, { protocol, asset });
    if (pools === null) return UNAVAILABLE;
    const match = matchDefiLlamaPool(pools, { poolId, project, chain: "base", symbol });
    if (!match) {
      logger.warn({ protocol, asset, poolId, project }, "pool de referência de incentivo não encontrado na DefiLlama — incentivo desconhecido nesta leitura");
      return UNAVAILABLE;
    }
    // Profundidade sai desta mesma consulta, independente do incentivo dar certo.
    const tvlUsd = Number.isFinite(match.tvlUsd) ? match.tvlUsd : null;
    const split = splitPoolApy(match);
    if (split === null) return { ...UNAVAILABLE, tvlUsd };
    if (split.rewardBps !== null) return { rewardBps: split.rewardBps, basis: "reported", tvlUsd };

    // Base degenerada (zero/negativa) não sustenta inferência nenhuma: a
    // divergência inteira contra o agregado seria atribuída a incentivo.
    if (onchainBaseBps <= 0) return { ...UNAVAILABLE, tvlUsd };

    const surplusBps = split.totalBps - onchainBaseBps;
    // Agregado legível e NÃO acima do juro base é informação, não ignorância: o
    // agregado da DefiLlama inclui incentivo por definição, então se ele não
    // supera o nosso juro base, não existe campanha material rolando. Concluir
    // "desconhecido" aqui seria pessimismo permanente — a Aave na Base fica
    // exatamente neste caso (agregado 3,50% vs base on-chain 3,56%), e marcá-la
    // como incerta pra sempre rebaixaria a confiança de toda decisão em que ela
    // não é a líder.
    if (surplusBps < INCENTIVE_INFERENCE_MIN_BPS) return { rewardBps: 0, basis: "inferred", tvlUsd };
    if (surplusBps > onchainBaseBps * INCENTIVE_INFERENCE_MAX_MULTIPLE) {
      logger.warn(
        { protocol, asset, onchainBaseBps, aggregateBps: split.totalBps, surplusBps },
        "divergência grande demais entre agregado e juro base — provável diferença de metodologia, NÃO atribuindo a incentivo",
      );
      return { ...UNAVAILABLE, tvlUsd };
    }
    logger.info({ protocol, asset, onchainBaseBps, aggregateBps: split.totalBps, surplusBps }, "agregado da DefiLlama acima do juro base on-chain — diferença atribuída a incentivo");
    return { rewardBps: surplusBps, basis: "inferred", tvlUsd };
  } catch (err) {
    // Best-effort por design: incentivo desconhecido é degradação aceitável,
    // derrubar a leitura on-chain por causa de um agregador de terceiro não é.
    logger.warn({ protocol, asset, err }, "falha lendo componente de incentivo — seguindo com juro base e marcando incentivo como desconhecido");
    return UNAVAILABLE;
  }
}

/** Resolve com `null` no estouro do prazo em vez de pendurar a resposta paga. */
async function withTimeout<T>(promise: Promise<T>, ms: number, context: Record<string, unknown>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          logger.warn({ ...context, timeoutMs: ms }, "consulta de incentivo estourou o prazo — seguindo sem o componente");
          resolve(null);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
