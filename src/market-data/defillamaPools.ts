import { logger } from "../notify/logger.js";
import { fetchDefiLlamaPools, matchDefiLlamaPool, readingFromPool } from "./defillamaClient.js";
import type { DefiLlamaProtocolId, LendingAssetId, RateReading } from "./types.js";

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
const POOLS: Record<DefiLlamaProtocolId, Record<LendingAssetId, { poolId: string; project: string; symbol: string }>> = {
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

/**
 * Lê a APY de um protocolo da Camada 2 (via DefiLlama). Diferente da Camada 1,
 * uma falha aqui não deve derrubar a resposta inteira do sinal — um protocolo
 * a menos na lista é preferível a um erro 500 pro comprador. Por isso quem
 * chama (signal/computeSignal.ts) trata `null` como "omitir da resposta desta vez",
 * não como falha fatal. Fetch/cache/match compartilhados com ethStaking.ts via
 * defillamaClient.ts — mesmo endpoint (yields.llama.fi/pools devolve todas as
 * chains sem filtro), evita cache duplicado e busca redundante.
 */
export async function readDefiLlamaPoolApy(protocol: DefiLlamaProtocolId, asset: LendingAssetId): Promise<RateReading | null> {
  try {
    const { poolId, project, symbol } = POOLS[protocol][asset];
    const pools = await fetchDefiLlamaPools();
    const match = matchDefiLlamaPool(pools, { poolId, project, chain: "base", symbol });
    return readingFromPool(match, () => ({ protocol, asset }), { protocol, asset, poolId, project });
  } catch (err) {
    logger.warn({ protocol, asset, err }, "falha lendo taxa via DefiLlama — omitindo protocolo desta resposta");
    return null;
  }
}
