import type { ProtocolId } from "../market-data/types.js";

/**
 * Peso de risco aplicado à taxa bruta antes de comparar. Protocolos da
 * Camada 1 (lidos direto on-chain/API oficial) usam os mesmos pesos já
 * validados no YieldPilot. Protocolos da Camada 2 (via DefiLlama, agregador
 * de terceiro, não leitura direta do contrato) recebem peso mais conservador
 * — a incerteza extra é sobre a fonte do dado, não sobre o protocolo em si.
 * Ajuste livre, mas mude aqui, não espalhado pelo código.
 */
export const RISK_WEIGHTS: Record<ProtocolId, number> = {
  // Camada 1 — leitura direta
  aave: 1.0,
  morpho: 0.97,
  compound: 0.99,
  // Camada 2 — via DefiLlama (peso mais conservador pela fonte agregada)
  moonwell: 0.88,
  euler: 0.87,
  fluid: 0.85,
  // Staking líquido ETH (Ethereum mainnet, via DefiLlama) — peso reflete
  // descentralização/tempo em produção do PROTOCOLO, não a fonte do dado
  // (todos via DefiLlama, mesma incerteza de agregador já embutida acima).
  // Lido: maior TVL, mais tempo em produção. Rocket Pool: nós descentralizados,
  // track record sólido porém TVL bem menor. Coinbase/Binance: risco de
  // contraparte centralizada (custódia de exchange) apesar do TVL alto — por
  // isso mais conservador que Rocket Pool mesmo sendo maior. Frax: protocolo
  // menor/mais novo, ecossistema mais complexo.
  lido: 0.97,
  "rocket-pool": 0.93,
  "coinbase-wrapped-staked-eth": 0.9,
  "binance-staked-eth": 0.85,
  "frax-ether": 0.82,
};

export function weightedApyBps(protocol: ProtocolId, rawApyBps: number): number {
  return Math.round(rawApyBps * RISK_WEIGHTS[protocol]);
}
