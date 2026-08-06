import { describe, expect, it } from "vitest";
import {
  shouldAttestEntry,
  ATTEST_UTILIZATION_DELTA_BPS,
  ATTEST_MAX_STALENESS_MS,
} from "../src/attestation/encodeSensitivityAttestation.js";
import type { SensitivityEntry } from "../src/signal/sensitivity.js";

function entry(utilizationBps: number | null): SensitivityEntry {
  return {
    protocol: "compound",
    measured: utilizationBps !== null,
    utilizationBps,
    kinkBps: 9_000,
    headroomBps: utilizationBps === null ? null : 9_000 - utilizationBps,
    pastKink: utilizationBps === null ? null : utilizationBps > 9_000,
    borrowApyBpsNow: 408,
    borrowApyBpsAtKink: 408,
    shockMultiple: 3.9,
    curve: null,
    curveBasis: "onchain-rate-function",
  };
}

const AGORA = new Date("2026-08-06T12:00:00.000Z");
const segundos = (d: Date) => Math.floor(d.getTime() / 1000);

/**
 * Este é o TETO DE CUSTO do gatilho, e ele nasceu de um erro meu: a primeira
 * versão publicava a cada rodada do cron. Com ~3 mercados na faixa e cron
 * horário seriam ~72 transações por dia (US$ 9,26/mês) gravando registros quase
 * idênticos, num serviço que ainda não gera receita. Com estas duas peneiras
 * são ~3/dia (US$ 0,39/mês), que o saldo em carteira cobre por ~10 meses.
 */
describe("shouldAttestEntry", () => {
  it("sem registro anterior, grava", () => {
    const r = shouldAttestEntry(entry(8_982), undefined, AGORA);
    expect(r.attest).toBe(true);
    expect(r.reason).toContain("nenhum registro anterior");
  });

  it("não grava quando o mercado praticamente não se mexeu", () => {
    const ha1h = { utilizationBps: 8_980, time: segundos(new Date(AGORA.getTime() - 3_600_000)) };
    const r = shouldAttestEntry(entry(8_982), ha1h, AGORA);
    expect(r.attest).toBe(false);
    expect(r.reason).toContain("recente");
  });

  it("grava quando a utilização anda o suficiente", () => {
    const ha1h = { utilizationBps: 8_982 - ATTEST_UTILIZATION_DELTA_BPS, time: segundos(new Date(AGORA.getTime() - 3_600_000)) };
    const r = shouldAttestEntry(entry(8_982), ha1h, AGORA);
    expect(r.attest).toBe(true);
    expect(r.reason).toContain("utilização andou");
  });

  it("anda pra baixo também conta — o movimento é em módulo", () => {
    const ha1h = { utilizationBps: 8_982 + ATTEST_UTILIZATION_DELTA_BPS, time: segundos(new Date(AGORA.getTime() - 3_600_000)) };
    expect(shouldAttestEntry(entry(8_982), ha1h, AGORA).attest).toBe(true);
  });

  // O batimento que garante série contínua em vez de só picos.
  it("grava por staleness mesmo com o mercado parado", () => {
    const velho = { utilizationBps: 8_982, time: segundos(new Date(AGORA.getTime() - ATTEST_MAX_STALENESS_MS)) };
    const r = shouldAttestEntry(entry(8_982), velho, AGORA);
    expect(r.attest).toBe(true);
    expect(r.reason).toContain("h");
  });

  it("logo antes do batimento ainda não grava", () => {
    const quase = { utilizationBps: 8_982, time: segundos(new Date(AGORA.getTime() - ATTEST_MAX_STALENESS_MS + 60_000)) };
    expect(shouldAttestEntry(entry(8_982), quase, AGORA).attest).toBe(false);
  });

  it("entrada não medida nunca grava", () => {
    expect(shouldAttestEntry(entry(null), undefined, AGORA).attest).toBe(false);
  });

  // Orçamento: 3 mercados x 1 batimento/dia = 3 transações/dia.
  it("o batimento é diário, não de 12h", () => {
    expect(ATTEST_MAX_STALENESS_MS).toBe(24 * 60 * 60 * 1_000);
  });
});
