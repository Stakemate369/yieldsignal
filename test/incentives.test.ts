import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { readIncentiveComponent as ReadIncentiveComponent } from "../src/market-data/incentives.js";

/**
 * O componente de incentivo é o que torna as leituras COMPARÁVEIS entre si
 * (Aave/Compound on-chain trazem só juro base; Morpho e a Camada 2 já vêm com
 * reward embutido). Estes testes fixam as duas coisas que importam: a
 * inferência acontece quando deve, e — mais importante — ela NÃO acontece
 * quando inflaria a APY com rendimento inexistente.
 */

const AAVE_USDC_POOL = {
  pool: "7e0661bf-8cf3-45e6-9424-31916d4c7b84",
  project: "aave-v3",
  chain: "Base",
  symbol: "USDC",
  apy: 3.5,
  apyBase: 3.5,
  apyReward: null,
  tvlUsd: 21_000_000,
};

function mockPoolsResponse(pools: unknown[]): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: pools }) }));
}

let readIncentiveComponent: typeof ReadIncentiveComponent;

beforeEach(async () => {
  vi.resetModules();
  ({ readIncentiveComponent } = await import("../src/market-data/incentives.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readIncentiveComponent", () => {
  it("usa o apyReward informado pela fonte, inclusive quando é zero (0 = sabidamente sem campanha, ≠ desconhecido)", async () => {
    mockPoolsResponse([{ ...AAVE_USDC_POOL, apyReward: 0 }]);
    const incentive = await readIncentiveComponent("aave", "USDC", 350);
    expect(incentive).toEqual({ rewardBps: 0, basis: "reported" });
  });

  it("converte o apyReward informado pra bps", async () => {
    mockPoolsResponse([{ ...AAVE_USDC_POOL, apyBase: 3.5, apyReward: 1.25 }]);
    const incentive = await readIncentiveComponent("aave", "USDC", 350);
    expect(incentive).toEqual({ rewardBps: 125, basis: "reported" });
  });

  it("infere incentivo quando o agregado fica materialmente acima do juro base on-chain", async () => {
    // agregado 5,00% vs base on-chain 3,50% => 150 bps atribuídos a incentivo
    mockPoolsResponse([{ ...AAVE_USDC_POOL, apy: 5, apyBase: 5, apyReward: null }]);
    const incentive = await readIncentiveComponent("aave", "USDC", 350);
    expect(incentive).toEqual({ rewardBps: 150, basis: "inferred" });
  });

  it("agregado que NÃO supera o juro base vira incentivo zero, não desconhecido — o agregado já inclui reward por definição", async () => {
    mockPoolsResponse([{ ...AAVE_USDC_POOL, apy: 3.5, apyBase: 3.5, apyReward: null }]);
    const incentive = await readIncentiveComponent("aave", "USDC", 356);
    expect(incentive).toEqual({ rewardBps: 0, basis: "inferred" });
  });

  it("diferença dentro do ruído também vira zero (não há campanha material escondida ali)", async () => {
    mockPoolsResponse([{ ...AAVE_USDC_POOL, apy: 3.6, apyBase: 3.6, apyReward: null }]);
    const incentive = await readIncentiveComponent("aave", "USDC", 350);
    expect(incentive).toEqual({ rewardBps: 0, basis: "inferred" });
  });

  it("NÃO infere com juro base zerado — senão um RPC degenerado viraria APY inventada (bug pego por teste)", async () => {
    mockPoolsResponse([AAVE_USDC_POOL]);
    const incentive = await readIncentiveComponent("aave", "USDC", 0);
    expect(incentive).toEqual({ rewardBps: null, basis: "unavailable" });
  });

  it("NÃO infere quando a divergência passa do teto (metodologia diferente, não campanha)", async () => {
    // base on-chain 100 bps, agregado 500 bps => excedente 400 bps = 4x o base
    mockPoolsResponse([{ ...AAVE_USDC_POOL, apy: 5, apyBase: 5, apyReward: null }]);
    const incentive = await readIncentiveComponent("aave", "USDC", 100);
    expect(incentive).toEqual({ rewardBps: null, basis: "unavailable" });
  });

  it("degrada pra desconhecido (não lança) quando o pool de referência sumiu da fonte", async () => {
    mockPoolsResponse([{ ...AAVE_USDC_POOL, pool: "outro-uuid-qualquer" }]);
    const incentive = await readIncentiveComponent("aave", "USDC", 350);
    expect(incentive).toEqual({ rewardBps: null, basis: "unavailable" });
  });

  it("degrada pra desconhecido (não lança) quando a fonte falha — leitura on-chain não pode cair por causa de terceiro", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("rede fora")));
    const incentive = await readIncentiveComponent("compound", "WETH", 200);
    expect(incentive).toEqual({ rewardBps: null, basis: "unavailable" });
  });
});
