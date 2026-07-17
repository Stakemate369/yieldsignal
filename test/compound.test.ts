import { describe, it, expect, vi, beforeEach } from "vitest";
import type { readCompoundSupplyApy as ReadCompoundSupplyApy } from "../src/market-data/compound.js";

const FACTOR_SCALE = 10n ** 18n;

let readCompoundSupplyApy: typeof ReadCompoundSupplyApy;
let readContractMock: ReturnType<typeof vi.fn>;

function mockUtilizationAndSupplyRate(supplyRatePerSecond: bigint): void {
  readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "getUtilization") return 500_000_000_000_000_000n; // valor arbitrário, só passado adiante
    if (functionName === "getSupplyRate") return supplyRatePerSecond;
    throw new Error(`função inesperada no mock: ${functionName}`);
  });
}

beforeEach(async () => {
  vi.resetModules();
  readContractMock = vi.fn();
  vi.doMock("../src/market-data/client.js", () => ({
    basePublicClient: { readContract: readContractMock },
  }));
  ({ readCompoundSupplyApy } = await import("../src/market-data/compound.js"));
});

describe("readCompoundSupplyApy", () => {
  it("converte getSupplyRate (por segundo, escala 1e18) pra APY composto em bps", async () => {
    // fração por segundo equivalente a ~5% de taxa anual linear
    const perSecond = (0.05 * Number(FACTOR_SCALE)) / (365 * 24 * 60 * 60);
    mockUtilizationAndSupplyRate(BigInt(Math.round(perSecond)));
    const reading = await readCompoundSupplyApy();
    expect(reading.protocol).toBe("compound");
    expect(reading.source).toBe("onchain");
    expect(reading.supplyApyBps).toBeGreaterThan(500);
    expect(reading.supplyApyBps).toBeLessThan(520);
  });

  it("chama getUtilization ANTES de getSupplyRate e repassa o resultado como argumento", async () => {
    let utilizationSeen: bigint | undefined;
    readContractMock.mockImplementation(async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (functionName === "getUtilization") return 777n;
      if (functionName === "getSupplyRate") {
        utilizationSeen = args?.[0] as bigint;
        return 0n;
      }
      throw new Error("função inesperada");
    });
    await readCompoundSupplyApy();
    expect(utilizationSeen).toBe(777n);
  });

  it("supplyRate zero vira 0 bps", async () => {
    mockUtilizationAndSupplyRate(0n);
    const reading = await readCompoundSupplyApy();
    expect(reading.supplyApyBps).toBe(0);
  });

  it("cacheia por TTL — duas chamadas seguidas não dobram as leituras on-chain", async () => {
    mockUtilizationAndSupplyRate(1000n);
    await readCompoundSupplyApy();
    const callsAfterFirst = readContractMock.mock.calls.length;
    await readCompoundSupplyApy();
    expect(readContractMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("propaga erro se a leitura on-chain falhar", async () => {
    readContractMock.mockRejectedValue(new Error("RPC Request failed."));
    await expect(readCompoundSupplyApy()).rejects.toThrow("RPC Request failed.");
  });
});
