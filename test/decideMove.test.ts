import { describe, it, expect } from "vitest";
import { decideMove, confidenceFor, leadDependsOnIncentives } from "../src/signal/decideMove.js";
import type { MoveDecisionInput } from "../src/signal/decideMove.js";
import type { RateReading } from "../src/market-data/types.js";

function reading(
  protocol: RateReading["protocol"],
  supplyApyBps: number,
  source: RateReading["source"] = "onchain",
  asset: RateReading["asset"] = "USDC",
): RateReading {
  return { protocol, asset, supplyApyBps, apyBaseBps: supplyApyBps, apyRewardBps: 0, rewardBasis: "reported", tvlUsd: 5_000_000, source, readAt: new Date("2026-07-21T12:00:00.000Z") };
}

// Pesos de risco: aave 1.0, morpho 0.97, compound 0.99. Usados aqui pra
// prever o weightedApy nos asserts.
const baseInput: MoveDecisionInput = {
  currentProtocol: "aave",
  amountUsd: 10_000,
  moveCostUsd: 2,
  horizonDays: 30,
};

describe("decideMove", () => {
  it("HOLD quando o comprador já está no melhor protocolo", () => {
    // aave 500*1.0=500 é o melhor; comprador está na aave.
    const d = decideMove([reading("aave", 500), reading("compound", 400)], { ...baseInput, currentProtocol: "aave" });
    expect(d.action).toBe("HOLD");
    expect(d.to).toBe("aave");
    expect(d.reason).toMatch(/already in the best/i);
  });

  it("HOLD quando o melhor empata (ganho ajustado por risco == 0) com a posição atual", () => {
    // empate exato de weightedApy: compound 505*0.99=499.95->500, aave 500*1.0=500.
    // ambos 500; best = compound (primeiro do sort estável). comprador na aave.
    // netApyGain = 500-500 = 0 -> branch "igual ou mais", HOLD (não é "já está no melhor",
    // porque best != posição do comprador).
    const d = decideMove([reading("compound", 505), reading("aave", 500)], { ...baseInput, currentProtocol: "aave" });
    expect(d.action).toBe("HOLD");
    expect(d.to).toBe("compound");
    expect(d.netApyGainBps).toBe(0);
    expect(d.reason).toMatch(/same or more/i);
  });

  it("HOLD quando o ganho existe mas não cobre o custo de mover no horizonte", () => {
    // comprador em compound (300*0.99=297). melhor aave 320*1.0=320. gain=23bps.
    // $10k * 23bps = $23/ano -> em 30 dias ~$1.89 < custo $2 -> HOLD.
    const d = decideMove([reading("aave", 320), reading("compound", 300)], {
      currentProtocol: "compound",
      amountUsd: 10_000,
      moveCostUsd: 2,
      horizonDays: 30,
    });
    expect(d.action).toBe("HOLD");
    expect(d.netApyGainBps).toBeGreaterThan(0);
    expect(d.expectedNetGainUsd).toBeLessThanOrEqual(0);
    expect(d.reason).toMatch(/does not cover the move cost/i);
  });

  it("MOVE quando o ganho líquido no horizonte é positivo", () => {
    // comprador em compound (300*0.99=297). melhor aave 600*1.0=600. gain=303bps.
    // $10k * 303bps = $303/ano -> em 30 dias ~$24.9 - $2 custo = +$22.9 -> MOVE.
    const d = decideMove([reading("aave", 600), reading("compound", 300)], {
      currentProtocol: "compound",
      amountUsd: 10_000,
      moveCostUsd: 2,
      horizonDays: 30,
    });
    expect(d.action).toBe("MOVE");
    expect(d.from).toBe("compound");
    expect(d.to).toBe("aave");
    expect(d.expectedNetGainUsd).toBeGreaterThan(0);
    expect(d.breakEvenDays).not.toBeNull();
    expect(d.reason).toMatch(/yields \+/);
  });

  it("capital ocioso (currentProtocol null): ganho de referência é o APY inteiro do destino", () => {
    const d = decideMove([reading("aave", 500), reading("compound", 400)], {
      currentProtocol: null,
      amountUsd: 10_000,
      moveCostUsd: 1,
      horizonDays: 365,
    });
    expect(d.action).toBe("MOVE");
    expect(d.from).toBeNull();
    expect(d.to).toBe("aave");
    // netApyGain == weightedApy do melhor (aave 500*1.0=500)
    expect(d.netApyGainBps).toBe(500);
  });

  it("break-even é null quando não há ganho positivo", () => {
    const d = decideMove([reading("morpho", 510), reading("aave", 500)], { ...baseInput, currentProtocol: "aave" });
    expect(d.breakEvenDays).toBeNull();
  });

  it("posição ILEGÍVEL nesta chamada => HOLD conservador (não MOVE às cegas)", () => {
    // comprador diz estar em 'euler' mas só temos aave/compound nesta chamada.
    // Sem a taxa da euler não dá pra comparar honestamente -> HOLD, confiança baixa.
    const d = decideMove([reading("aave", 500), reading("compound", 400)], {
      currentProtocol: "euler",
      amountUsd: 10_000,
      moveCostUsd: 1,
      horizonDays: 365,
    });
    expect(d.action).toBe("HOLD");
    expect(d.confidence).toBe("low");
    expect(d.reason).toMatch(/could not read your current position/i);
  });

  it("o sinal bruto embutido bate com computeSignal sobre as mesmas leituras", () => {
    const readings = [reading("aave", 500), reading("compound", 400)];
    const d = decideMove(readings, baseInput);
    expect(d.signal.bestProtocol).toBe("aave");
    expect(d.signal.rates).toHaveLength(2);
  });
});

