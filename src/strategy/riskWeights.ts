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
};

export function weightedApyBps(protocol: ProtocolId, rawApyBps: number): number {
  return Math.round(rawApyBps * RISK_WEIGHTS[protocol]);
}
