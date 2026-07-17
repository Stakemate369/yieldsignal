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

export interface RateReading {
  protocol: ProtocolId;
  /** APY de supply em basis points (1% = 100 bps), já líquido de taxa do próprio protocolo quando aplicável. */
  supplyApyBps: number;
  source: "onchain" | "api" | "defillama";
  readAt: Date;
}