describe("confidenceFor", () => {
  it("high: gap >= 50bps E fonte direta (onchain/api)", () => {
    const c = confidenceFor([
      { protocol: "aave", apyBps: 600, apyBaseBps: 600, apyRewardBps: 0, rewardBasis: "reported", tvlUsd: 5_000_000, weightedApyBps: 600, source: "onchain", asOf: "" },
      { protocol: "compound", apyBps: 500, apyBaseBps: 500, apyRewardBps: 0, rewardBasis: "reported", tvlUsd: 5_000_000, weightedApyBps: 495, source: "onchain", asOf: "" },
    ]);
    expect(c).toBe("high");
  });

  it("medium: gap >= 20bps mas fonte agregada (defillama) — não vira high", () => {
    const c = confidenceFor([
      { protocol: "fluid", apyBps: 600, apyBaseBps: 600, apyRewardBps: 0, rewardBasis: "reported", tvlUsd: 5_000_000, weightedApyBps: 510, source: "defillama", asOf: "" },
      { protocol: "aave", apyBps: 480, apyBaseBps: 480, apyRewardBps: 0, rewardBasis: "reported", tvlUsd: 5_000_000, weightedApyBps: 480, source: "onchain", asOf: "" },
    ]);
    expect(c).toBe("medium");
  });

  it("low: gap pequeno (ruído) mesmo com fonte direta", () => {
    const c = confidenceFor([
      { protocol: "aave", apyBps: 500, apyBaseBps: 500, apyRewardBps: 0, rewardBasis: "reported", tvlUsd: 5_000_000, weightedApyBps: 500, source: "onchain", asOf: "" },
      { protocol: "compound", apyBps: 495, apyBaseBps: 495, apyRewardBps: 0, rewardBasis: "reported", tvlUsd: 5_000_000, weightedApyBps: 495, source: "onchain", asOf: "" },
    ]);
    expect(c).toBe("low");
  });

  it("low quando não há nenhuma taxa", () => {
    expect(confidenceFor([])).toBe("low");
  });

  // Um concorrente medido SÓ no juro base é um piso, não um veredito: se houver
  // campanha de incentivo que a fonte não separou, o ranking pode estar
  // invertido — e não dá pra saber por quanto.
  it("não vira high se o incentivo de um CONCORRENTE é desconhecido, mesmo com gap grande e fonte direta", () => {
    const c = confidenceFor([
      { protocol: "aave", apyBps: 600, apyBaseBps: 600, apyRewardBps: 0, rewardBasis: "reported", tvlUsd: 5_000_000, weightedApyBps: 600, source: "onchain", asOf: "" },
      { protocol: "compound", apyBps: 500, apyBaseBps: 500, apyRewardBps: null, rewardBasis: "unavailable", tvlUsd: 5_000_000, weightedApyBps: 495, source: "onchain", asOf: "" },
    ]);
    expect(c).toBe("medium");
  });

  it("incentivo desconhecido no PRÓPRIO líder não derruba a confiança — subestimar o líder não tira a liderança dele", () => {
    const c = confidenceFor([
      { protocol: "aave", apyBps: 600, apyBaseBps: 600, apyRewardBps: null, rewardBasis: "unavailable", tvlUsd: 5_000_000, weightedApyBps: 600, source: "onchain", asOf: "" },
      { protocol: "compound", apyBps: 500, apyBaseBps: 500, apyRewardBps: 0, rewardBasis: "reported", tvlUsd: 5_000_000, weightedApyBps: 495, source: "onchain", asOf: "" },
    ]);
    expect(c).toBe("high");
  });
});

/**
 * Estas duas regras nasceram de um caso REAL: a correção que passou a somar
 * incentivo (2026-07-30) mudou o vencedor de WETH pra Euler a 2,91%, dos quais
 * 1,72 ponto era campanha, num pool de US$ 716 mil. O número está certo; o que
 * faltava era o serviço dizer em cima do que ele está apoiado.
 */
