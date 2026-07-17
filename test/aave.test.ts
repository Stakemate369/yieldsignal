import { describe, it, expect, vi, beforeEach } from "vitest";
import type { readAaveSupplyApy as ReadAaveSupplyApy } from "../src/market-data/aave.js";

const RAY = 10n ** 27n;

// Constrói o tuple de 12 posições que getReserveData retorna, só preenchendo
// liquidityRate (índice 5) — o único campo que aave.ts de fato lê.
function reserveDataWithLiquidityRate(liquidityRateRay: bigint): readonly unknown[] {
  return [0n, 0n, 0n, 0n, 0n, liquidityRateRay, 0n, 0n, 0n, 0n, 0n, 0];
}

let readAaveSupplyApy: typeof ReadAaveSupplyApy;
let readContractMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  readContractMock = vi.fn();
  vi.doMock("../src/market-data/client.js", () => ({
    basePublicClient: { readContract: readContractMock },
  }));
  ({ readAaveSupplyApy } = await import("../src/market-data/aave.js"));
});

describe("readAaveSupplyApy", () => {
  it("converte liquidityRate (ray, APR linear) pra APY composto em bps", async () => {
    // 5% APR linear em ray
    readContractMock.mockResolvedValue(reserveDataWithLiquidityRate((RAY * 5n) / 100n));
    const reading = await readAaveSupplyApy();
    expect(reading.protocol).toBe("aave");
    expect(reading.source).toBe("onchain");
    // e^0.05 - 1 ≈ 5.13%
    expect(reading.supplyApyBps).toBeGreaterThan(510);
    expect(reading.supplyApyBps).toBeLessThan(515);
  });

  it("liquidityRate zero vira 0 bps", async () => {
    readContractMock.mockResolvedValue(reserveDataWithLiquidityRate(0n));
    const reading = await readAaveSupplyApy();
    expect(reading.supplyApyBps).toBe(0);
  });

  it("cacheia por TTL — duas chamadas seguidas fazem só 1 readContract", async () => {
    readContractMock.mockResolvedValue(reserveDataWithLiquidityRate((RAY * 3n) / 100n));
    await readAaveSupplyApy();
    await readAaveSupplyApy();
    expect(readContractMock).toHaveBeenCalledTimes(1);
  });

  it("propaga erro se a leitura on-chain falhar (não inventa taxa)", async () => {
    readContractMock.mockRejectedValue(new Error("RPC Request failed."));
    await expect(readAaveSupplyApy()).rejects.toThrow("RPC Request failed.");
  });
});
