import { describe, it, expect } from "vitest";
import { onchainDepthUsd } from "../src/market-data/depth.js";

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
