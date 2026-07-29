import type { AssetId, ProtocolId } from "../market-data/types.js";
import { POOLS as STAKING_POOLS } from "../market-data/ethStaking.js";

/**
 * Protocolos que o serviço TENTA ler para cada asset — a lista de referência
 * contra a qual se mede a cobertura de uma resposta.
 *
 * Existe porque a omissão silenciosa era um furo de integridade do produto:
 * `collectRates` descarta a leitura que falhou (RPC público estourando cota,
 * pool fora do ar) e registra só um `logger.warn`, que em produção é invisível.
 * O comprador recebia 3 protocolos de 6 sem NENHUMA forma de distinguir
 * "Compound não é competitivo agora" de "Compound não foi lido nesta chamada" —
 * e a resposta ainda anunciava o melhor entre os que sobraram como se fosse o
 * melhor do mercado. Num produto cujo argumento é "source-tagged, nunca
 * estimado", isso é grave.
 *
 * A lista de staking é derivada de `POOLS` (ethStaking.ts), a fonte real que o
 * pipeline percorre, pra não virar uma segunda cópia que desatualiza. As de
 * lending são a união da Camada 1 (leitura direta) com a Camada 2 (DefiLlama) —
 * ver LENDING_DEFILLAMA_PROTOCOLS, importada por collectRates.ts pra que a
 * lista percorrida e a lista esperada sejam literalmente a mesma.
 */

/** Camada 2 de lending — percorrida por collectRates E contada aqui. Uma fonte só. */
export const LENDING_DEFILLAMA_PROTOCOLS = ["fluid", "moonwell", "euler"] as const;

/** Camada 1 de lending — leitura direta on-chain/API do próprio protocolo. */
export const LENDING_DIRECT_PROTOCOLS = ["aave", "compound", "morpho"] as const;

const LENDING_PROTOCOLS: readonly ProtocolId[] = [...LENDING_DIRECT_PROTOCOLS, ...LENDING_DEFILLAMA_PROTOCOLS];

export const EXPECTED_PROTOCOLS: Record<AssetId, readonly ProtocolId[]> = {
  ETH_STAKING: Object.keys(STAKING_POOLS) as ProtocolId[],
  USDC: LENDING_PROTOCOLS,
  WETH: LENDING_PROTOCOLS,
};

/**
 * Protocolos esperados pro asset que NÃO apareceram nesta resposta. Ordem
 * estável (a de EXPECTED_PROTOCOLS) pra a resposta ser determinística — importa
 * porque o corpo é hasheado e assinado.
 */
export function omittedProtocols(asset: AssetId, present: readonly ProtocolId[]): ProtocolId[] {
  const seen = new Set(present);
  return (EXPECTED_PROTOCOLS[asset] ?? []).filter((p) => !seen.has(p));
}
