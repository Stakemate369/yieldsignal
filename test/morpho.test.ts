import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { readMorphoVaultApy as ReadMorphoVaultApy } from "../src/market-data/morpho.js";

function mockGraphqlResponse(netApy: number | null | undefined): void {
  const state = netApy === undefined ? {} : { netApy };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { vaultByAddress: { state } } }),
    }),
  );
}

// Módulo agora tem cache em escopo de módulo (30s) — cada teste precisa de
// uma instância nova (vi.resetModules + import dinâmico), senão o resultado
// de um teste vaza pro próximo, mesmo padrão de defillamaPools.test.ts.
let readMorphoVaultApy: typeof ReadMorphoVaultApy;

beforeEach(async () => {
  vi.resetModules();
  ({ readMorphoVaultApy } = await import("../src/market-data/morpho.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readMorphoVaultApy", () => {
  it("retorna a leitura normalmente com um netApy válido", async () => {
    mockGraphqlResponse(0.0427);
    const reading = await readMorphoVaultApy();
    expect(reading.supplyApyBps).toBe(427);
    expect(reading.source).toBe("api");
  });

  it("lança erro claro (não retorna 0%) quando netApy é null — bug real encontrado em revisão", async () => {
    mockGraphqlResponse(null);
    await expect(readMorphoVaultApy()).rejects.toThrow(/netApy válido/);
  });

  it("lança erro claro quando netApy está ausente (undefined)", async () => {
    mockGraphqlResponse(undefined);
    await expect(readMorphoVaultApy()).rejects.toThrow(/netApy válido/);
  });

  it("lança erro quando a API responde HTTP de erro", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(readMorphoVaultApy()).rejects.toThrow(/respondeu 500/);
  });

  it("lança erro quando a API responde com `errors`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ errors: [{ message: "vault not found" }] }) }),
    );
    await expect(readMorphoVaultApy()).rejects.toThrow(/vault not found/);
  });

  it("cacheia por TTL — duas chamadas seguidas fazem só 1 fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { vaultByAddress: { state: { netApy: 0.05 } } } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await readMorphoVaultApy();
    await readMorphoVaultApy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
