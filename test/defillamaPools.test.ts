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
    const reading = await readDefiLlamaPoolApy("fluid", "USDC");
    expect(reading).not.toBeNull();
    expect(reading?.asset).toBe("USDC");
    expect(reading?.supplyApyBps).toBe(503);
    expect(reading?.source).toBe("defillama");
  });

  it("omite (retorna null) em vez de reportar 0% quando a DefiLlama devolve apy: null — bug real encontrado em revisão", async () => {
    mockPoolsResponse([{ ...FLUID_POOL, apy: null }]);
    const reading = await readDefiLlamaPoolApy("fluid", "USDC");
    expect(reading).toBeNull();
  });

  it("omite quando apy é NaN/não-finito", async () => {
    mockPoolsResponse([{ ...FLUID_POOL, apy: Number.NaN }]);
    const reading = await readDefiLlamaPoolApy("fluid", "USDC");
    expect(reading).toBeNull();
  });

  it("omite quando o TVL está abaixo do piso mínimo (pool possivelmente morto)", async () => {
    mockPoolsResponse([{ ...FLUID_POOL, tvlUsd: 10 }]);
    const reading = await readDefiLlamaPoolApy("fluid", "USDC");
    expect(reading).toBeNull();
  });

  it("omite quando o pool id bate mas project/chain/symbol não — checagem em dupla camada", async () => {
    mockPoolsResponse([{ ...FLUID_POOL, project: "outro-projeto-qualquer" }]);
    const reading = await readDefiLlamaPoolApy("fluid", "USDC");
    expect(reading).toBeNull();
  });

  it("omite (não lança) quando a API da DefiLlama responde erro", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const reading = await readDefiLlamaPoolApy("fluid", "USDC");
    expect(reading).toBeNull();
  });

  it("dispara só UMA chamada de fetch pras 3 leituras da Camada 2 em paralelo — regressão do bug de stampede", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [FLUID_POOL] }) });
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([
      readDefiLlamaPoolApy("fluid", "USDC"),
      readDefiLlamaPoolApy("fluid", "USDC"),
      readDefiLlamaPoolApy("fluid", "USDC"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pra WETH, casa symbol 'ETH' (não 'WETH') na Fluid — cada projeto lista o mesmo ativo diferente", async () => {
    const fluidWeth = { ...FLUID_POOL, pool: "c0b49fb8-d73c-42ec-8538-c2b3feb69242", symbol: "ETH", apy: 0.66 };
    mockPoolsResponse([fluidWeth]);
    const reading = await readDefiLlamaPoolApy("fluid", "WETH");
    expect(reading).not.toBeNull();
    expect(reading?.asset).toBe("WETH");
  });

  it("pra WETH, NÃO casa um pool com symbol 'WETH' na Fluid (ela lista como 'ETH', não 'WETH')", async () => {
    const wrongSymbol = { ...FLUID_POOL, pool: "c0b49fb8-d73c-42ec-8538-c2b3feb69242", symbol: "WETH", apy: 0.66 };
    mockPoolsResponse([wrongSymbol]);
    const reading = await readDefiLlamaPoolApy("fluid", "WETH");
    expect(reading).toBeNull();
  });

  // Bug real (2026-07-30): o pool da Euler que o serviço lê pra USDC reportava
  // apy 0 com TVL de $463k — acima do piso —, e o guarda antigo só barrava
  // null/NaN. Toda resposta de USDC anunciava cobertura 6/6 carregando um
  // protocolo mudo. Mercado de lending vivo não paga 0,00%.
  it("omite quando a APY total é zero — pool mudo/morto não vira leitura de 0%", async () => {
    mockPoolsResponse([{ ...FLUID_POOL, apy: 0, apyBase: 0, apyReward: null }]);
    const reading = await readDefiLlamaPoolApy("fluid", "USDC");
    expect(reading).toBeNull();
  });

  it("soma juro base e incentivo em vez de confiar no agregado, e itemiza os dois", async () => {
    mockPoolsResponse([{ ...FLUID_POOL, apy: 4.02, apyBase: 4.02, apyReward: 0.31 }]);
    const reading = await readDefiLlamaPoolApy("fluid", "USDC");
    expect(reading?.supplyApyBps).toBe(433);
    expect(reading?.apyBaseBps).toBe(402);
    expect(reading?.apyRewardBps).toBe(31);
    expect(reading?.rewardBasis).toBe("reported");
  });

  it("cai no agregado quando a fonte não traz nenhum componente — e marca que não dá pra itemizar", async () => {
    mockPoolsResponse([{ ...FLUID_POOL, apy: 5.03, apyBase: null, apyReward: null }]);
    const reading = await readDefiLlamaPoolApy("fluid", "USDC");
    expect(reading?.supplyApyBps).toBe(503);
    expect(reading?.apyBaseBps).toBeNull();
    expect(reading?.rewardBasis).toBe("included-not-itemized");
  });

  it("usa os componentes mesmo quando o agregado está quebrado (apy: 0 com apyBase preenchido) — visto ao vivo na compound-v3", async () => {
    mockPoolsResponse([{ ...FLUID_POOL, apy: 0, apyBase: 1.22, apyReward: 0 }]);
    const reading = await readDefiLlamaPoolApy("fluid", "USDC");
    expect(reading?.supplyApyBps).toBe(122);
  });
});
