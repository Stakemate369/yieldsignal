import { describe, it, expect } from "vitest";
import { resolveGuarantee, issueGuarantee } from "../src/guarantee/resolveGuarantee.js";
import type { GuaranteeClaim, VerificationReading } from "../src/guarantee/resolveGuarantee.js";

const ISSUED = 1_784_000_000;
const HASH = "0xabc123" as `0x${string}`;

function claim(over: Partial<GuaranteeClaim> = {}): GuaranteeClaim {
  return {
    asset: "USDC",
    guaranteedProtocol: "aave",
    guaranteedWeightedApyBps: 500,
    toleranceBps: 10,
    windowSeconds: 3600,
    issuedAt: ISSUED,
    payoutUsd: 0.5,
    contentHash: HASH,
    ...over,
  };
}

function reading(over: Partial<VerificationReading> = {}): VerificationReading {
  return {
    observedAt: ISSUED + 1000,
    bestProtocol: "aave",
    bestWeightedApyBps: 500,
    guaranteedNowWeightedApyBps: 500,
    ...over,
  };
}

describe("resolveGuarantee", () => {
  it("UPHELD quando o protocolo garantido continua o melhor", () => {
    const r = resolveGuarantee(claim(), reading({ bestProtocol: "aave", bestWeightedApyBps: 500, guaranteedNowWeightedApyBps: 500 }));
    expect(r.verdict).toBe("UPHELD");
    expect(r.payoutOwedUsd).toBe(0);
  });

  it("BREACHED quando outro protocolo ultrapassa além da tolerância, dentro da janela", () => {
    // fluid agora 560, aave garantido caiu pra 500. margem 60 > tolerância 10.
    const r = resolveGuarantee(
      claim({ toleranceBps: 10, payoutUsd: 0.5 }),
      reading({ bestProtocol: "fluid", bestWeightedApyBps: 560, guaranteedNowWeightedApyBps: 500 }),
    );
    expect(r.verdict).toBe("BREACHED");
    expect(r.payoutOwedUsd).toBe(0.5);
    expect(r.breachMarginBps).toBe(60);
  });

  it("UPHELD quando a ultrapassagem está DENTRO da tolerância (ruído)", () => {
    // fluid 508, aave 500. margem 8 <= tolerância 10 -> não rompe.
    const r = resolveGuarantee(
      claim({ toleranceBps: 10 }),
      reading({ bestProtocol: "fluid", bestWeightedApyBps: 508, guaranteedNowWeightedApyBps: 500 }),
    );
    expect(r.verdict).toBe("UPHELD");
    expect(r.payoutOwedUsd).toBe(0);
    expect(r.breachMarginBps).toBe(8);
  });

  it("margem exatamente igual à tolerância NÃO rompe (estritamente maior)", () => {
    const r = resolveGuarantee(
      claim({ toleranceBps: 10 }),
      reading({ bestProtocol: "fluid", bestWeightedApyBps: 510, guaranteedNowWeightedApyBps: 500 }),
    );
    expect(r.verdict).toBe("UPHELD");
    expect(r.breachMarginBps).toBe(10);
  });

  it("OUT_OF_WINDOW: leitura depois de a janela expirar não dispara payout mesmo se romperia", () => {
    const r = resolveGuarantee(
      claim({ windowSeconds: 3600 }),
      reading({ observedAt: ISSUED + 4000, bestProtocol: "fluid", bestWeightedApyBps: 600, guaranteedNowWeightedApyBps: 500 }),
    );
    expect(r.verdict).toBe("OUT_OF_WINDOW");
    expect(r.payoutOwedUsd).toBe(0);
  });

  it("OUT_OF_WINDOW: leitura antes de emitir também não conta", () => {
    const r = resolveGuarantee(claim(), reading({ observedAt: ISSUED - 10 }));
    expect(r.verdict).toBe("OUT_OF_WINDOW");
  });

  it("na borda exata da janela ainda é válida (<=)", () => {
    const r = resolveGuarantee(
      claim({ windowSeconds: 3600 }),
      reading({ observedAt: ISSUED + 3600, bestProtocol: "fluid", bestWeightedApyBps: 600, guaranteedNowWeightedApyBps: 500 }),
    );
    expect(r.verdict).toBe("BREACHED");
  });

  it("INDETERMINATE quando o APY do protocolo garantido está ilegível", () => {
    const r = resolveGuarantee(
      claim(),
      reading({ bestProtocol: "fluid", bestWeightedApyBps: 600, guaranteedNowWeightedApyBps: null }),
    );
    expect(r.verdict).toBe("INDETERMINATE");
    expect(r.payoutOwedUsd).toBe(0);
    expect(r.breachMarginBps).toBeNull();
  });
});

describe("issueGuarantee", () => {
  it("constrói um compromisso com issuedAt injetado", () => {
    const c = issueGuarantee({
      asset: "USDC",
      guaranteedProtocol: "aave",
      guaranteedWeightedApyBps: 500,
      toleranceBps: 10,
      windowSeconds: 3600,
      payoutUsd: 0.5,
      contentHash: HASH,
      now: ISSUED,
    });
    expect(c.issuedAt).toBe(ISSUED);
    expect(c.guaranteedProtocol).toBe("aave");
  });

  it("rejeita janela não-positiva", () => {
    expect(() =>
      issueGuarantee({ asset: "USDC", guaranteedProtocol: "aave", guaranteedWeightedApyBps: 500, toleranceBps: 10, windowSeconds: 0, payoutUsd: 0.5, contentHash: HASH }),
    ).toThrow(/windowSeconds/);
  });

  it("rejeita payout não-positivo", () => {
    expect(() =>
      issueGuarantee({ asset: "USDC", guaranteedProtocol: "aave", guaranteedWeightedApyBps: 500, toleranceBps: 10, windowSeconds: 3600, payoutUsd: 0, contentHash: HASH }),
    ).toThrow(/payoutUsd/);
  });

  it("rejeita tolerância negativa", () => {
    expect(() =>
      issueGuarantee({ asset: "USDC", guaranteedProtocol: "aave", guaranteedWeightedApyBps: 500, toleranceBps: -1, windowSeconds: 3600, payoutUsd: 0.5, contentHash: HASH }),
    ).toThrow(/toleranceBps/);
  });
});
