import { describe, expect, it } from "vitest";
import {
  PAID_PATHS,
  RESOURCE_PATHS,
  DECISION_PATHS,
  DURABILITY_PATHS,
  CAPACITY_PATHS,
  SENSITIVITY_PATHS,
  EXPOSURE_PATHS,
  PERSISTENCE_PATHS,
  priceKeyForPath,
} from "../src/expressApp.js";

/**
 * Guarda do PREÇO ANUNCIADO.
 *
 * Bug real, vivo em produção até 2026-08-10: quando as quatro rotas analíticas
 * ganharam preço próprio ($0.25), o registro do x402 foi atualizado e a lista do
 * `/openapi.json` não. O documento público passou a anunciar $0.10 numa rota que
 * cobrava $0.25 — e a divergência é invisível de dentro, porque o 402 sai certo
 * e a telemetria não acusa. Quebra só o agente que leu o documento e orçou o
 * valor errado, que é justamente o comprador que este serviço quer atender.
 *
 * Agora as duas listas leem de `priceKeyForPath`. Este arquivo trava a função.
 */
describe("preço anunciado x preço cobrado", () => {
  it("toda rota paga tem faixa de preço definida", () => {
    for (const path of PAID_PATHS) {
      expect(() => priceKeyForPath(path), `${path} ficou sem faixa de preço`).not.toThrow();
    }
  });

  it("caminho desconhecido falha alto em vez de cair num preço que ninguém escolheu", () => {
    // Default silencioso aqui é como o bug original nasceu.
    expect(() => priceKeyForPath("/familia-nova/usdc")).toThrow(/sem faixa de preço/);
  });

  it("sinal cru fica na faixa base", () => {
    for (const path of Object.values(RESOURCE_PATHS)) {
      expect(priceKeyForPath(path)).toBe("PRICE_USD");
    }
  });

  it("as quatro analíticas ficam na faixa analítica — nunca na base", () => {
    const analiticas = [
      ...Object.values(DURABILITY_PATHS),
      ...Object.values(CAPACITY_PATHS),
      ...Object.values(SENSITIVITY_PATHS),
      ...Object.values(EXPOSURE_PATHS),
    ];
    expect(analiticas).toHaveLength(8);
    for (const path of analiticas) {
      expect(priceKeyForPath(path), `${path} voltou a anunciar o preço do sinal cru`).toBe("ANALYTICS_PRICE_USD");
    }
  });

  it("decisão e persistência têm faixa própria", () => {
    for (const path of Object.values(DECISION_PATHS)) {
      expect(priceKeyForPath(path)).toBe("DECISION_PRICE_USD");
    }
    for (const path of Object.values(PERSISTENCE_PATHS)) {
      expect(priceKeyForPath(path)).toBe("PERSISTENCE_PRICE_USD");
    }
  });

  it("nenhuma faixa ficou órfã — as quatro estão em uso", () => {
    const usadas = new Set(PAID_PATHS.map((p) => priceKeyForPath(p)));
    expect(usadas).toEqual(
      new Set(["PRICE_USD", "ANALYTICS_PRICE_USD", "DECISION_PRICE_USD", "PERSISTENCE_PRICE_USD"]),
    );
  });
});
