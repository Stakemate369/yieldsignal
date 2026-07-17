import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { readDefiLlamaPoolApy as ReadDefiLlamaPoolApy } from "../src/market-data/defillamaPools.js";

const FLUID_POOL = {
  pool: "7372edda-f07f-4598-83e5-4edec48c4039",
  project: "fluid-lending",
  chain: "Base",
  symbol: "USDC",
  apy: 5.03,
  tvlUsd: 8_764_590,
};

function mockPoolsResponse(pools: unknown[]): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: pools }) }));
}

// Módulo tem cache/inFlight em escopo de módulo — cada teste precisa de uma
// instância nova (vi.resetModules + import dinâmico), senão o cache de um
// teste vaza pro próximo e os cenários de erro nunca são de fato exercitados.
let readDefiLlamaPoolApy: typeof ReadDefiLlamaPoolApy;

beforeEach(async () => {
  vi.resetModules();
  ({ readDefiLlamaPoolApy } = await import("../src/market-data/defillamaPools.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readDefiLlamaPoolApy", () => {
  it("retorna a leitura normalmente quando o pool bate poolId+project+chain+symbol", async () => {
    mockPoolsResponse([FLUID_POOL]);
    const reading = await readDefiLlamaPoolApy("fluid");
    expect(reading).not.toBeNull();
    expect(reading?.supplyApyBps).toBe(503);
    expect(reading?.source).toBe("defillama");
  });

  it("omite (retorna null) em vez de reportar 0% quando a DefiLlama devolve apy: null — bug real encontrado em revisão", async () => {
    mockPoolsResponse([{ ...FLUID_POOL, apy: null }]);
    const reading = await readDefiLlamaPoolApy("fluid");
    expect(reading).toBeNull();
  });

  it("omite quando apy é NaN/não-finito", async () => {
    mockPoolsResponse([{ ...FLUID_POOL, apy: Number.NaN }]);
    const reading = await readDefiLlamaPoolApy("fluid");
    expect(reading).toBeNull();
  });

  it("omite quando o TVL está abaixo do piso mínimo (pool possivelmente morto)", async () => {
    mockPoolsResponse([{ ...FLUID_POOL, tvlUsd: 10 }]);
    const reading = await readDefiLlamaPoolApy("fluid");
    expect(reading).toBeNull();
  });

  it("omite quando o pool id bate mas project/chain/symbol não — checagem em dupla camada", async () => {
    mockPoolsResponse([{ ...FLUID_POOL, project: "outro-projeto-qualquer" }]);
    const reading = await readDefiLlamaPoolApy("fluid");
    expect(reading).toBeNull();
  });

  it("omite (não lança) quando a API da DefiLlama responde erro", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const reading = await readDefiLlamaPoolApy("fluid");
    expect(reading).toBeNull();
  });

  it("dispara só UMA chamada de fetch pras 3 leituras da Camada 2 em paralelo — regressão do bug de stampede", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [FLUID_POOL] }) });
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([readDefiLlamaPoolApy("fluid"), readDefiLlamaPoolApy("fluid"), readDefiLlamaPoolApy("fluid")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
