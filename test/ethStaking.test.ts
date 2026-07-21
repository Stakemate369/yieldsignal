import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { readEthStakingApy as ReadEthStakingApy, collectEthStakingRates as CollectEthStakingRates } from "../src/market-data/ethStaking.js";

const LIDO_POOL = {
  pool: "747c1d2a-c668-4682-b9f9-296708a3dd90",
  project: "lido",
  chain: "Ethereum",
  symbol: "STETH",
  apy: 2.207,
  tvlUsd: 17_440_637_822,
};

function mockPoolsResponse(pools: unknown[]): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: pools }) }));
}

// Mesma razão de defillamaPools.test.ts: módulo tem cache/inFlight em escopo
// de módulo, cada teste precisa de instância nova.
let readEthStakingApy: typeof ReadEthStakingApy;
let collectEthStakingRates: typeof CollectEthStakingRates;

beforeEach(async () => {
  vi.resetModules();
  ({ readEthStakingApy, collectEthStakingRates } = await import("../src/market-data/ethStaking.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readEthStakingApy", () => {
  it("retorna a leitura normalmente quando o pool bate poolId+project+chain+symbol", async () => {
    mockPoolsResponse([LIDO_POOL]);
    const reading = await readEthStakingApy("lido");
    expect(reading).not.toBeNull();
    expect(reading?.asset).toBe("ETH_STAKING");
    expect(reading?.protocol).toBe("lido");
    expect(reading?.supplyApyBps).toBe(221);
    expect(reading?.source).toBe("defillama");
  });

  it("omite (retorna null) quando a DefiLlama devolve apy: null", async () => {
    mockPoolsResponse([{ ...LIDO_POOL, apy: null }]);
    const reading = await readEthStakingApy("lido");
    expect(reading).toBeNull();
  });

  it("omite quando o TVL está abaixo do piso mínimo", async () => {
    mockPoolsResponse([{ ...LIDO_POOL, tvlUsd: 10 }]);
    const reading = await readEthStakingApy("lido");
    expect(reading).toBeNull();
  });

  it("omite quando o pool id bate mas chain não (staking é Ethereum mainnet, não Base)", async () => {
    mockPoolsResponse([{ ...LIDO_POOL, chain: "Base" }]);
    const reading = await readEthStakingApy("lido");
    expect(reading).toBeNull();
  });

  it("omite (não lança) quando a API da DefiLlama responde erro", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const reading = await readEthStakingApy("lido");
    expect(reading).toBeNull();
  });

  it("dispara só UMA chamada de fetch pras 5 leituras de staking em paralelo", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [LIDO_POOL] }) });
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([
      readEthStakingApy("lido"),
      readEthStakingApy("lido"),
      readEthStakingApy("lido"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("collectEthStakingRates", () => {
  it("junta as leituras de todos os protocolos que responderam", async () => {
    const pools = [
      LIDO_POOL,
      { pool: "d4b3c522-6127-4b89-bedf-83641cdcd2eb", project: "rocket-pool", chain: "Ethereum", symbol: "RETH", apy: 2.19, tvlUsd: 2_569_392_754 },
    ];
    mockPoolsResponse(pools);
    const readings = await collectEthStakingRates();
    const protocols = readings.map((r) => r.protocol).sort();
    expect(protocols).toEqual(["lido", "rocket-pool"]);
  });

  it("lança se nenhuma fonte respondeu", async () => {
    mockPoolsResponse([]);
    await expect(collectEthStakingRates()).rejects.toThrow(/todas as fontes/);
  });
});
