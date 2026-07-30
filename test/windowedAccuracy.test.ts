import { describe, it, expect } from "vitest";
import { buildWindows, computeWindowedAccuracy } from "../src/attestation/windowedAccuracy.js";
import type { DecodedSignalAttestation } from "../src/attestation/queryAttestations.js";

const HOUR = 3600;
const T0 = 1_753_000_000; // instante unix arbitrário e fixo — nada aqui depende do relógio real

function att(overrides: Partial<DecodedSignalAttestation> & { time: number }): DecodedSignalAttestation {
  return {
    uid: `0x${overrides.time.toString(16).padStart(64, "0")}` as `0x${string}`,
    attester: "0x561143BFE9E2D975D92e915B8EfFEAa54119472a",
    asset: "USDC",
    bestProtocol: "aave",
    weightedApyBps: 500,
    gapBps: 40,
    asOf: overrides.time,
    // Campos do schema v2: as atestações já gravadas são v1 e não os têm.
    runnerUpProtocol: null,
    runnerUpWeightedApyBps: null,
    coverage: null,
    ...overrides,
  };
}

describe("buildWindows", () => {
  it("a última atestação de cada asset fica sem janela — vigência em aberto não é pontuável", () => {
    const windows = buildWindows([att({ time: T0 }), att({ time: T0 + HOUR })]);
    expect(windows).toHaveLength(1);
    expect(windows[0].windowEndsAt).toBe(new Date((T0 + HOUR) * 1000).toISOString());
  });

  it("marca held quando a atestação seguinte ainda aponta o mesmo protocolo", () => {
    const windows = buildWindows([
      att({ time: T0, bestProtocol: "aave" }),
      att({ time: T0 + 6 * HOUR, bestProtocol: "aave" }),
    ]);
    expect(windows[0].heldToWindowEnd).toBe(true);
    expect(windows[0].supersededBy).toBeNull();
    expect(windows[0].windowHours).toBe(6);
  });

  it("marca substituição quando a seguinte aponta outro protocolo", () => {
    const windows = buildWindows([
      att({ time: T0, bestProtocol: "aave" }),
      att({ time: T0 + HOUR, bestProtocol: "compound" }),
    ]);
    expect(windows[0].heldToWindowEnd).toBe(false);
    expect(windows[0].supersededBy).toBe("compound");
  });

  it("ordena por instante de mineração — 'a seguinte' não pode depender da ordem que a query devolveu", () => {
    const windows = buildWindows([
      att({ time: T0 + 2 * HOUR, bestProtocol: "compound" }),
      att({ time: T0, bestProtocol: "aave" }),
      att({ time: T0 + HOUR, bestProtocol: "aave" }),
    ]);
    expect(windows.map((w) => [w.bestProtocol, w.heldToWindowEnd])).toEqual([
      ["aave", true],
      ["aave", false],
    ]);
  });

  it("não cruza assets: a janela de um asset nunca fecha com a atestação de outro", () => {
    const windows = buildWindows([
      att({ time: T0, asset: "USDC", bestProtocol: "aave" }),
      att({ time: T0 + HOUR, asset: "WETH", bestProtocol: "moonwell" }),
    ]);
    expect(windows).toHaveLength(0);
  });
});

describe("computeWindowedAccuracy", () => {
  it("pondera por DURAÇÃO, não por contagem — é o que corrige a injustiça com o ativo volátil", () => {
    // 1 janela longa (10h) que se sustentou + 2 janelas curtas (1h cada) que não.
    const score = computeWindowedAccuracy([
      att({ time: T0, bestProtocol: "aave" }),
      att({ time: T0 + 10 * HOUR, bestProtocol: "aave" }),
      att({ time: T0 + 11 * HOUR, bestProtocol: "compound" }),
      att({ time: T0 + 12 * HOUR, bestProtocol: "morpho" }),
    ]);
    expect(score.closedWindows).toBe(3);
    expect(score.held).toBe(1);
    expect(score.heldRate).toBeCloseTo(1 / 3);
    // 10h de 12h passaram com a chamada de pé.
    expect(score.timeWeightedHeldRate).toBeCloseTo(10 / 12);
    expect(score.medianWindowHours).toBe(1);
  });

  it("separa por asset e conta uma janela em aberto por asset atestado", () => {
    const score = computeWindowedAccuracy([
      att({ time: T0, asset: "USDC", bestProtocol: "aave" }),
      att({ time: T0 + HOUR, asset: "USDC", bestProtocol: "compound" }),
      att({ time: T0, asset: "ETH_STAKING", bestProtocol: "lido" }),
      att({ time: T0 + 8 * HOUR, asset: "ETH_STAKING", bestProtocol: "lido" }),
    ]);
    expect(score.openWindows).toBe(2);
    const usdc = score.perAsset.find((p) => p.asset === "USDC");
    const staking = score.perAsset.find((p) => p.asset === "ETH_STAKING");
    expect(usdc?.heldRate).toBe(0);
    expect(staking?.heldRate).toBe(1);
    expect(staking?.timeWeightedHeldRate).toBe(1);
  });

  it("sem atestação nenhuma devolve score vazio em vez de dividir por zero", () => {
    const score = computeWindowedAccuracy([]);
    expect(score.closedWindows).toBe(0);
    expect(score.heldRate).toBeNull();
    expect(score.timeWeightedHeldRate).toBeNull();
    expect(score.medianWindowHours).toBeNull();
    expect(score.perAsset).toEqual([]);
  });

  it("janelas de duração zero não estouram a divisão do peso por tempo", () => {
    const score = computeWindowedAccuracy([
      att({ time: T0, bestProtocol: "aave" }),
      att({ time: T0, bestProtocol: "aave" }),
    ]);
    expect(score.closedWindows).toBe(1);
    expect(score.timeWeightedHeldRate).toBeNull();
    expect(score.heldRate).toBe(1);
  });
});
