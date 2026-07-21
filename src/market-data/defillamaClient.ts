import { logger } from "../notify/logger.js";

const YIELDS_API = "https://yields.llama.fi/pools";

export interface DefiLlamaPool {
  pool: string;
  project: string;
  chain: string;
  symbol: string;
  apy: number | null;
  tvlUsd: number;
}

// Piso conservador só pra descartar pool claramente morto/abandonado (TVL
// residual, onde uma APY reportada costuma ser ruído, não sinal real) — não
// é uma barreira de qualidade rigorosa, só uma rede de segurança barata.
export const MIN_POOL_TVL_USD = 1_000;

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

/**
 * Valida um pool já casado (apy finito, TVL acima do piso) e monta o
 * RateReading — mesma sequência de checagem que defillamaPools.ts e
 * ethStaking.ts precisam fazer, extraída pra não duplicar warn+null em
 * cada uma. `logContext` só entra no log, não afeta a validação.
 */
export function readingFromPool<T extends { protocol: string; asset: string }>(
  match: DefiLlamaPool | undefined,
  build: (match: DefiLlamaPool) => T,
  logContext: Record<string, unknown>,
): (T & { supplyApyBps: number; source: "defillama"; readAt: Date }) | null {
  if (!match) {
    logger.warn(logContext, "pool não encontrado (ou não bate mais poolId/project/chain/symbol) na resposta atual da DefiLlama — omitindo desta vez");
    return null;
  }
  if (typeof match.apy !== "number" || !Number.isFinite(match.apy)) {
    logger.warn({ ...logContext, apy: match.apy }, "DefiLlama retornou apy nulo/inválido — omitindo em vez de reportar 0%");
    return null;
  }
  if (match.tvlUsd < MIN_POOL_TVL_USD) {
    logger.warn({ ...logContext, tvlUsd: match.tvlUsd }, "TVL abaixo do piso mínimo — pool possivelmente morto, omitindo");
    return null;
  }
  return {
    ...build(match),
    supplyApyBps: Math.round(match.apy * 100),
    source: "defillama",
    readAt: new Date(),
  };
}
