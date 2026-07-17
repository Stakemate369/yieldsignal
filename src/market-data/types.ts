// Camada 1: lidos direto on-chain/API oficial do próprio protocolo (mais confiável).
export type DirectProtocolId = "aave" | "morpho" | "compound";

// Camada 2: lidos via DefiLlama yields API (agregador de terceiro) — cobertura
// mais ampla, transparentemente marcada como fonte menos direta que a Camada 1.
// Lista checada contra yields.llama.fi/pools em 2026-07-16, filtrando chain=Base
// e symbol=USDC: Spark (só tem "spark-savings" em USDS, não USDC), Seamless e
// Silo não têm nenhum mercado indexado na Base no momento — por isso não entram
// na lista abaixo. Reconferir a fonte antes de adicionar de volta.
export type DefiLlamaProtocolId = "moonwell" | "euler" | "fluid";

export type ProtocolId = DirectProtocolId | DefiLlamaProtocolId;

// Ativo cujo sinal de yield está sendo vendido. USDC é o produto original;
// WETH entrou em 2026-07-17 depois de checar ao vivo contra yields.llama.fi/pools
// que os 6 protocolos têm mercado WETH real na Base com APY distinto entre si
// (0.66%-3.7%) — diferente de cbBTC (único "BTC" que existe de fato na Base,
// não há WBTC canônico lá), cuja APY de supply fica quase sempre 0-0.2% em
// todo protocolo, sinal pouco útil pra vender. cbBTC não entra por isso, não
// por falta de mercado (mesmo tipo de decisão documentada já usada pra
// Spark/Seamless/Silo, ver defillamaPools.ts).
export type AssetId = "USDC" | "WETH";

export interface RateReading {
  protocol: ProtocolId;
  asset: AssetId;
  /** APY de supply em basis points (1% = 100 bps), já líquido de taxa do próprio protocolo quando aplicável. */
  supplyApyBps: number;
  source: "onchain" | "api" | "defillama";
  readAt: Date;
}
