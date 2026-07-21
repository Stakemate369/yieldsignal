import { describe, it, expect } from "vitest";
import { parseDecisionQuery } from "../src/signal/parseDecisionQuery.js";

describe("parseDecisionQuery", () => {
  it("defaults quando o query está vazio", () => {
    const r = parseDecisionQuery({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input).toEqual({ currentProtocol: null, amountUsd: 1000, moveCostUsd: 0.5, horizonDays: 30 });
    }
  });

  it("position conhecida vira currentProtocol", () => {
    const r = parseDecisionQuery({ position: "aave" });
    expect(r.ok && r.input.currentProtocol).toBe("aave");
  });

  it('position "idle"/"none"/vazia => capital ocioso (null)', () => {
    for (const p of ["idle", "none", ""]) {
      const r = parseDecisionQuery({ position: p });
      expect(r.ok && r.input.currentProtocol).toBeNull();
    }
  });

  it("position desconhecida é rejeitada", () => {
    const r = parseDecisionQuery({ position: "notaprotocol" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/position desconhecida/);
  });

  it("parseia números válidos", () => {
    const r = parseDecisionQuery({ position: "compound", amountUsd: "50000", moveCostUsd: "3.5", horizonDays: "90" });
    expect(r.ok && r.input).toEqual({ currentProtocol: "compound", amountUsd: 50000, moveCostUsd: 3.5, horizonDays: 90 });
  });

  it("rejeita número não-numérico", () => {
    const r = parseDecisionQuery({ amountUsd: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/amountUsd inválido/);
  });

  it("rejeita número fora dos limites (negativo)", () => {
    const r = parseDecisionQuery({ amountUsd: "-5" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/fora dos limites/);
  });

  it("rejeita horizonte absurdo (acima do teto)", () => {
    const r = parseDecisionQuery({ horizonDays: "99999" });
    expect(r.ok).toBe(false);
  });

  it("rejeita NaN explícito", () => {
    const r = parseDecisionQuery({ moveCostUsd: "NaN" });
    expect(r.ok).toBe(false);
  });
});
