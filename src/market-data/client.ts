import { createPublicClient, http } from "viem";
import { BASE_MAINNET } from "../config/networks.js";

/**
 * Um só PublicClient reaproveitado por todos os leitores on-chain da Camada 1
 * — cada chamada paga do endpoint aciona Aave + Compound em paralelo
 * (collectRates.ts); não faz sentido cada um instanciar o próprio client.
 *
 * `batch.multicall` agrupa as leituras que saem no mesmo tick numa ÚNICA
 * chamada RPC via Multicall3 (predeploy padrão, que a definição de chain da Base
 * na viem já conhece). Não é otimização especulativa: o RPC público
 * (`mainnet.base.org`) limita por taxa, e a rota de sensibilidade sozinha
 * dispara ~6 leituras por asset (1 `getReserveData` + 5 getters da estratégia
 * da Aave, mais 4 parâmetros + 1 sonda no Comet). Medido em 2026-08-05: sem
 * batching, TODOS os protocolos voltavam `over rate limit` e a resposta saía
 * com cobertura 0 de 5 — a degradação graciosa funcionava, mas entregava um
 * relatório vazio. Com o agrupamento, o mesmo trabalho cabe em poucas chamadas.
 */
export const basePublicClient = createPublicClient({
  chain: BASE_MAINNET.chain,
  transport: http(),
  batch: { multicall: true },
});
