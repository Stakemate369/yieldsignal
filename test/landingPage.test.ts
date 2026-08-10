import { describe, it, expect } from "vitest";
import { renderLandingPage, rankAssetsByAccuracy } from "../src/landingPage.js";
import type { AccuracyScore, AccuracyBreakdown } from "../src/attestation/accuracyScore.js";
import { FLAGSHIP_ASSET } from "../src/market-data/types.js";

function breakdown(over: Partial<AccuracyBreakdown> & { asset: AccuracyBreakdown["asset"] }): AccuracyBreakdown {
  return {
    scored: 10,
    stillBest: 5,
    hitRate: 0.5,
    regretScored: 10,
    withinTolerance: 5,
    withinToleranceRate: 0.5,
    avgRegretBps: 20,
    ...over,
  };
}

function score(perAsset: AccuracyBreakdown[]): AccuracyScore {
  return {
    basis: "directional-vs-current-market",
    scored: 100,
    stillBest: 50,
    indeterminate: 0,
    hitRate: 0.5,
    toleranceBps: 25,
    regretScored: 100,
    withinTolerance: 52,
    withinToleranceRate: 0.52,
    avgRegretBps: 48,
    avgGapBpsAtAttestation: 81,
    perAsset,
    computedAt: "2026-07-29T21:49:20.109Z",
  };
}

describe("rankAssetsByAccuracy", () => {
  it("ordena pelo within-tolerance (métrica justa), do mais forte pro mais fraco", () => {
    const ranked = rankAssetsByAccuracy(
      score([
        breakdown({ asset: "USDC", withinToleranceRate: 0.377, avgRegretBps: 62 }),
        breakdown({ asset: "ETH_STAKING", withinToleranceRate: 1, avgRegretBps: 1 }),
        breakdown({ asset: "WETH", withinToleranceRate: 0.8, avgRegretBps: 5 }),
      ]),
    );
    expect(ranked.map((r) => r.asset)).toEqual(["ETH_STAKING", "WETH", "USDC"]);
  });

  it("desempata por tamanho de amostra (afirmação mais sustentada primeiro)", () => {
    const ranked = rankAssetsByAccuracy(
      score([
        breakdown({ asset: "WETH", withinToleranceRate: 1, regretScored: 3 }),
        breakdown({ asset: "ETH_STAKING", withinToleranceRate: 1, regretScored: 40 }),
      ]),
    );
    expect(ranked.map((r) => r.asset)).toEqual(["ETH_STAKING", "WETH"]);
  });

  it("cai pro hitRate quando o within-tolerance não é apurável", () => {
    const ranked = rankAssetsByAccuracy(
      score([
        breakdown({ asset: "USDC", withinToleranceRate: null, hitRate: 0.9, regretScored: 0, scored: 5 }),
        breakdown({ asset: "WETH", withinToleranceRate: 0.1, hitRate: 0.1 }),
      ]),
    );
    expect(ranked[0].asset).toBe("USDC");
  });

  it("descarta asset sem amostra nenhuma", () => {
    const ranked = rankAssetsByAccuracy(
      score([breakdown({ asset: "USDC", scored: 0, regretScored: 0 }), breakdown({ asset: "WETH" })]),
    );
    expect(ranked.map((r) => r.asset)).toEqual(["WETH"]);
  });
});

describe("renderLandingPage", () => {
  const params = { signalPrice: "$0.01", analyticsPrice: "$0.25", decisionPrice: "$0.05", persistencePrice: "$1.00" };

  it("renderiza a tabela com os números vindos do score, não hardcoded", () => {
    const html = renderLandingPage({
      ...params,
      score: score([
        breakdown({ asset: "USDC", withinToleranceRate: 0.377, avgRegretBps: 62, regretScored: 77 }),
        breakdown({ asset: "ETH_STAKING", withinToleranceRate: 1, avgRegretBps: 1, regretScored: 12 }),
      ]),
    });
    expect(html).toContain("38%"); // 0.377 arredondado
    expect(html).toContain("62 bps");
    expect(html).toContain("Strongest verified record right now");
    // O mais forte aparece antes do mais fraco no HTML.
    expect(html.indexOf("ETH_STAKING")).toBeLessThan(html.indexOf(">USDC<") >= 0 ? html.indexOf(">USDC<") : html.length);
  });

  it("usa os preços recebidos (sem preço escrito à mão que desatualiza)", () => {
    const html = renderLandingPage({ score: null, signalPrice: "$0.02", analyticsPrice: "$0.25", decisionPrice: "$0.10", persistencePrice: "$1.00" });
    expect(html).toContain("$0.02/call signal");
    expect(html).toContain("$0.10/call decision");
  });

  it("omite a tabela e NÃO inventa número quando o score não pôde ser lido", () => {
    const html = renderLandingPage({ ...params, score: null });
    expect(html).toContain("/accuracy.json");
    expect(html).not.toContain("Within 25bps of the leader");
    expect(html).not.toContain("Strongest verified record");
  });

  it("degrada igual com score presente mas sem nenhum asset apurado", () => {
    const html = renderLandingPage({ ...params, score: score([]) });
    expect(html).not.toContain("Strongest verified record");
  });

  it("mostra a coluna de tempo mediano no topo quando a métrica por janela chega", () => {
    const html = renderLandingPage({
      ...params,
      score: score([breakdown({ asset: "USDC", withinToleranceRate: 0.4, avgRegretBps: 94, regretScored: 78 })]),
      windowed: {
        basis: "held-through-own-validity-window",
        closedWindows: 77,
        held: 18,
        heldRate: 0.23,
        timeWeightedHeldRate: 0.2,
        medianWindowHours: 1,
        openWindows: 1,
        perAsset: [
          {
            asset: "USDC",
            closedWindows: 77,
            held: 18,
            heldRate: 0.23,
            timeWeightedHeldRate: 0.2,
            medianWindowHours: 1,
            totalWindowHours: 133,
          },
        ],
        computedAt: "2026-07-30T18:00:00.000Z",
      },
    });
    expect(html).toContain("Median time on top");
    expect(html).toContain("1h");
  });

  // A página é o cartão de visita: uma métrica nova que falhe não pode tirar a
  // tabela do ar nem inventar um valor no lugar.
  it("sem a métrica por janela, a tabela continua completa e a coluna simplesmente some", () => {
    const html = renderLandingPage({
      ...params,
      score: score([breakdown({ asset: "USDC", withinToleranceRate: 0.4, avgRegretBps: 94, regretScored: 78 })]),
    });
    expect(html).toContain("94 bps");
    expect(html).not.toContain("Median time on top");
  });

  it("lidera com o asset de vitrine e cita os aliases sem asset", () => {
    const html = renderLandingPage({ ...params, score: null });
    expect(html).toContain("eth-staking-yield");
    expect(html.indexOf("eth-staking-yield")).toBeLessThan(html.indexOf("usdc-base-yield"));
    expect(html).toContain("redirect (308)");
    expect(FLAGSHIP_ASSET).toBe("ETH_STAKING");
  });
});

describe("renderLandingPage — escape de HTML", () => {
  it("neutraliza asset inesperado vindo de dado decodificado on-chain (defesa em profundidade)", () => {
    const hostil = breakdown({ asset: "<img src=x onerror=alert(1)>" as never, withinToleranceRate: 0.5 });
    const html = renderLandingPage({
      signalPrice: "$0.01",
      analyticsPrice: "$0.25",
      decisionPrice: "$0.05", persistencePrice: "$1.00",
      score: score([hostil]),
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});
