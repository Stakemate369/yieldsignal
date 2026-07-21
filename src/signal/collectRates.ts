import { readAaveSupplyApy } from "../market-data/aave.js";
import { readCompoundSupplyApy } from "../market-data/compound.js";
import { readMorphoVaultApy } from "../market-data/morpho.js";
import { readDefiLlamaPoolApy } from "../market-data/defillamaPools.js";
import { collectEthStakingRates } from "../market-data/ethStaking.js";
import type { AssetId, RateReading } from "../market-data/types.js";
import { logger } from "../notify/logger.js";

/**
 * Junta as fontes de dado pro ativo pedido. ETH_STAKING é uma categoria
 * inteiramente separada (Ethereum mainnet, sem mercado de lending
 * equivalente nos protocolos da Camada 1) — delega pro pipeline próprio em
 * ethStaking.ts em vez de tentar encaixar no formato Camada1+Camada2 abaixo,
 * que é específico de lending na Base (ver LendingAssetId em types.ts).
 *
 * Pro caso de lending: cada leitura é isolada das outras (Promise.allSettled)
 * — um RPC lento na Aave não deve derrubar a resposta inteira quando o
 * comprador já pagou pela chamada. Só lança erro se NENHUMA fonte respondeu,
 * porque aí não há sinal nenhum pra vender.
 */
export async function collectRates(asset: AssetId): Promise<RateReading[]> {
  if (asset === "ETH_STAKING") {
    return collectEthStakingRates();
  }

  const directReaders = [readAaveSupplyApy, readCompoundSupplyApy, readMorphoVaultApy];

  const directResults = await Promise.allSettled(directReaders.map((read) => read(asset)));
  const direct: RateReading[] = [];
  directResults.forEach((result, i) => {
    if (result.status === "fulfilled") {
      direct.push(result.value);
    } else {
      logger.warn({ reader: directReaders[i].name, asset, err: result.reason }, "falha lendo taxa da Camada 1 — omitindo protocolo desta resposta");
    }
  });

  const defiLlamaProtocols = ["fluid", "moonwell", "euler"] as const;
  const viaDefiLlama = await Promise.all(defiLlamaProtocols.map((p) => readDefiLlamaPoolApy(p, asset)));
  const layer2 = viaDefiLlama.filter((r): r is RateReading => r !== null);

  const all = [...direct, ...layer2];
  if (all.length === 0) {
    throw new Error(`todas as fontes de taxa falharam nesta chamada (asset=${asset}) — sem dado pra gerar sinal`);
  }
  return all;
}
