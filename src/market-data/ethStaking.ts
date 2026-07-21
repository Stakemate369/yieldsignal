import { logger } from "../notify/logger.js";
import { fetchDefiLlamaPools, matchDefiLlamaPool, readingFromPool } from "./defillamaClient.js";
import type { RateReading, StakingProtocolId } from "./types.js";

/**
 * Mesma disciplina de defillamaPools.ts: UUID do pool específico MAIS
 * project/chain/symbol como segunda checagem. Diferente do lending (chain
 * Base), staking líquido acontece na Ethereum mainnet — os protocolos nem
 * têm mercado na Base. Verificado ao vivo em 2026-07-20 contra
 * yields.llama.fi/pools (chain=Ethereum, maior TVL de cada projeto).
 */
const POOLS: Record<StakingProtocolId, { poolId: string; project: string; symbol: string }> = {
  lido: { poolId: "747c1d2a-c668-4682-b9f9-296708a3dd90", project: "lido", symbol: "STETH" },
  "rocket-pool": { poolId: "d4b3c522-6127-4b89-bedf-83641cdcd2eb", project: "rocket-pool", symbol: "RETH" },
  "coinbase-wrapped-staked-eth": {
    poolId: "0f45d730-b279-4629-8e11-ccb5cc3038b4",
    project: "coinbase-wrapped-staked-eth",
    symbol: "CBETH",
  },
  "frax-ether": { poolId: "5b3aebb3-891d-47fc-92e2-927ada3d5b82", project: "frax-ether", symbol: "SFRXETH" },
  "binance-staked-eth": { poolId: "80b8bf92-b953-4c20-98ea-c9653ef2bb98", project: "binance-staked-eth", symbol: "WBETH" },
};

/**
 * Lê a APY de staking de um protocolo. Mesmo contrato de falha graciosa que
 * readDefiLlamaPoolApy: nunca lança, `null` = omitir da resposta desta vez.
 * Fetch/cache/match compartilhados com defillamaPools.ts via
 * defillamaClient.ts — mesmo endpoint (yields.llama.fi/pools devolve todas
 * as chains sem filtro), evita cache duplicado e busca redundante.
 */
export async function readEthStakingApy(protocol: StakingProtocolId): Promise<RateReading | null> {
  try {
    const { poolId, project, symbol } = POOLS[protocol];
    const pools = await fetchDefiLlamaPools();
    const match = matchDefiLlamaPool(pools, { poolId, project, chain: "ethereum", symbol });
    return readingFromPool(match, () => ({ protocol, asset: "ETH_STAKING" as const }), { protocol, poolId, project });
  } catch (err) {
    logger.warn({ protocol, err }, "falha lendo taxa de staking via DefiLlama — omitindo protocolo desta resposta");
    return null;
  }
}

/**
 * Junta as 5 leituras de staking líquido. Mesmo contrato que collectRates.ts:
 * só lança se NENHUMA fonte respondeu (sem sinal nenhum pra vender).
 */
export async function collectEthStakingRates(): Promise<RateReading[]> {
  const protocols: StakingProtocolId[] = ["lido", "rocket-pool", "coinbase-wrapped-staked-eth", "frax-ether", "binance-staked-eth"];
  const results = await Promise.all(protocols.map((p) => readEthStakingApy(p)));
  const readings = results.filter((r): r is RateReading => r !== null);
  if (readings.length === 0) {
    throw new Error("todas as fontes de taxa de staking ETH falharam nesta chamada — sem dado pra gerar sinal");
  }
  return readings;
}
