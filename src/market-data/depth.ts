import type { LendingAssetId } from "./types.js";

/**
 * Profundidade do mercado, em USD, a partir do saldo que o PRÓPRIO protocolo
 * reporta on-chain.
 *
 * Por que não usar sempre o agregador: medido em 2026-07-30, a DefiLlama
 * reportava US$ 788.850 de TVL pro mercado de USDC da Compound v3 na Base
 * enquanto o `totalSupply()` do Comet dizia US$ 8.446.455 — dez vezes maior.
 * Um número de profundidade errado por uma ordem de grandeza é pior que
 * nenhum: ele dispararia o aviso de "sua posição é grande demais pra este
 * mercado" num mercado que comporta a posição folgadamente.
 *
 * Por que SÓ stablecoin: converter o saldo de um mercado de WETH em dólar
 * exigiria um oráculo de preço dentro do caminho de uma resposta paga — mais
 * uma dependência e mais um modo de falha, pra um dado que é indicativo. Fora
 * da stablecoin a resposta cai no TVL do agregador (ver incentives.ts), e
 * quando nem isso existe o campo vai `null` em vez de um palpite.
 *
 * A conversão 1:1 assume USDC valendo um dólar. Num depeg o número erra na
 * proporção do depeg — irrelevante pra uma medida de ordem de grandeza, e
 * preferível a não ter medida nenhuma.
 */
const USD_STABLE_DECIMALS: Partial<Record<LendingAssetId, number>> = {
  USDC: 6,
};

export function onchainDepthUsd(asset: LendingAssetId, rawBalance: bigint | undefined): number | null {
  const decimals = USD_STABLE_DECIMALS[asset];
  if (decimals === undefined || rawBalance === undefined) return null;
  const value = Number(rawBalance) / 10 ** decimals;
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}
