import { describe, it, expect } from "vitest";
import { GUARANTEE_TERMS } from "../src/guarantee/terms.js";

describe("GUARANTEE_TERMS", () => {
  it("é HONESTO sobre o status enquanto o escrow não está deployado", () => {
    // Trava de segurança de produto: nenhum robô pagante pode ser induzido a
    // ler isto como promessa de payout ativa. Se alguém flipar pra "live" sem
    // fundear o bond, este teste quebra de propósito.
    expect(GUARANTEE_TERMS.status).toBe("engine-ready:escrow-not-deployed");
    expect(GUARANTEE_TERMS.bond.escrowAddress).toBeNull();
    expect(GUARANTEE_TERMS.bond.fundedUsd).toBe(0);
  });

  it("descreve a regra determinística (breach/janela/tolerância/indeterminado)", () => {
    expect(GUARANTEE_TERMS.mechanism).toBe("economic-bond");
    expect(GUARANTEE_TERMS.rule.breach).toMatch(/toleranceBps/);
    expect(GUARANTEE_TERMS.rule.windowBound).toMatch(/window/i);
    expect(GUARANTEE_TERMS.rule.indeterminate).toMatch(/unreadable/i);
  });

  it("expõe defaults sãos (tolerância >= 0, janela > 0, payout múltiplo do preço)", () => {
    expect(GUARANTEE_TERMS.defaults.toleranceBps).toBeGreaterThanOrEqual(0);
    expect(GUARANTEE_TERMS.defaults.windowSeconds).toBeGreaterThan(0);
    expect(GUARANTEE_TERMS.defaults.payoutMultipleOfPrice).toBeGreaterThan(0);
  });
});
