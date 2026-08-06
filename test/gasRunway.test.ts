import { describe, expect, it } from "vitest";
import {
  assessGasRunway,
  LOW_RUNWAY_ATTESTATIONS,
  OBSERVED_ATTESTATION_COST_WEI,
} from "../src/attestation/gasRunway.js";

const ADDR = "0x561143BFE9E2D975D92e915B8EfFEAa54119472a";
const RESERVE = 30_000_000_000_000n; // 0,00003 ETH, a reserva usada em produção
const cost = OBSERVED_ATTESTATION_COST_WEI;

/**
 * Motivo de existir: em 2026-08-05 o saldo caiu 1 centavo abaixo da reserva, o
 * gatilho parou de publicar, e o aviso só chegou DEPOIS de já estar bloqueando
 * — 11 horas de buraco num histórico que não pode ser retroagido.
 */
describe("assessGasRunway", () => {
  it("com folga larga, não alerta", () => {
    const r = assessGasRunway(RESERVE + cost * 500n, RESERVE, ADDR);
    expect(r.status).toBe("ok");
    expect(r.message).toBeNull();
    expect(r.attestationsLeft).toBe(500);
  });

  // O estado que o incidente pediu: ainda publicando, mas já com prazo curto.
  it("alerta ANTES de bloquear quando a folga fica curta", () => {
    const r = assessGasRunway(RESERVE + cost * 10n, RESERVE, ADDR);
    expect(r.status).toBe("low");
    expect(r.attestationsLeft).toBe(10);
    expect(r.message).toContain("Ainda publicando");
    expect(r.message).toContain(ADDR);
  });

  it("logo abaixo do limiar já é alerta; logo acima ainda não é", () => {
    expect(assessGasRunway(RESERVE + cost * BigInt(LOW_RUNWAY_ATTESTATIONS - 1), RESERVE, ADDR).status).toBe("low");
    expect(assessGasRunway(RESERVE + cost * BigInt(LOW_RUNWAY_ATTESTATIONS), RESERVE, ADDR).status).toBe("ok");
  });

  // `blocked` e `low` são estados distintos de propósito: um diz que o dano
  // começou, o outro que ainda dá pra agir. Colapsar os dois perderia o aviso.
  it("distingue bloqueado de baixo", () => {
    const bloqueado = assessGasRunway(RESERVE - 1n, RESERVE, ADDR);
    expect(bloqueado.status).toBe("blocked");
    expect(bloqueado.attestationsLeft).toBe(0);
    expect(bloqueado.message).toContain("já parou");
  });

  it("saldo exatamente na reserva conta como bloqueado, não como folga zero", () => {
    expect(assessGasRunway(RESERVE, RESERVE, ADDR).status).toBe("blocked");
  });

  it("saldo zero não gera número negativo", () => {
    const r = assessGasRunway(0n, RESERVE, ADDR);
    expect(r.status).toBe("blocked");
    expect(r.attestationsLeft).toBe(0);
  });

  // Reproduz o incidente real: 24672798364318 wei contra reserva de 3e13.
  it("reproduz o estado do incidente de 2026-08-05", () => {
    const r = assessGasRunway(24_672_798_364_318n, RESERVE, ADDR);
    expect(r.status).toBe("blocked");
  });

  it("com o saldo pós-recarga do incidente, estaria tranquilo", () => {
    const r = assessGasRunway(2_124_672_798_364_318n, RESERVE, ADDR);
    expect(r.status).toBe("ok");
    expect(r.attestationsLeft).toBeGreaterThan(400);
  });

  it("custo por atestação inválido não vira divisão sem sentido", () => {
    const r = assessGasRunway(RESERVE * 100n, RESERVE, ADDR, 0n);
    expect(r.attestationsLeft).toBe(0);
    expect(r.status).toBe("low");
  });
});
