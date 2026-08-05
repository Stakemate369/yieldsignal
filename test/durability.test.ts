import { describe, expect, it } from "vitest";
import { computeDurability } from "../src/signal/durability.js";
import type { RateReading } from "../src/market-data/types.js";

function reading(
  protocol: RateReading["protocol"],
  supplyApyBps: number,
  apyBaseBps: number | null,
  rewardBasis: RateReading["rewardBasis"] = "reported",
): RateReading {
  return {
    protocol,
    asset: "USDC",
    supplyApyBps,
    apyBaseBps,
    apyRewardBps: apyBaseBps === null ? null : supplyApyBps - apyBaseBps,
    rewardBasis,
    tvlUsd: 5_000_000,
    tvlBasis: "total-supplied",
    source: "onchain",
    readAt: new Date("2026-08-05T12:00:00.000Z"),
  };
}

describe("computeDurability", () => {
  it("usa o juro base como piso pós-incentivo", () => {
    const r = computeDurability("USDC", [reading("aave", 500, 200)]);
    expect(r.entries[0]!.postIncentiveApyBps).toBe(200);
    expect(r.entries[0]!.incentiveSharePct).toBe(60);
    expect(r.entries[0]!.decomposable).toBe(true);
  });

  it("detecta troca de líder quando o incentivo cai", () => {
    // aave lidera hoje (500) mas é quase todo incentivo; compound (450) é base.
    const r = computeDurability("USDC", [reading("aave", 500, 100), reading("compound", 450, 450)]);
    expect(r.bestProtocolNow).toBe("aave");
    expect(r.bestProtocolPostIncentive).toBe("compound");
    expect(r.rankingChangesWithoutIncentives).toBe(true);
  });

  it("afirma que o ranking NÃO muda quando o líder resiste", () => {
    const r = computeDurability("USDC", [reading("aave", 500, 480), reading("compound", 450, 100)]);
    expect(r.rankingChangesWithoutIncentives).toBe(false);
    expect(r.comparability.comparable).toBe(true);
  });

  // A guarda central contra alarme falso: sem saber o piso do líder, nenhuma
  // afirmação de ranking é emitida — nem "muda" nem "não muda".
  it("não afirma nada quando o LÍDER não é decomponível", () => {
    const r = computeDurability("USDC", [
      reading("morpho", 600, null, "included-not-itemized"),
      reading("compound", 450, 450),
      reading("aave", 400, 400),
    ]);
    expect(r.bestProtocolNow).toBe("morpho");
    expect(r.rankingChangesWithoutIncentives).toBeNull();
    expect(r.bestProtocolPostIncentive).toBeNull();
    expect(r.comparability.comparable).toBe(false);
    expect(r.comparability.reason).toContain("morpho");
    // Mesmo sem poder falar do ranking, o melhor piso PROVÁVEL continua sendo
    // uma afirmação medida e entregável — é o que salva a resposta de ser vazia.
    expect(r.bestVerifiableFloor).toEqual({ protocol: "compound", apyBps: 450 });
  });

  it("sem nenhum decomponível, não inventa piso verificável", () => {
    const r = computeDurability("USDC", [reading("morpho", 600, null, "included-not-itemized")]);
    expect(r.bestVerifiableFloor).toBeNull();
  });

  it("não afirma ranking com menos de dois decomponíveis", () => {
    const r = computeDurability("USDC", [
      reading("aave", 500, 500),
      reading("morpho", 400, null, "included-not-itemized"),
    ]);
    expect(r.rankingChangesWithoutIncentives).toBeNull();
    expect(r.comparability.reason).toContain("fewer than two");
  });

  // "não sei" nunca pode virar "sabidamente sem incentivo" — a diferença entre
  // as duas é o que separa este relatório de um chute com cara de precisão.
  it("trata rewardBasis unavailable como não decomponível, não como zero incentivo", () => {
    const r = computeDurability("USDC", [reading("euler", 300, 300, "unavailable")]);
    expect(r.entries[0]!.decomposable).toBe(false);
    expect(r.entries[0]!.postIncentiveApyBps).toBeNull();
    expect(r.entries[0]!.incentiveSharePct).toBeNull();
    expect(r.undecomposable).toEqual([{ protocol: "euler", rewardBasis: "unavailable" }]);
  });

  it("reporta cobertura e ordena por APY atual", () => {
    const r = computeDurability("USDC", [
      reading("aave", 300, 300),
      reading("compound", 700, 500),
      reading("morpho", 500, null, "included-not-itemized"),
    ]);
    expect(r.entries.map((e) => e.protocol)).toEqual(["compound", "morpho", "aave"]);
    expect(r.coverage).toEqual({ decomposable: 2, total: 3 });
  });

  it("sem leituras, não inventa líder", () => {
    const r = computeDurability("USDC", []);
    expect(r.bestProtocolNow).toBeNull();
    expect(r.rankingChangesWithoutIncentives).toBeNull();
    expect(r.coverage).toEqual({ decomposable: 0, total: 0 });
  });
});
