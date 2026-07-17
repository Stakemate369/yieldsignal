import { describe, it, expect } from "vitest";
import { computeSignal } from "../src/signal/computeSignal.js";
import type { RateReading } from "../src/market-data/types.js";

function reading(protocol: RateReading["protocol"], supplyApyBps: number, source: RateReading["source"] = "onchain"): RateReading {
  return { protocol, supplyApyBps, source, readAt: new Date("2026-07-16T12:00:00.000Z") };
}

describe("computeSignal", () => {
  it("lança se não houver nenhuma leitura", () => {
    expect(() => computeSignal([])).toThrow(/nenhuma leitura/);
  });

  it("com uma única leitura, ela é a melhor e o gap é zero", () => {
    const signal = computeSignal([reading("aave", 500)]);
    expect(signal.bestProtocol).toBe("aave");
    expect(signal.gapBps).toBe(0);
    expect(signal.rates).toHaveLength(1);
  });

  it("escolhe o protocolo com maior APY ponderada por risco, não a maior APY bruta", () => {
    // compound (peso 0.99) com 500bps brutos = 495 ponderado
    // morpho (peso 0.97) com 510bps brutos = 494.7 -> arredonda pra 495 também;
    // usar uma diferença maior pra não empatar por arredondamento.
    const signal = computeSignal([reading("compound", 500), reading("morpho", 520)]);
    // compound: 500*0.99=495 | morpho: 520*0.97=504.4 -> 504
    expect(signal.bestProtocol).toBe("morpho");
    expect(signal.gapBps).toBe(504 - 495);
  });

  it("protocolo da Camada 2 (peso mais conservador) precisa de vantagem bruta maior pra vencer um da Camada 1", () => {
    // aave (peso 1.0) com 400bps = 400 ponderado
    // fluid (peso 0.85) com 420bps = 357 ponderado -> aave ainda vence
    const signal = computeSignal([reading("aave", 400), reading("fluid", 420, "defillama")]);
    expect(signal.bestProtocol).toBe("aave");
  });

  it("expõe source e asOf de cada leitura, sem inventar dado", () => {
    const signal = computeSignal([reading("euler", 300, "defillama")]);
    expect(signal.rates[0].source).toBe("defillama");
    expect(signal.rates[0].asOf).toBe("2026-07-16T12:00:00.000Z");
  });

  it("ordena as taxas da melhor pra pior (ponderada)", () => {
    const signal = computeSignal([reading("aave", 300), reading("compound", 600), reading("morpho", 100)]);
    const order = signal.rates.map((r) => r.protocol);
    expect(order[0]).toBe("compound");
    expect(order[order.length - 1]).toBe("morpho");
  });
});
