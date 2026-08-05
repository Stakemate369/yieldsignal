import { describe, expect, it } from "vitest";
import { computeSensitivity } from "../src/signal/sensitivity.js";
import type { BorrowRateCurve } from "../src/market-data/rateCurve.js";
import type { MarketLiquidity, ProtocolId, RateReading } from "../src/market-data/types.js";

function reading(protocol: ProtocolId, utilizationBps?: number): RateReading {
  const liquidity: MarketLiquidity | undefined =
    utilizationBps === undefined
      ? undefined
      : { utilizationBps, availableLiquidityUsd: 1_000, totalSuppliedUsd: 10_000 };
  return {
    protocol,
    asset: "USDC",
    supplyApyBps: 400,
    apyBaseBps: 400,
    apyRewardBps: 0,
    rewardBasis: "reported",
    tvlUsd: 10_000,
    tvlBasis: "total-supplied",
    source: "onchain",
    ...(liquidity ? { liquidity } : {}),
    readAt: new Date("2026-08-05T12:00:00.000Z"),
  };
}

const curve = (protocol: "aave" | "compound", kinkBps = 9_000): BorrowRateCurve => ({
  protocol,
  kinkBps,
  rateAtZero: 0,
  rateAtKink: 0.045,
  rateAtFull: 0.145,
  perSecond: false,
  basis: protocol === "compound" ? "onchain-rate-function" : "onchain-curve-params",
});

describe("computeSensitivity", () => {
  it("mede folga até o joelho", () => {
    const r = computeSensitivity("USDC", [reading("aave", 8_610)], new Map([["aave", curve("aave")]]));
    const e = r.entries[0]!;
    expect(e.measured).toBe(true);
    expect(e.kinkBps).toBe(9_000);
    expect(e.headroomBps).toBe(390);
    expect(e.pastKink).toBe(false);
    expect(r.tightestToKink).toEqual({ protocol: "aave", headroomBps: 390 });
  });

  // Passar do joelho é uma MEDIÇÃO, não erro: folga negativa é a leitura certa.
  it("reporta folga negativa quando o mercado já passou do joelho", () => {
    const r = computeSensitivity("USDC", [reading("compound", 9_400)], new Map([["compound", curve("compound")]]));
    expect(r.entries[0]!.headroomBps).toBe(-400);
    expect(r.entries[0]!.pastKink).toBe(true);
    expect(r.pastKink).toEqual(["compound"]);
    // Quem já passou não pode ser "o mais apertado": são situações distintas.
    expect(r.tightestToKink).toBeNull();
  });

  it("elege o de menor folga entre os que ainda estão abaixo do joelho", () => {
    const r = computeSensitivity(
      "USDC",
      [reading("aave", 8_000), reading("compound", 8_983)],
      new Map([
        ["aave", curve("aave")],
        ["compound", curve("compound")],
      ]),
    );
    expect(r.tightestToKink).toEqual({ protocol: "compound", headroomBps: 17 });
  });

  // Guarda central contra alarme falso, igual às outras rotas: sem curva não há
  // afirmação nenhuma — e "não medido" jamais pode ser lido como "estável".
  it("sem curva, não afirma nada sobre o protocolo", () => {
    const r = computeSensitivity(
      "USDC",
      [reading("morpho", 9_500), reading("aave", 8_000)],
      new Map([
        ["morpho", undefined],
        ["aave", curve("aave")],
      ]),
    );
    const morpho = r.entries.find((e) => e.protocol === "morpho")!;
    expect(morpho.measured).toBe(false);
    expect(morpho.kinkBps).toBeNull();
    expect(morpho.headroomBps).toBeNull();
    expect(morpho.pastKink).toBeNull();
    expect(morpho.curve).toBeNull();
    expect(r.unmeasured).toEqual(["morpho"]);
    // Utilização alta sem curva NÃO entra em pastKink.
    expect(r.pastKink).toEqual([]);
    expect(r.tightestToKink).toEqual({ protocol: "aave", headroomBps: 1_000 });
  });

  it("com curva mas sem utilização, também não afirma", () => {
    const r = computeSensitivity("USDC", [reading("aave")], new Map([["aave", curve("aave")]]));
    expect(r.entries[0]!.measured).toBe(false);
    expect(r.entries[0]!.headroomBps).toBeNull();
    // O joelho em si é conhecido e continua sendo reportado — é dado lido.
    expect(r.entries[0]!.kinkBps).toBe(9_000);
    expect(r.coverage).toEqual({ measured: 0, total: 1 });
  });

  it("quantifica o multiplicador do choque logo depois do joelho", () => {
    const r = computeSensitivity("USDC", [reading("compound", 8_983)], new Map([["compound", curve("compound")]]));
    const e = r.entries[0]!;
    expect(e.shockMultiple).not.toBeNull();
    // Da taxa quase no joelho até 3 pontos acima, o custo tem que MULTIPLICAR.
    expect(e.shockMultiple!).toBeGreaterThan(1.5);
    expect(e.borrowApyBpsNow!).toBeLessThan(e.borrowApyBpsAtKink! + 1);
  });

  it("devolve a curva em pontos ao redor do joelho, em ordem crescente", () => {
    const r = computeSensitivity("USDC", [reading("aave", 8_000)], new Map([["aave", curve("aave")]]));
    const pontos = r.entries[0]!.curve!;
    expect(pontos.length).toBeGreaterThanOrEqual(4);
    expect(pontos.map((p) => p.utilizationBps)).toEqual([...pontos.map((p) => p.utilizationBps)].sort((a, b) => a - b));
    expect(pontos.filter((p) => p.isKink)).toHaveLength(1);
    // A curva tem que ser monotônica: mais utilização nunca custa menos.
    for (let i = 1; i < pontos.length; i++) {
      expect(pontos[i]!.borrowApyBps).toBeGreaterThanOrEqual(pontos[i - 1]!.borrowApyBps);
    }
  });

  it("ordena medidos primeiro e por menor folga", () => {
    const r = computeSensitivity(
      "USDC",
      [reading("fluid", 9_900), reading("aave", 8_000), reading("compound", 8_900)],
      new Map<ProtocolId, BorrowRateCurve | undefined>([
        ["fluid", undefined],
        ["aave", curve("aave")],
        ["compound", curve("compound")],
      ]),
    );
    expect(r.entries.map((e) => e.protocol)).toEqual(["compound", "aave", "fluid"]);
    expect(r.coverage).toEqual({ measured: 2, total: 3 });
  });

  it("sem leituras, não inventa manchete", () => {
    const r = computeSensitivity("USDC", [], new Map());
    expect(r.tightestToKink).toBeNull();
    expect(r.coverage).toEqual({ measured: 0, total: 0 });
  });
});
