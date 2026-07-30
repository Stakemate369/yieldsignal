import { logger } from "../notify/logger.js";

const YIELDS_API = "https://yields.llama.fi/pools";

export interface DefiLlamaPool {
  pool: string;
  project: string;
  chain: string;
  symbol: string;
  apy: number | null;
  /** Componente de juro base (%). Pode vir `null` mesmo com `apy` preenchido — ver readingFromPool. */
  apyBase?: number | null;
  /** Componente de incentivo (%). `null` = a DefiLlama não separa pra este pool; `0` = sabidamente sem incentivo. */
  apyReward?: number | null;
  tvlUsd: number;
}

/**
 * Piso pra descartar pool claramente morto/abandonado — onde a APY reportada é
 * ruído de arredondamento sobre um saldo residual, não taxa de mercado.
 *
 * NÃO é política de profundidade: um pool de US$ 700 mil é raso pra um agente
 * com capital sério, mas é um mercado real e omiti-lo esconderia uma opção
 * legítima. Profundidade é decisão de quem aloca, então ela vai EXPOSTA em
 * `tvlUsd` por leitura (ver RateReading) em vez de virar filtro silencioso
 * aqui. Subiu de US$ 1.000 pra US$ 25.000 porque o valor antigo não descartava
 * nada na prática.
 */
export const MIN_POOL_TVL_USD = 25_000;

let cache: { pools: DefiLlamaPool[]; fetchedAt: number } | null = null;
let inFlight: Promise<DefiLlamaPool[]> | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Compartilhado entre defillamaPools.ts (lending na Base) e ethStaking.ts
 * (staking na Ethereum mainnet) — os dois batem no MESMO endpoint
 * (yields.llama.fi/pools devolve todo mundo, todas as chains, sem filtro), e
 * um único cache/inFlight evita: (1) duas cópias em memória do mesmo payload
 * grande sobrevivendo em paralelo numa instância serverless quente, (2) uma
 * chamada real de lending e uma de staking dentro da mesma janela de 5min
 * baterem na API 2x por não saberem uma da outra (cada módulo tinha seu
 * próprio cache antes desta extração). Dedup de chamada em voo continua
 * necessário pelo mesmo motivo original: várias leituras em paralelo
 * (Promise.all em collectRates.ts/ethStaking.ts) chegam antes da primeira
 * resposta preencher o cache.
 */
