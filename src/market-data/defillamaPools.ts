import { logger } from "../notify/logger.js";
import type { AssetId, DefiLlamaProtocolId, RateReading } from "./types.js";

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
 * as duas condições juntas têm que bater. `symbol` fica por entrada (não fixo
 * globalmente) porque cada projeto lista o mesmo ativo diferente: WETH aparece
 * como "ETH" na Moonwell/Fluid mas como "WETH" na Euler.
 *
 * USDC verificado manualmente contra yields.llama.fi/pools em 2026-07-16
 * (chain=Base, symbol=USDC, maior TVL do projeto). WETH verificado do mesmo
 * jeito em 2026-07-17 (maior TVL do projeto pra symbol ETH/WETH). Não
 * adicionar protocolo/ativo aqui sem repetir essa checagem — ver nota em
 * market-data/types.ts sobre Spark/Seamless/Silo (sem mercado USDC) e cbBTC
 * (mercado existe mas com APY quase sempre zero, sinal pouco útil).
 */
const POOLS: Record<DefiLlamaProtocolId, Record<AssetId, { poolId: string; project: string; symbol: string }>> = {
  fluid: {
    USDC: { poolId: "7372edda-f07f-4598-83e5-4edec48c4039", project: "fluid-lending", symbol: "USDC" },
    WETH: { poolId: "c0b49fb8-d73c-42ec-8538-c2b3feb69242", project: "fluid-lending", symbol: "ETH" },
  },
  moonwell: {
    USDC: { poolId: "69cf831d-624a-4f23-b5e3-c0f63ad1fa01", project: "moonwell-lending", symbol: "USDC" },
    WETH: { poolId: "914284ae-dbef-421f-bbb7-7c42f527fd5f", project: "moonwell-lending", symbol: "ETH" },
  },
  euler: {
    USDC: { poolId: "7149d3d6-daab-4577-98c4-1ad7703a5bb2", project: "euler-v2", symbol: "USDC" },
    WETH: { poolId: "37ae63ba-576e-4ce4-a18d-fdab908c1456", project: "euler-v2", symbol: "WETH" },
  },
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
export async function readDefiLlamaPoolApy(protocol: DefiLlamaProtocolId, asset: AssetId): Promise<RateReading | null> {
  try {
    const pools = await fetchPools();
    const { poolId, project, symbol } = POOLS[protocol][asset];
    const match = pools.find(
      (p) => p.pool === poolId && p.project === project && p.chain.toLowerCase() === "base" && p.symbol === symbol,
    );
    if (!match) {
      logger.warn({ protocol, asset, poolId, project }, "pool não encontrado (ou não bate mais project/chain/symbol) na resposta atual da DefiLlama — omitindo desta vez");
      return null;
    }
    if (typeof match.apy !== "number" || !Number.isFinite(match.apy)) {
      logger.warn({ protocol, asset, apy: match.apy }, "DefiLlama retornou apy nulo/inválido — omitindo em vez de reportar 0%");
      return null;
    }
    if (match.tvlUsd < MIN_TVL_USD) {
      logger.warn({ protocol, asset, tvlUsd: match.tvlUsd }, "TVL abaixo do piso mínimo — pool possivelmente morto, omitindo");
      return null;
    }
    return {
      protocol,
      asset,
      supplyApyBps: Math.round(match.apy * 100),
      source: "defillama",
      readAt: new Date(),
    };
  } catch (err) {
    logger.warn({ protocol, asset, err }, "falha lendo taxa via DefiLlama — omitindo protocolo desta resposta");
    return null;
  }
}
