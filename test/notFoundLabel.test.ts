/**
 * O rótulo de 404 precisa responder "é cliente perdido ou é scanner?" SEM deixar
 * ninguém criar campo novo à vontade no Redis — o store é compartilhado com o
 * YieldPilot, que guarda estado de um agente que move dinheiro.
 */
import { describe, expect, it } from "vitest";
import { notFoundLabel } from "../src/usage/notFoundLabel.js";

describe("notFoundLabel", () => {
  it("preserva caminho que parece o produto, com 2 segmentos", () => {
    expect(notFoundLabel("/signal/usd")).toBe("signal/usd");
    expect(notFoundLabel("/decision/eth")).toBe("decision/eth");
    expect(notFoundLabel("/signal")).toBe("signal");
  });

  it("é isso que separa alias faltando de ruído", () => {
    // Agente chutando o produto: acionável, vira alias.
    expect(notFoundLabel("/yield/usdc")).toBe("yield/usdc");
    // Scanner de vulnerabilidade: ignorar.
    expect(notFoundLabel("/wp-admin/setup-config.php")).toBe("noise");
    expect(notFoundLabel("/.env")).toBe("noise");
    expect(notFoundLabel("/.git/config")).toBe("noise");
    expect(notFoundLabel("/vendor/phpunit/eval-stdin.php")).toBe("noise");
  });

  it("colapsa qualquer coisa desconhecida em um rótulo só", () => {
    expect(notFoundLabel("/kjhsdfkjh")).toBe("other");
    expect(notFoundLabel("/algo/aleatorio/profundo")).toBe("other");
  });

  it("cardinalidade é limitada: 1.000 caminhos aleatórios não criam 1.000 rótulos", () => {
    const rotulos = new Set<string>();
    for (let i = 0; i < 1000; i++) rotulos.add(notFoundLabel(`/lixo${i}/x${i}`));
    expect(rotulos.size).toBe(1);
    expect([...rotulos][0]).toBe("other");
  });

  it("segundo segmento hostil é sanitizado e truncado, não gravado cru", () => {
    const r = notFoundLabel(`/signal/${"a".repeat(500)}`);
    expect(r.startsWith("signal/")).toBe(true);
    expect(r.length).toBeLessThanOrEqual("signal/".length + 24);
    // A barra de `</script>` já corta o segmento; sobra `<script>alert(1)<` limpo.
    expect(notFoundLabel("/signal/<script>alert(1)</script>")).toBe("signal/scriptalert1");
    expect(notFoundLabel("/signal/../../etc")).toBe("signal/..");
  });

  it("entrada degenerada não quebra nem vira campo novo", () => {
    expect(notFoundLabel("")).toBe("other");
    expect(notFoundLabel("/")).toBe("root");
    expect(notFoundLabel("/".repeat(600))).toBe("noise");
    // @ts-expect-error entrada fora do contrato
    expect(notFoundLabel(undefined)).toBe("other");
  });
});