export async function fetchDefiLlamaPools(): Promise<DefiLlamaPool[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.pools;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(YIELDS_API);
      if (!res.ok) {
        throw new Error(`DefiLlama yields API respondeu ${res.status} — não é seguro responder sem taxa confiável`);
      }
      const json = (await res.json()) as { data: DefiLlamaPool[] };
      cache = { pools: json.data, fetchedAt: Date.now() };
      return json.data;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * UUID do pool específico (não só nome do projeto), MAIS project/chain/symbol
 * esperados como segunda checagem — o UUID sozinho não prova que a DefiLlama
 * não reatribuiu/migrou aquele id pra outro mercado depois da checagem manual;
 * as três condições juntas têm que bater. Chain comparada case-insensitive
 * (mesmo padrão nas duas chamadas — `.toLowerCase()` dos dois lados evita a
 * divergência que existia entre defillamaPools.ts, que já normalizava, e
 * ethStaking.ts, que comparava case-sensitive só porque foi copiado sem essa
 * parte, achado real em revisão).
 */
export function matchDefiLlamaPool(
  pools: DefiLlamaPool[],
  criteria: { poolId: string; project: string; chain: string; symbol: string },
): DefiLlamaPool | undefined {
  return pools.find(
    (p) =>
      p.pool === criteria.poolId &&
      p.project === criteria.project &&
      p.chain.toLowerCase() === criteria.chain.toLowerCase() &&
      p.symbol === criteria.symbol,
  );
}

/** Converte um campo de porcentagem da DefiLlama em bps, ou `null` se não for número utilizável. */
function pctToBps(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null;
}

/**
 * Decompõe a APY de um pool nos componentes que o serviço compara.
 *
 * Prefere `apyBase + apyReward` ao campo agregado `apy` porque os três nem
 * sempre são coerentes na fonte: visto ao vivo em 2026-07-30, o pool WETH da
 * compound-v3 na Base vinha com `apy: 0` e `apyBase: null` (agregado zerado,
 * componente ausente), e vários pools trazem `apyReward` preenchido com `apy`
 * já somado. Só cai no agregado quando NENHUM componente veio.
 */
export function splitPoolApy(pool: DefiLlamaPool): { totalBps: number; baseBps: number | null; rewardBps: number | null } | null {
  const baseBps = pctToBps(pool.apyBase);
  const rewardBps = pctToBps(pool.apyReward);
  if (baseBps === null && rewardBps === null) {
    const aggregate = pctToBps(pool.apy);
    return aggregate === null ? null : { totalBps: aggregate, baseBps: null, rewardBps: null };
  }
  return { totalBps: (baseBps ?? 0) + (rewardBps ?? 0), baseBps, rewardBps };
}

/**
 * Valida um pool já casado (APY decomponível e não-nula, TVL acima do piso) e
 * monta o RateReading — mesma sequência de checagem que defillamaPools.ts e
 * ethStaking.ts precisam fazer, extraída pra não duplicar warn+null em
 * cada uma. `logContext` só entra no log, não afeta a validação.
 *
 * APY total <= 0 é tratada como leitura INDISPONÍVEL, não como "0% de verdade":
 * achado real em 2026-07-30 — o pool da Euler que o serviço lê pra USDC
 * ("Clearstar Earn USDC", TVL $463k, acima do piso) reportava `apy: 0` havia
 * tempo, e o guarda antigo (só `null`/NaN) deixava passar. Resultado: toda
 * resposta de USDC anunciava `coverage: 6/6` carregando um protocolo mudo como
 * se fosse leitura boa. Um mercado de lending vivo não paga 0,00% — quando paga,
 * é dado quebrado ou pool morto, e omitir (aparecendo em `omittedProtocols`) é
 * mais honesto que ranquear um zero.
 */
export function readingFromPool<T extends { protocol: string; asset: string }>(
  match: DefiLlamaPool | undefined,
  build: (match: DefiLlamaPool) => T,
  logContext: Record<string, unknown>,
): (T & { supplyApyBps: number; apyBaseBps: number | null; apyRewardBps: number | null; rewardBasis: "reported" | "included-not-itemized"; tvlUsd: number | null; source: "defillama"; readAt: Date }) | null {
  if (!match) {
    logger.warn(logContext, "pool não encontrado (ou não bate mais poolId/project/chain/symbol) na resposta atual da DefiLlama — omitindo desta vez");
    return null;
  }
  const split = splitPoolApy(match);
  if (split === null) {
    logger.warn({ ...logContext, apy: match.apy }, "DefiLlama retornou apy nulo/inválido — omitindo em vez de reportar 0%");
    return null;
  }
  if (split.totalBps <= 0) {
    logger.warn(
      { ...logContext, apy: match.apy, apyBase: match.apyBase, apyReward: match.apyReward, tvlUsd: match.tvlUsd },
      "DefiLlama reportou APY total <= 0 — tratando como pool mudo/morto e omitindo (entra em omittedProtocols)",
    );
    return null;
  }
  if (match.tvlUsd < MIN_POOL_TVL_USD) {
    logger.warn({ ...logContext, tvlUsd: match.tvlUsd }, "TVL abaixo do piso mínimo — pool possivelmente morto, omitindo");
    return null;
  }
  return {
    ...build(match),
    supplyApyBps: split.totalBps,
    apyBaseBps: split.baseBps,
    apyRewardBps: split.rewardBps,
    // A DefiLlama entrega o agregado já com incentivo; quando só o agregado
    // existe (componentes null) ele continua sendo base+reward por definição
    // da fonte, então o total é comparável — só não dá pra itemizar.
    rewardBasis: split.rewardBps === null ? ("included-not-itemized" as const) : ("reported" as const),
    tvlUsd: Number.isFinite(match.tvlUsd) ? match.tvlUsd : null,
    source: "defillama",
    readAt: new Date(),
  };
}
