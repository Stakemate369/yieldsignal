import { describe, it, expect } from "vitest";
import { decideMove, confidenceFor } from "../src/signal/decideMove.js";
import type { MoveDecisionInput } from "../src/signal/decideMove.js";
import type { RateReading } from "../src/market-data/types.js";

function reading(
  protocol: RateReading["protocol"],
  supplyApyBps: number,
  source: RateReading["source"] = "onchain",
  asset: RateReading["asset"] = "USDC",
): RateReading {
  return { protocol, asset, supplyApyBps, source, readAt: new Date("2026-07-21T12:00:00.000Z") };
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
      { protocol: "aave", apyBps: 600, weightedApyBps: 600, source: "onchain", asOf: "" },
      { protocol: "compound", apyBps: 500, weightedApyBps: 495, source: "onchain", asOf: "" },
    ]);
    expect(c).toBe("high");
  });

  it("medium: gap >= 20bps mas fonte agregada (defillama) — não vira high", () => {
    const c = confidenceFor([
      { protocol: "fluid", apyBps: 600, weightedApyBps: 510, source: "defillama", asOf: "" },
      { protocol: "aave", apyBps: 480, weightedApyBps: 480, source: "onchain", asOf: "" },
    ]);
    expect(c).toBe("medium");
  });

  it("low: gap pequeno (ruído) mesmo com fonte direta", () => {
    const c = confidenceFor([
      { protocol: "aave", apyBps: 500, weightedApyBps: 500, source: "onchain", asOf: "" },
      { protocol: "compound", apyBps: 495, weightedApyBps: 495, source: "onchain", asOf: "" },
    ]);
    expect(c).toBe("low");
  });

  it("low quando não há nenhuma taxa", () => {
    expect(confidenceFor([])).toBe("low");
  });
});
