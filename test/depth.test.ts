import { describe, it, expect } from "vitest";
import { marketLiquidity, onchainDepthUsd } from "../src/market-data/depth.js";

/**
 * Motivo de existir (2026-07-30): a DefiLlama reportava US$ 788.850 de TVL pro
 * mercado de USDC da Compound v3 na Base enquanto o `totalSupply()` do Comet
 * dizia US$ 8.446.455 — dez vezes maior. Profundidade errada por uma ordem de
 * grandeza dispararia o aviso de "posição grande demais" num mercado que
 * comporta a posição folgadamente.
 */
describe("onchainDepthUsd", () => {
  it("converte saldo de USDC (6 casas) em dólar", () => {
    expect(onchainDepthUsd("USDC", 8_446_455_123_456n)).toBe(8_446_455);
  });

  it("devolve null pra ativo não-stable — converter exigiria oráculo de preço", () => {
    expect(onchainDepthUsd("WETH", 1_000_000_000_000_000_000n)).toBeNull();
  });

  it("saldo ausente vira null, não zero (zero seria 'mercado vazio', que é outra afirmação)", () => {
    expect(onchainDepthUsd("USDC", undefined)).toBeNull();
  });

  it("saldo zerado também vira null em vez de anunciar mercado sem fundo nenhum", () => {
    expect(onchainDepthUsd("USDC", 0n)).toBeNull();
  });
});

const M = 1_000_000n; // 1 USDC em unidades de 6 casas

describe("marketLiquidity", () => {
  it("deriva utilização e liquidez livre dos saldos brutos", () => {
    const liq = marketLiquidity("USDC", 1_000n * M, 750n * M);
    expect(liq).toEqual({ utilizationBps: 7_500, availableLiquidityUsd: 250, totalSuppliedUsd: 1_000 });
  });

  /**
   * O caso que mais importa pro comprador: mercado 100% utilizado tem ZERO
   * sacável, e zero é uma medição. Servir `null` aqui leria como "não apurado"
   * quando a informação é a pior possível — a diferença entre "não sei se você
   * sai" e "você não sai".
   */
  it("zero sacável é 0, não null", () => {
    const liq = marketLiquidity("USDC", 1_000n * M, 1_000n * M);
    expect(liq?.utilizationBps).toBe(10_000);
    expect(liq?.availableLiquidityUsd).toBe(0);
  });

  it("clampa emprestado acima de fornecido (juro acumulado) em vez de devolver negativo", () => {
    const liq = marketLiquidity("USDC", 1_000n * M, 1_005n * M);
    expect(liq?.utilizationBps).toBe(10_000);
    expect(liq?.availableLiquidityUsd).toBe(0);
  });

  it("mede utilização em WETH mesmo sem conseguir valor em dólar", () => {
    const liq = marketLiquidity("WETH", 10n ** 20n, 10n ** 19n);
    expect(liq?.utilizationBps).toBe(1_000);
    expect(liq?.availableLiquidityUsd).toBeNull();
    expect(liq?.totalSuppliedUsd).toBeNull();
  });

  // Dividir por zero não dá 0% de utilização, dá indefinido — e servir 0 ali
  // significaria "totalmente líquido", o oposto do que se sabe.
  it("mercado sem nada fornecido é indefinido, não 0% de utilização", () => {
    expect(marketLiquidity("USDC", 0n, 0n)).toBeUndefined();
  });
});
