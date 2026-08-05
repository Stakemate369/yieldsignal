import { describe, expect, it } from "vitest";
import { computeCapacity } from "../src/signal/capacity.js";
import type { MarketLiquidity, RateReading } from "../src/market-data/types.js";

function reading(
  protocol: RateReading["protocol"],
  supplyApyBps: number,
  liquidity?: MarketLiquidity,
): RateReading {
  return {
    protocol,
    asset: "USDC",
    supplyApyBps,
    apyBaseBps: supplyApyBps,
    apyRewardBps: 0,
    rewardBasis: "reported",
    tvlUsd: liquidity?.totalSuppliedUsd ?? null,
    tvlBasis: liquidity ? "total-supplied" : null,
    source: "onchain",
    ...(liquidity ? { liquidity } : {}),
    readAt: new Date("2026-08-05T12:00:00.000Z"),
  };
}

const liq = (utilizationBps: number, available: number | null, supplied: number | null): MarketLiquidity => ({
  utilizationBps,
  availableLiquidityUsd: available,
  totalSuppliedUsd: supplied,
});

describe("computeCapacity", () => {
  it("classifica utilização em faixas", () => {
    const r = computeCapacity(
      "USDC",
      [
        reading("aave", 500, liq(9_500, 100, 2_000)),
        reading("compound", 400, liq(8_500, 300, 2_000)),
        reading("morpho", 300, liq(4_000, 1_200, 2_000)),
      ],
      null,
    );
    const tiers = Object.fromEntries(r.entries.map((e) => [e.protocol, e.liquidityTier]));
    expect(tiers).toEqual({ aave: "tight", compound: "moderate", morpho: "ample" });
  });

  it("aprova saída só quando a liquidez livre cobre a posição", () => {
    const r = computeCapacity("USDC", [reading("aave", 500, liq(9_000, 50_000, 500_000))], 100_000);
    expect(r.entries[0]!.canExitNow).toBe(false);
    expect(r.entries[0]!.exitCoverageRatio).toBe(0.5);
    expect(r.bestProtocolExecutable).toBeNull();
  });

  it("escolhe o melhor APY ENTRE os que comportam a saída", () => {
    const r = computeCapacity(
      "USDC",
      [
        reading("aave", 900, liq(9_900, 10_000, 1_000_000)), // paga mais, não deixa sair
        reading("compound", 400, liq(2_000, 800_000, 1_000_000)),
      ],
      100_000,
    );
    expect(r.bestProtocolNow).toBe("aave");
    expect(r.bestProtocolExecutable).toBe("compound");
  });

  // A guarda central: mercado não medido nunca entra como aprovado. Recomendar
  // liquidez que não foi lida é justamente a falsa confiança que a rota desfaz.
  it("nunca recomenda um protocolo cuja liquidez não foi medida", () => {
    const r = computeCapacity(
      "USDC",
      [reading("morpho", 900), reading("compound", 400, liq(2_000, 800_000, 1_000_000))],
      100_000,
    );
    expect(r.entries[0]!.measured).toBe(false);
    expect(r.entries[0]!.canExitNow).toBeNull();
    expect(r.entries[0]!.liquidityTier).toBe("unmeasured");
    expect(r.bestProtocolExecutable).toBe("compound");
    expect(r.unmeasured).toEqual(["morpho"]);
  });

  it("calcula a fatia da posição sobre o total fornecido", () => {
    const r = computeCapacity("USDC", [reading("aave", 500, liq(5_000, 500_000, 1_000_000))], 250_000);
    expect(r.entries[0]!.positionShareOfSuppliedPct).toBe(25);
  });

  // WETH mede utilização mas não tem valor em USD (sem oráculo no caminho pago).
  it("sem valor em USD, reporta utilização e não emite veredito de saída", () => {
    const r = computeCapacity("WETH", [reading("aave", 500, liq(7_000, null, null))], 100_000);
    expect(r.entries[0]!.measured).toBe(true);
    expect(r.entries[0]!.utilizationBps).toBe(7_000);
    expect(r.entries[0]!.canExitNow).toBeNull();
    expect(r.bestProtocolExecutable).toBeNull();
  });

  it("sem amountUsd, entrega liquidez sem veredito", () => {
    const r = computeCapacity("USDC", [reading("aave", 500, liq(5_000, 500_000, 1_000_000))], null);
    expect(r.amountUsd).toBeNull();
    expect(r.entries[0]!.canExitNow).toBeNull();
    expect(r.entries[0]!.availableLiquidityUsd).toBe(500_000);
  });

  it("ignora amountUsd inválido em vez de propagar NaN", () => {
    const r = computeCapacity("USDC", [reading("aave", 500, liq(5_000, 500_000, 1_000_000))], Number.NaN);
    expect(r.amountUsd).toBeNull();
    expect(r.entries[0]!.exitCoverageRatio).toBeNull();
  });

  it("zero sacável é medição, não ausência de dado", () => {
    const r = computeCapacity("USDC", [reading("aave", 500, liq(10_000, 0, 1_000_000))], 1_000);
    expect(r.entries[0]!.availableLiquidityUsd).toBe(0);
    expect(r.entries[0]!.canExitNow).toBe(false);
    expect(r.entries[0]!.liquidityTier).toBe("tight");
  });
});
