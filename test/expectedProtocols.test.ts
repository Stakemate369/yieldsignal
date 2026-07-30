import { describe, it, expect } from "vitest";
import {
  EXPECTED_PROTOCOLS,
  LENDING_DEFILLAMA_PROTOCOLS,
  LENDING_DIRECT_PROTOCOLS,
  omittedProtocols,
} from "../src/signal/expectedProtocols.js";
import { computeSignal } from "../src/signal/computeSignal.js";
import { ASSET_IDS, type RateReading } from "../src/market-data/types.js";

function reading(protocol: RateReading["protocol"], asset: RateReading["asset"], apy: number): RateReading {
  return { protocol, asset, supplyApyBps: apy, apyBaseBps: apy, apyRewardBps: 0, rewardBasis: "reported", tvlUsd: 5_000_000, source: "defillama", readAt: new Date("2026-07-29T12:00:00Z") };
}

describe("EXPECTED_PROTOCOLS", () => {
  it("cobre todos os assets vendidos — asset novo sem lista esperada quebraria a cobertura em silêncio", () => {
    for (const asset of ASSET_IDS) {
      expect(EXPECTED_PROTOCOLS[asset], `asset ${asset} sem lista esperada`).toBeDefined();
      expect(EXPECTED_PROTOCOLS[asset].length).toBeGreaterThan(0);
    }
  });

  it("lending espera as duas camadas (direta + DefiLlama)", () => {
    for (const p of [...LENDING_DIRECT_PROTOCOLS, ...LENDING_DEFILLAMA_PROTOCOLS]) {
      expect(EXPECTED_PROTOCOLS.USDC).toContain(p);
      expect(EXPECTED_PROTOCOLS.WETH).toContain(p);
    }
  });

  it("staking deriva da MESMA fonte que o pipeline percorre (POOLS), com os 5 protocolos", () => {
    expect(EXPECTED_PROTOCOLS.ETH_STAKING).toEqual(
      expect.arrayContaining(["lido", "rocket-pool", "coinbase-wrapped-staked-eth", "frax-ether", "binance-staked-eth"]),
    );
    expect(EXPECTED_PROTOCOLS.ETH_STAKING).toHaveLength(5);
  });
});

describe("omittedProtocols", () => {
  it("lista o que faltou, preservando a ordem canônica (resposta determinística porque é assinada)", () => {
    expect(omittedProtocols("USDC", ["compound", "moonwell"])).toEqual(["aave", "morpho", "fluid", "euler"]);
  });

  it("devolve vazio com cobertura total", () => {
    expect(omittedProtocols("USDC", [...LENDING_DIRECT_PROTOCOLS, ...LENDING_DEFILLAMA_PROTOCOLS])).toEqual([]);
  });

  it("ignora protocolo presente que não estava na lista esperada (não vira negativo)", () => {
    expect(omittedProtocols("ETH_STAKING", ["lido", "compound"])).not.toContain("compound");
  });
});

describe("computeSignal — cobertura exposta na resposta", () => {
  it("marca os protocolos de lending que não foram lidos nesta chamada", () => {
    const signal = computeSignal([reading("moonwell", "USDC", 400), reading("euler", "USDC", 380)]);
    // Os 4 que faltaram, na ordem canônica de EXPECTED_PROTOCOLS.
    expect(signal.omittedProtocols).toEqual(["aave", "compound", "morpho", "fluid"]);
    expect(signal.coverage).toEqual({ read: 2, expected: 6 });
  });

  it("cobertura total deixa omittedProtocols vazio", () => {
    const signal = computeSignal([
      reading("lido", "ETH_STAKING", 300),
      reading("rocket-pool", "ETH_STAKING", 290),
      reading("coinbase-wrapped-staked-eth", "ETH_STAKING", 280),
      reading("frax-ether", "ETH_STAKING", 270),
      reading("binance-staked-eth", "ETH_STAKING", 260),
    ]);
    expect(signal.omittedProtocols).toEqual([]);
    expect(signal.coverage).toEqual({ read: 5, expected: 5 });
  });

  it("uma leitura só ainda reporta cobertura honesta em vez de fingir mercado completo", () => {
    const signal = computeSignal([reading("lido", "ETH_STAKING", 300)]);
    expect(signal.coverage).toEqual({ read: 1, expected: 5 });
    expect(signal.omittedProtocols).toHaveLength(4);
  });
});
