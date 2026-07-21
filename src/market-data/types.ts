// Camada 1: lidos direto on-chain/API oficial do próprio protocolo (mais confiável).
export type DirectProtocolId = "aave" | "morpho" | "compound";

// Camada 2: lidos via DefiLlama yields API (agregador de terceiro) — cobertura
// mais ampla, transparentemente marcada como fonte menos direta que a Camada 1.
// Lista checada contra yields.llama.fi/pools em 2026-07-16, filtrando chain=Base
// e symbol=USDC: Spark (só tem "spark-savings" em USDS, não USDC), Seamless e
// Silo não têm nenhum mercado indexado na Base no momento — por isso não entram
// na lista abaixo. Reconferir a fonte antes de adicionar de volta.
export type DefiLlamaProtocolId = "moonwell" | "euler" | "fluid";

// ETH staking líquido (Ethereum mainnet, via DefiLlama — não existe leitura
// on-chain própria pra isso no repo, mesma categoria de fonte que a Camada 2
// de lending, só que outra chain). Ver market-data/ethStaking.ts. Lista
// verificada ao vivo em 2026-07-20 contra yields.llama.fi/pools (chain=Ethereum):
// os 5 têm APY real distinto (2.19%-2.96%) e TVL alto (>$70M cada) — mesmo
// rigor de "não adivinhar" já aplicado às pools de lending abaixo.
export type StakingProtocolId = "lido" | "rocket-pool" | "coinbase-wrapped-staked-eth" | "frax-ether" | "binance-staked-eth";

export type ProtocolId = DirectProtocolId | DefiLlamaProtocolId | StakingProtocolId;

// Ativo cujo sinal de yield vendido é sobre LENDING na Base — os 3 leitores da
// Camada 1 (aave.ts/compound.ts/morpho.ts) e BASE_ASSETS (config/networks.ts)
// são indexados por este tipo, não por AssetId, porque staking (abaixo) não
// tem mercado de lending equivalente nesses protocolos.
export type LendingAssetId = "USDC" | "WETH";

// Ativo cujo sinal de yield está sendo vendido. USDC é o produto original;
// WETH entrou em 2026-07-17 depois de checar ao vivo contra yields.llama.fi/pools
// que os 6 protocolos têm mercado WETH real na Base com APY distinto entre si
// (0.66%-3.7%) — diferente de cbBTC (único "BTC" que existe de fato na Base,
// não há WBTC canônico lá), cuja APY de supply fica quase sempre 0-0.2% em
// todo protocolo, sinal pouco útil pra vender. cbBTC não entra por isso, não
// por falta de mercado (mesmo tipo de decisão documentada já usada pra
// Spark/Seamless/Silo, ver defillamaPools.ts).
//
// ETH_STAKING entrou em 2026-07-20: categoria DIFERENTE de produto (staking
// líquido em Ethereum mainnet, não lending em Base) — reaproveita toda a
// mecânica já genérica em AssetId (rota x402, free trial, atestação
// automática, dashboard de track record) sem precisar duplicar nenhuma dessa
// infra, mas NÃO entra em BASE_ASSETS/LendingAssetId (ver collectRates.ts).
export type AssetId = LendingAssetId | "ETH_STAKING";

// Única lista canônica dos AssetId vendidos — cli/showSignal.ts, cli/attestSignal.ts
// e o z.enum da tool MCP (mcp.ts) importam daqui em vez de cada um manter a
// própria cópia da lista (achado em revisão: eram 3 literais hand-kept-in-sync,
// exatamente o tipo de coisa que dá pra esquecer de atualizar num asset novo).
export const ASSET_IDS = ["USDC", "WETH", "ETH_STAKING"] as const satisfies readonly AssetId[];

export interface RateReading {
  protocol: ProtocolId;
  asset: AssetId;
  /** APY de supply em basis points (1% = 100 bps), já líquido de taxa do próprio protocolo quando aplicável. */
  supplyApyBps: number;
  source: "onchain" | "api" | "defillama";
  readAt: Date;
}
