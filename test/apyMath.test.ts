import { describe, it, expect } from "vitest";
import { compoundedRateToApyBps } from "../src/market-data/apyMath.js";

describe("compoundedRateToApyBps", () => {
  it("zero fração vira 0 bps, nos dois modos", () => {
    expect(compoundedRateToApyBps(0, false)).toBe(0);
    expect(compoundedRateToApyBps(0, true)).toBe(0);
  });

  it("aprova taxa anual (Aave, alreadyPerSecond=false) — 5% APR vira ~5.13% APY composto", () => {
    // (1 + 0.05/N)^N - 1 converge pra e^0.05 - 1 ≈ 0.05127
    const bps = compoundedRateToApyBps(0.05, false);
    expect(bps).toBeGreaterThan(510);
    expect(bps).toBeLessThan(515);
  });

  it("taxa já por-segundo (Compound, alreadyPerSecond=true) equivale a mesma composição anualizada", () => {
    // fração por segundo que corresponde a ~5% de taxa anual linear
    const perSecond = 0.05 / (365 * 24 * 60 * 60);
    const bps = compoundedRateToApyBps(perSecond, true);
    expect(bps).toBeGreaterThan(510);
    expect(bps).toBeLessThan(515);
  });

  it("os dois modos concordam quando alimentados com a fração equivalente", () => {
    const annual = 0.08;
    const perSecondEquivalent = annual / (365 * 24 * 60 * 60);
    const viaAnnual = compoundedRateToApyBps(annual, false);
    const viaPerSecond = compoundedRateToApyBps(perSecondEquivalent, true);
    expect(viaAnnual).toBe(viaPerSecond);
  });

  it("arredonda pra basis points inteiros", () => {
    const bps = compoundedRateToApyBps(0.0427, false);
    expect(Number.isInteger(bps)).toBe(true);
  });
});
