import { describe, it, expect } from "vitest";
import { computeAccuracyScore } from "../src/attestation/accuracyScore.js";
import type { TrackRecordEntry } from "../src/attestation/trackRecord.js";
import type { AssetId, ProtocolId } from "../src/market-data/types.js";

function entry(
  asset: AssetId,
  bestProtocol: ProtocolId,
  stillBest: boolean | null,
  gapBps = 30,
  // default: 0 bps de regret se ainda é o melhor, 50 bps (fora da tolerância)
  // se caiu, null se o mercado está ilegível — sobrescrevível pra testar a
  // métrica justa (ex.: um "não-melhor" ainda DENTRO da tolerância).
  regretBps: number | null = stillBest === null ? null : stillBest ? 0 : 50,
): TrackRecordEntry {
  const currentWeightedApyBps = stillBest === null ? null : 480;
  const currentBestWeightedApyBps = regretBps === null ? null : (currentWeightedApyBps ?? 480) + regretBps;
  return {
    uid: "0xabc" as `0x${string}`,
    asset,
    attestedAt: "2026-07-21T12:00:00.000Z",
    bestProtocolAtAttestation: bestProtocol,
    weightedApyBpsAtAttestation: 500,
    gapBpsAtAttestation: gapBps,
    currentWeightedApyBps,
    currentBestProtocol: stillBest === null ? null : stillBest ? bestProtocol : "compound",
    currentBestWeightedApyBps,
    regretBps,
    stillBest,
    easscanUrl: "https://base.easscan.org/attestation/view/0xabc",
  };
}

describe("computeAccuracyScore", () => {
  it("lista vazia: hitRate null, tudo zerado", () => {
    const s = computeAccuracyScore([]);
    expect(s.scored).toBe(0);
    expect(s.stillBest).toBe(0);
    expect(s.hitRate).toBeNull();
    expect(s.perAsset).toHaveLength(0);
    expect(s.basis).toBe("directional-vs-current-market");
  });

  it("hitRate = acertos / apurados", () => {
    const s = computeAccuracyScore([
      entry("USDC", "aave", true),
      entry("USDC", "morpho", true),
      entry("USDC", "aave", false),
      entry("USDC", "fluid", true),
    ]);
    expect(s.scored).toBe(4);
    expect(s.stillBest).toBe(3);
    expect(s.hitRate).toBeCloseTo(0.75, 5);
  });

  it("entradas indeterminadas (stillBest null) saem do denominador, não contam como erro", () => {
    const s = computeAccuracyScore([
      entry("USDC", "aave", true),
      entry("USDC", "aave", null), // mercado ilegível agora
      entry("USDC", "aave", null),
    ]);
    expect(s.scored).toBe(1); // só a determinada
    expect(s.stillBest).toBe(1);
    expect(s.indeterminate).toBe(2);
    expect(s.hitRate).toBe(1); // 1/1, as null não puniram
  });

  it("hitRate null quando TODAS as entradas são indeterminadas", () => {
    const s = computeAccuracyScore([entry("WETH", "aave", null), entry("WETH", "morpho", null)]);
    expect(s.scored).toBe(0);
    expect(s.indeterminate).toBe(2);
    expect(s.hitRate).toBeNull();
  });

  it("breakdown por asset com hitRate independente por asset", () => {
    const s = computeAccuracyScore([
      entry("USDC", "aave", true),
      entry("USDC", "aave", false),
      entry("WETH", "morpho", true),
      entry("ETH_STAKING", "lido", true),
    ]);
    const usdc = s.perAsset.find((p) => p.asset === "USDC");
    const weth = s.perAsset.find((p) => p.asset === "WETH");
    const staking = s.perAsset.find((p) => p.asset === "ETH_STAKING");
    expect(usdc).toMatchObject({ scored: 2, stillBest: 1, hitRate: 0.5 });
    expect(weth).toMatchObject({ scored: 1, stillBest: 1, hitRate: 1 });
    expect(staking).toMatchObject({ scored: 1, stillBest: 1, hitRate: 1 });
  });

  it("asset só com entradas indeterminadas aparece com scored 0 e hitRate null", () => {
    const s = computeAccuracyScore([entry("USDC", "aave", true), entry("WETH", "morpho", null)]);
    const weth = s.perAsset.find((p) => p.asset === "WETH");
    expect(weth).toMatchObject({ scored: 0, stillBest: 0, hitRate: null });
  });

  it("avgGapBpsAtAttestation é a média dos gaps de TODAS as entradas (inclui indeterminadas)", () => {
    const s = computeAccuracyScore([
      entry("USDC", "aave", true, 20),
      entry("USDC", "aave", false, 40),
      entry("USDC", "aave", null, 60),
    ]);
    expect(s.avgGapBpsAtAttestation).toBe(40); // (20+40+60)/3
  });

  it("métrica JUSTA: um 'não-melhor' DENTRO da tolerância conta como acerto, ao contrário do stillBest binário", () => {
    const s = computeAccuracyScore([
      entry("USDC", "aave", true, 30, 0), // é o melhor
      entry("USDC", "morpho", false, 30, 10), // 10bps atrás — dentro da tolerância (25)
      entry("USDC", "compound", false, 30, 60), // 60bps atrás — fora
    ]);
    // stillBest cru pune os dois "false": hitRate 1/3
    expect(s.hitRate).toBeCloseTo(1 / 3, 5);
    // métrica justa: 2 dos 3 estão a <=25bps do líder
    expect(s.toleranceBps).toBe(25);
    expect(s.regretScored).toBe(3);
    expect(s.withinTolerance).toBe(2);
    expect(s.withinToleranceRate).toBeCloseTo(2 / 3, 5);
    expect(s.avgRegretBps).toBe(23); // round((0+10+60)/3)
  });

  it("regret indeterminado (regretBps null) sai do denominador de withinTolerance", () => {
    const s = computeAccuracyScore([
      entry("USDC", "aave", true, 30, 0),
      entry("USDC", "aave", null, 30, null), // mercado ilegível: regret null
    ]);
    expect(s.regretScored).toBe(1); // só a apurável
    expect(s.withinTolerance).toBe(1);
    expect(s.withinToleranceRate).toBe(1);
    expect(s.avgRegretBps).toBe(0);
  });

  it("sem nenhuma entrada apurável: métricas de regret são null/0", () => {
    const s = computeAccuracyScore([entry("USDC", "aave", null, 30, null)]);
    expect(s.regretScored).toBe(0);
    expect(s.withinTolerance).toBe(0);
    expect(s.withinToleranceRate).toBeNull();
    expect(s.avgRegretBps).toBeNull();
  });

  it("breakdown por asset carrega as métricas de regret independentes", () => {
    const s = computeAccuracyScore([
      entry("USDC", "aave", false, 30, 10), // dentro
      entry("USDC", "aave", false, 30, 40), // fora
      entry("WETH", "morpho", true, 30, 0),
    ]);
    const usdc = s.perAsset.find((p) => p.asset === "USDC");
    const weth = s.perAsset.find((p) => p.asset === "WETH");
    expect(usdc).toMatchObject({ regretScored: 2, withinTolerance: 1, avgRegretBps: 25 });
    expect(usdc?.withinToleranceRate).toBeCloseTo(0.5, 5);
    expect(weth).toMatchObject({ regretScored: 1, withinTolerance: 1, avgRegretBps: 0, withinToleranceRate: 1 });
  });
});
