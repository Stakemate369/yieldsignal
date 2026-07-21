import { describe, it, expect } from "vitest";
import { computeAccuracyScore } from "../src/attestation/accuracyScore.js";
import type { TrackRecordEntry } from "../src/attestation/trackRecord.js";
import type { AssetId, ProtocolId } from "../src/market-data/types.js";

function entry(
  asset: AssetId,
  bestProtocol: ProtocolId,
  stillBest: boolean | null,
  gapBps = 30,
): TrackRecordEntry {
  return {
    uid: "0xabc" as `0x${string}`,
    asset,
    attestedAt: "2026-07-21T12:00:00.000Z",
    bestProtocolAtAttestation: bestProtocol,
    weightedApyBpsAtAttestation: 500,
    gapBpsAtAttestation: gapBps,
    currentWeightedApyBps: stillBest === null ? null : 480,
    currentBestProtocol: stillBest === null ? null : stillBest ? bestProtocol : "compound",
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
});
