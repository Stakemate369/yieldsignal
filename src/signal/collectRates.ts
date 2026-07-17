import { readAaveSupplyApy } from "../market-data/aave.js";
import { readCompoundSupplyApy } from "../market-data/compound.js";
import { readMorphoVaultApy } from "../market-data/morpho.js";
import { readDefiLlamaPoolApy } from "../market-data/defillamaPools.js";
import type { RateReading } from "../market-data/types.js";
import { logger } from "../notify/logger.js";

/**
 * Junta as duas camadas de fonte de dado. Cada leitura é isolada das outras
 * (Promise.allSettled) — um RPC lento na Aave não deve derrubar a resposta
 * inteira quando o comprador já pagou pela chamada. Só lança erro se
 * NENHUMA fonte respondeu, porque aí não há sinal nenhum pra vender.
 */
export async function collectRates(): Promise<RateReading[]> {
  const directReaders = [readAaveSupplyApy, readCompoundSupplyApy, readMorphoVaultApy];

  const directResults = await Promise.allSettled(directReaders.map((read) => read()));
  const direct: RateReading[] = [];
  directResults.forEach((result, i) => {
    if (result.status === "fulfilled") {
      direct.push(result.value);
    } else {
      logger.warn({ reader: directReaders[i].name, err: result.reason }, "falha lendo taxa da Camada 1 — omitindo protocolo desta resposta");
    }
  });

  const defiLlamaProtocols = ["fluid", "moonwell", "euler"] as const;
  const viaDefiLlama = await Promise.all(defiLlamaProtocols.map((p) => readDefiLlamaPoolApy(p)));
  const layer2 = viaDefiLlama.filter((r): r is RateReading => r !== null);

  const all = [...direct, ...layer2];
  if (all.length === 0) {
    throw new Error("todas as fontes de taxa falharam nesta chamada — sem dado pra gerar sinal");
  }
  return all;
}
