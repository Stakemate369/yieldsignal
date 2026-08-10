import { describe, it, expect } from "vitest";
// @ts-expect-error — módulo .mjs sem tipos, importado só pra testar a decisão pura.
import { calcularRecarga, TETO_RECARGA_USD } from "../scripts/lib/tesouraria.mjs";

/**
 * A recarga automática move dinheiro real entre duas carteiras do dono sem
 * ninguém confirmando nada. A decisão de QUANTO mover é a única parte
 * testável sem rede, e é onde um erro custa caro — por isso ela é pura e por
 * isso estes testes existem.
 *
 * Contexto: em 2026-08-10 o sync do Bazaar gastou duas vezes na mesma rota e
 * secou a carteira. A regra que saiu daquilo é que gasto de dinheiro precisa de
 * trava; aqui a trava é o teto e o limite pelo saldo de origem.
 */
describe("calcularRecarga", () => {
  it("não move nada quando a compradora já tem o bastante", () => {
    expect(calcularRecarga({ saldoAtualUsd: 5, necessarioUsd: 3.25, disponivelUsd: 100 }).valorUsd).toBe(0);
  });

  it("no limite exato (saldo == necessário) também não move", () => {
    expect(calcularRecarga({ saldoAtualUsd: 3.25, necessarioUsd: 3.25, disponivelUsd: 100 }).valorUsd).toBe(0);
  });

  it("puxa a diferença mais a folga", () => {
    const { valorUsd } = calcularRecarga({ saldoAtualUsd: 1, necessarioUsd: 3.25, disponivelUsd: 100, folgaUsd: 0.5 });
    expect(valorUsd).toBeCloseTo(2.75, 6);
  });

  it("nunca pede mais do que a receptora tem — pedir a mais faz a transferência inteira falhar", () => {
    const { valorUsd, motivo } = calcularRecarga({ saldoAtualUsd: 0, necessarioUsd: 50, disponivelUsd: 1.2 });
    expect(valorUsd).toBe(1.2);
    expect(motivo).toMatch(/receptora/);
  });

  it("respeita o teto absoluto por recarga", () => {
    const { valorUsd, motivo } = calcularRecarga({ saldoAtualUsd: 0, necessarioUsd: 9999, disponivelUsd: 100000 });
    expect(valorUsd).toBe(TETO_RECARGA_USD);
    expect(motivo).toMatch(/teto/);
  });

  it("receptora vazia não vira transferência de zero nem erro", () => {
    const { valorUsd, motivo } = calcularRecarga({ saldoAtualUsd: 0, necessarioUsd: 3, disponivelUsd: 0 });
    expect(valorUsd).toBe(0);
    expect(motivo).toMatch(/vazia/);
  });

  // NaN em comparação numérica é SEMPRE falso, então sem a guarda explícita um
  // valor não-finito passaria direto pelos testes de "já tem o bastante" e
  // chegaria em BigInt(Math.round(NaN)), que lança no meio do caminho do
  // dinheiro — o pior lugar possível pra descobrir um parse falho.
  it("entrada não-finita não move nada", () => {
    for (const ruim of [NaN, Infinity, -1]) {
      expect(calcularRecarga({ saldoAtualUsd: 0, necessarioUsd: ruim, disponivelUsd: 100 }).valorUsd).toBe(0);
      expect(calcularRecarga({ saldoAtualUsd: ruim, necessarioUsd: 3, disponivelUsd: 100 }).valorUsd).toBe(0);
      expect(calcularRecarga({ saldoAtualUsd: 0, necessarioUsd: 3, disponivelUsd: ruim }).valorUsd).toBe(0);
    }
  });

  it("entrada não-numérica não move nada", () => {
    expect(calcularRecarga({ saldoAtualUsd: "1" as never, necessarioUsd: 3, disponivelUsd: 100 }).valorUsd).toBe(0);
    expect(calcularRecarga({}).valorUsd).toBe(0);
  });

  // USDC tem 6 casas. Arredondar pra CIMA poderia pedir uma fração de unidade a
  // mais do que a receptora tem e reverter a transferência inteira.
  it("trunca na unidade do USDC em vez de arredondar pra cima", () => {
    const { valorUsd } = calcularRecarga({
      saldoAtualUsd: 0,
      necessarioUsd: 0.0000005,
      disponivelUsd: 0.0000005,
      folgaUsd: 0,
    });
    expect(valorUsd).toBe(0);
  });

  it("o valor devolvido nunca excede o disponível, em nenhuma combinação", () => {
    const valores = [0, 0.01, 1, 3.25, 10, 1000];
    for (const saldoAtualUsd of valores) {
      for (const necessarioUsd of valores) {
        for (const disponivelUsd of valores) {
          const { valorUsd } = calcularRecarga({ saldoAtualUsd, necessarioUsd, disponivelUsd });
          expect(valorUsd).toBeLessThanOrEqual(disponivelUsd);
          expect(valorUsd).toBeLessThanOrEqual(TETO_RECARGA_USD);
          expect(valorUsd).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});