describe("dependência de campanha e profundidade do destino", () => {
  function rate(
    protocol: RateReading["protocol"],
    apyBps: number,
    rewardBps: number | null,
    weightedApyBps: number,
    tvlUsd: number | null,
  ) {
    return {
      protocol,
      apyBps,
      apyBaseBps: rewardBps === null ? null : apyBps - rewardBps,
      apyRewardBps: rewardBps,
      rewardBasis: (rewardBps === null ? "unavailable" : "reported") as "unavailable" | "reported",
      tvlUsd,
      weightedApyBps,
      source: "defillama" as const,
      asOf: "",
    };
  }

  it("liderança que só existe por causa da campanha não recebe confiança high", () => {
    // Euler 291 total (172 de campanha) contra Aave 146: sem a campanha, cai pra 119.
    const rates = [rate("euler", 291, 172, 253, 716_000), rate("aave", 146, 0, 146, 39_000_000)];
    expect(leadDependsOnIncentives(rates)).toBe(true);
    expect(confidenceFor(rates)).toBe("medium");
  });

  it("liderança sustentada pelo juro base continua podendo ser high", () => {
    const rates = [
      { ...rate("compound", 601, 0, 595, 21_000_000), source: "onchain" as const },
      rate("aave", 356, 0, 356, 39_000_000),
    ];
    expect(leadDependsOnIncentives(rates)).toBe(false);
    expect(confidenceFor(rates)).toBe("high");
  });

  it("incentivo desconhecido no líder não é tratado como dependência (não inventa fraqueza)", () => {
    const rates = [rate("euler", 291, null, 253, 716_000), rate("aave", 146, 0, 146, 39_000_000)];
    expect(leadDependsOnIncentives(rates)).toBe(false);
  });

  it("MOVE avisa quando o ganho inteiro depende da campanha do destino", () => {
    const readings = [
      { ...reading("euler", 291), apyBaseBps: 119, apyRewardBps: 172, rewardBasis: "reported" as const, tvlUsd: 716_000 },
      { ...reading("aave", 146), apyBaseBps: 146, apyRewardBps: 0, rewardBasis: "reported" as const, tvlUsd: 39_000_000 },
    ];
    const d = decideMove(readings, { currentProtocol: "aave", amountUsd: 10_000, moveCostUsd: 2, horizonDays: 30 });
    expect(d.action).toBe("MOVE");
    expect(d.gainDependsOnIncentives).toBe(true);
    expect(d.reason).toContain("incentive campaign");
  });

  it("MOVE avisa quando a posição é grande demais pro mercado de destino, e derruba a confiança", () => {
    const readings = [
      { ...reading("euler", 291), apyBaseBps: 291, apyRewardBps: 0, rewardBasis: "reported" as const, tvlUsd: 716_000 },
      { ...reading("aave", 146), apyBaseBps: 146, apyRewardBps: 0, rewardBasis: "reported" as const, tvlUsd: 39_000_000 },
    ];
    const d = decideMove(readings, { currentProtocol: "aave", amountUsd: 500_000, moveCostUsd: 2, horizonDays: 30 });
    expect(d.positionShareOfDestinationPct).toBeGreaterThan(5);
    expect(d.reason).toContain("dilutes the rate");
    expect(d.confidence).not.toBe("high");
  });

  it("posição pequena num mercado fundo não dispara ressalva nenhuma", () => {
    const readings = [
      { ...reading("euler", 291), apyBaseBps: 291, apyRewardBps: 0, rewardBasis: "reported" as const, tvlUsd: 39_000_000 },
      { ...reading("aave", 146), apyBaseBps: 146, apyRewardBps: 0, rewardBasis: "reported" as const, tvlUsd: 39_000_000 },
    ];
    const d = decideMove(readings, { currentProtocol: "aave", amountUsd: 10_000, moveCostUsd: 2, horizonDays: 30 });
    expect(d.positionShareOfDestinationPct).toBeLessThan(1);
    expect(d.reason).not.toContain("dilutes the rate");
  });

  it("profundidade não apurável vira null, não zero (não inventa mercado raso)", () => {
    const readings = [
      { ...reading("morpho", 500), apyBaseBps: null, apyRewardBps: null, rewardBasis: "included-not-itemized" as const, tvlUsd: null },
      { ...reading("aave", 146), apyBaseBps: 146, apyRewardBps: 0, rewardBasis: "reported" as const, tvlUsd: 39_000_000 },
    ];
    const d = decideMove(readings, { currentProtocol: "aave", amountUsd: 500_000, moveCostUsd: 2, horizonDays: 30 });
    expect(d.positionShareOfDestinationPct).toBeNull();
    expect(d.reason).not.toContain("dilutes the rate");
  });
});
