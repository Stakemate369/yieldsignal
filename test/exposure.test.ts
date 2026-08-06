import { describe, expect, it } from "vitest";
import { computeExposure, type ProtocolExposure } from "../src/signal/exposure.js";
import type { ProtocolId } from "../src/market-data/types.js";

const morpho: ProtocolExposure = {
  protocol: "morpho",
  factors: [
    { kind: "collateral", key: "cbBTC", share: 0.937, basis: "isolated-market" },
    { kind: "collateral", key: "WETH", share: 0.063, basis: "isolated-market" },
    { kind: "curator", key: "0xgauntlet", share: 1, basis: "isolated-market" },
  ],
  parameters: [],
  unattributedReason: null,
};

const compound: ProtocolExposure = {
  protocol: "compound",
  factors: [
    { kind: "collateral", key: "cbBTC", share: 0.431, basis: "collateral-basket" },
    { kind: "collateral", key: "WETH", share: 0.569, basis: "collateral-basket" },
  ],
  parameters: [{ kind: "rate-kink", key: "9000", share: 1, basis: "protocol-parameter" }],
  unattributedReason: null,
};

const aave: ProtocolExposure = {
  protocol: "aave",
  factors: null,
  parameters: [{ kind: "rate-kink", key: "9000", share: 1, basis: "protocol-parameter" }],
  unattributedReason: "pooled-collateral: exposed to the entire pool",
};

const map = (...xs: ProtocolExposure[]) => new Map<ProtocolId, ProtocolExposure>(xs.map((x) => [x.protocol, x]));

describe("computeExposure", () => {
  it("soma o mesmo colateral que chega por venues diferentes", () => {
    const r = computeExposure(
      "USDC",
      [
        { protocol: "morpho", usd: 100_000 },
        { protocol: "compound", usd: 100_000 },
      ],
      map(morpho, compound),
    );
    const cbBTC = r.factors.find((f) => f.key === "cbBTC")!;
    // 0,937*100k + 0,431*100k = 136,8k de 200k atribuidos
    expect(cbBTC.usd).toBe(136_800);
    expect(cbBTC.pctOfAttributed).toBe(68.4);
    expect(cbBTC.sharedAcrossVenues).toBe(true);
    expect(cbBTC.via.sort()).toEqual(["compound", "morpho"]);
    expect(cbBTC.bases.sort()).toEqual(["collateral-basket", "isolated-market"]);
  });

  /**
   * A armadilha de contabilidade que motivou separar `parameters` de `factors`:
   * a Aave não tem composição legível mas tem joelho legível. Se o joelho
   * entrasse como fator, a posição contaria como atribuída e diluiria os
   * percentuais de colateral — escondendo justamente o que precisa aparecer.
   */
  it("posição sem composição não entra no denominador dos percentuais", () => {
    const r = computeExposure(
      "USDC",
      [
        { protocol: "morpho", usd: 100_000 },
        { protocol: "aave", usd: 900_000 },
      ],
      map(morpho, aave),
    );
    expect(r.coverage).toEqual({ attributedUsd: 100_000, totalUsd: 1_000_000 });
    expect(r.unattributed).toEqual([
      { protocol: "aave", usd: 900_000, reason: "pooled-collateral: exposed to the entire pool" },
    ]);
    // 93,7% do que foi atribuído — não 9,37% do total.
    expect(r.factors.find((f) => f.key === "cbBTC")!.pctOfAttributed).toBe(93.7);
  });

  it("conta o parâmetro do protocolo mesmo quando a composição é desconhecida", () => {
    const r = computeExposure(
      "USDC",
      [
        { protocol: "aave", usd: 200_000 },
        { protocol: "compound", usd: 50_000 },
      ],
      map(aave, compound),
    );
    const kink = r.sharedParameters.find((f) => f.kind === "rate-kink")!;
    expect(kink.usd).toBe(250_000);
    expect(kink.pctOfAttributed).toBe(100);
    expect(kink.sharedAcrossVenues).toBe(true);
    expect(kink.via.sort()).toEqual(["aave", "compound"]);
  });

  // O joelho é compartilhado por desenho (Aave e Compound usam 90% os dois):
  // verdadeiro, mas inútil como manchete de concentração.
  it("a manchete ignora parâmetro e usa colateral/curador", () => {
    const r = computeExposure(
      "USDC",
      [
        { protocol: "morpho", usd: 100_000 },
        { protocol: "compound", usd: 100_000 },
      ],
      map(morpho, compound),
    );
    expect(r.topFactor!.kind).toBe("collateral");
    expect(r.topFactor!.key).toBe("cbBTC");
    expect(r.factors.some((f) => f.kind === "rate-kink")).toBe(false);
  });

  it("marca como não compartilhado o que chega por um venue só", () => {
    const r = computeExposure("USDC", [{ protocol: "morpho", usd: 100_000 }], map(morpho));
    expect(r.factors.find((f) => f.kind === "curator")!.sharedAcrossVenues).toBe(false);
  });

  it("protocolo sem entrada no mapa vira não atribuído com motivo genérico", () => {
    const r = computeExposure("USDC", [{ protocol: "fluid", usd: 50_000 }], new Map());
    expect(r.unattributed[0]!.protocol).toBe("fluid");
    expect(r.unattributed[0]!.reason).toContain("no factor data");
    expect(r.coverage.attributedUsd).toBe(0);
    expect(r.topFactor).toBeNull();
  });

  it("ignora posição inválida em vez de propagar NaN", () => {
    const r = computeExposure(
      "USDC",
      [
        { protocol: "morpho", usd: Number.NaN },
        { protocol: "compound", usd: -100 },
        { protocol: "morpho", usd: 100_000 },
      ],
      map(morpho, compound),
    );
    expect(r.totalUsd).toBe(100_000);
    expect(r.nominalVenues).toBe(1);
    expect(r.factors.every((f) => Number.isFinite(f.usd))).toBe(true);
  });

  it("sem posições, não inventa manchete", () => {
    const r = computeExposure("USDC", [], map(morpho));
    expect(r.topFactor).toBeNull();
    expect(r.totalUsd).toBe(0);
    expect(r.coverage).toEqual({ attributedUsd: 0, totalUsd: 0 });
  });

  it("ordena fatores por capital, maior primeiro", () => {
    const r = computeExposure(
      "USDC",
      [
        { protocol: "morpho", usd: 100_000 },
        { protocol: "compound", usd: 100_000 },
      ],
      map(morpho, compound),
    );
    const usds = r.factors.map((f) => f.usd);
    expect(usds).toEqual([...usds].sort((a, b) => b - a));
  });
});
