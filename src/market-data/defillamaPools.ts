import { logger } from "../notify/logger.js";
import type { DefiLlamaProtocolId, RateReading } from "./types.js";

const YIELDS_API = "https://yields.llama.fi/pools";

interface DefiLlamaPool {
  pool: string;
  project: string;
  chain: string;
  symbol: string;
  apy: number | null;
  tvlUsd: number;
}

/**
 * UUID do pool específico (não só nome do projeto), MAIS project/chain/symbol
 * esperados como segunda checagem — o UUID sozinho não prova que a DefiLlama
 * não reatribuiu/migrou aquele id pra outro mercado depois da checagem manual;
 * as duas condições juntas têm que bater.
 *
 * Verificado manualmente contra yields.llama.fi/pools em 2026-07-16
 * (chain=Base, symbol=USDC, maior TVL do projeto). Não adicionar protocolo
 * aqui sem repetir essa checagem — ver nota em market-data/types.ts sobre
 * Spark/Seamless/Silo, pesquisados e descartados por não terem mercado
 * USDC na Base indexado no momento.
 */
const POOLS: Record<DefiLlamaProtocolId, { poolId: string; project: string }> = {
  fluid: { poolId: "7372edda-f07f-4598-83e5-4edec48c4039", project: "fluid-lending" },
  moonwell: { poolId: "69cf831d-624a-4f23-b5e3-c0f63ad1fa01", project: "moonwell-lending" },
  euler: { poolId: "7149d3d6-daab-4577-98c4-1ad7703a5bb2", project: "euler-v2" },
};

// Piso conservador só pra descartar pool claramente morto/abandonado (TVL
// residual, onde uma APY reportada costuma ser ruído, não sinal real) — não
// é uma barreira de qualidade rigorosa, só uma rede de segurança barata.
const MIN_TVL_USD = 1_000;

let cache: { pools: DefiLlamaPool[]; fetchedAt: number } | null = null;
let inFlight: Promise<DefiLlamaPool[]> | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Uma única chamada em voo por vez — sem isto, as 3 leituras da Camada 2
 * (fluid/moonwell/euler) disparadas em paralelo por collectRates.ts bateriam
 * na API da DefiLlama 3x a cada chamada paga, mesmo com o cache de 5min,
 * porque todas chegam antes da primeira resposta preencher o cache.
 */
async function fetchPools(): Promise<DefiLlamaPool[]> {
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
 * Lê a APY de um protocolo da Camada 2 (via DefiLlama). Diferente da Camada 1,
 * uma falha aqui não deve derrubar a resposta inteira do sinal — um protocolo
 * a menos na lista é preferível a um erro 500 pro comprador. Por isso quem
 * chama (signal/computeSignal.ts) trata `null` como "omitir da resposta desta vez",
 * não como falha fatal.
 */
export async function readDefiLlamaPoolApy(protocol: DefiLlamaProtocolId): Promise<RateReading | null> {
  try {
    const pools = await fetchPools();
    const { poolId, project } = POOLS[protocol];
    const match = pools.find(
      (p) => p.pool === poolId && p.project === project && p.chain.toLowerCase() === "base" && p.symbol === "USDC",
    );
    if (!match) {
      logger.warn({ protocol, poolId, project }, "pool não encontrado (ou não bate mais project/chain/symbol) na resposta atual da DefiLlama — omitindo desta vez");
      return null;
    }
    if (typeof match.apy !== "number" || !Number.isFinite(match.apy)) {
      logger.warn({ protocol, apy: match.apy }, "DefiLlama retornou apy nulo/inválido — omitindo em vez de reportar 0%");
      return null;
    }
    if (match.tvlUsd < MIN_TVL_USD) {
      logger.warn({ protocol, tvlUsd: match.tvlUsd }, "TVL abaixo do piso mínimo — pool possivelmente morto, omitindo");
      return null;
    }
    return {
      protocol,
      supplyApyBps: Math.round(match.apy * 100),
      source: "defillama",
      readAt: new Date(),
    };
  } catch (err) {
    logger.warn({ protocol, err }, "falha lendo taxa via DefiLlama — omitindo protocolo desta resposta");
    return null;
  }
}
