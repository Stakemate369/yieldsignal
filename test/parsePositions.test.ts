import { describe, expect, it } from "vitest";
import { parsePositions } from "../src/signal/parsePositions.js";

/**
 * É a primeira entrada vinda do COMPRADOR neste serviço. O risco específico
 * aqui não é o crash, é o silêncio: um protocolo escrito errado que passasse
 * viraria "não atribuído" e o comprador pagaria por uma análise de risco que
 * ignorou parte da carteira dele sem avisar.
 */
describe("parsePositions", () => {
  it("aceita pares protocolo:usd", () => {
    const r = parsePositions("aave:200000,morpho:150000");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.positions).toEqual([
      { protocol: "aave", usd: 200_000 },
      { protocol: "morpho", usd: 150_000 },
    ]);
  });

  it("tolera espaços e maiúsculas", () => {
    const r = parsePositions("  AAVE : 100 ,  Compound:50  ");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.positions).toEqual([
      { protocol: "aave", usd: 100 },
      { protocol: "compound", usd: 50 },
    ]);
  });

  // Somar em vez de recusar: é uma carteira expressável. Mas o mesmo protocolo
  // não pode virar duas entradas, senão nominalVenues contaria dois venues
  // onde há um — e o produto todo é sobre não superestimar diversificação.
  it("soma duplicatas do mesmo protocolo numa entrada só", () => {
    const r = parsePositions("aave:100,aave:50");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.positions).toEqual([{ protocol: "aave", usd: 150 }]);
  });

  it("recusa protocolo desconhecido em vez de ignorar em silêncio", () => {
    const r = parsePositions("aavee:100");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("unknown protocol");
    expect(r.error).toContain("aavee");
    // A mensagem tem que ensinar o chamador a se corrigir.
    expect(r.error).toContain("aave");
  });

  it.each([
    ["", "required"],
    [undefined, "required"],
    ["aave", "malformed"],
    [":100", "malformed"],
    ["aave:abc", "positive number"],
    ["aave:-5", "positive number"],
    ["aave:0", "positive number"],
  ])("recusa entrada inválida %s", (input, esperado) => {
    const r = parsePositions(input as unknown);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(esperado);
  });

  it("recusa valor absurdo em vez de propagar", () => {
    const r = parsePositions("aave:1e15");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("maximum");
  });

  it("recusa lista longa demais", () => {
    const r = parsePositions(Array.from({ length: 21 }, () => "aave:100").join(","));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("too many positions");
  });

  it("recusa tipo não-string (array de query repetida)", () => {
    const r = parsePositions(["aave:100", "morpho:50"] as unknown);
    expect(r.ok).toBe(false);
  });
});
