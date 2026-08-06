import { describe, expect, it } from "vitest";
import { assessDeployDrift, DEPLOY_GRACE_MS } from "../src/notify/deployDrift.js";

const A = "acd7dd0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "4df2d24bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRES_HORAS = 3 * 60 * 60 * 1_000;

/**
 * Dois incidentes reais motivaram isto, ambos invisíveis de fora: seis dias de
 * commits que nunca foram publicados (integração Vercel↔GitHub desconectada,
 * 2026-08-05) e dois deploys cancelados por falta de runner (2026-08-06). Nos
 * dois, o serviço seguiu no ar respondendo com código antigo.
 */
describe("assessDeployDrift", () => {
  it("mesmo SHA é código atual", () => {
    const r = assessDeployDrift(A, A, TRES_HORAS);
    expect(r.status).toBe("current");
    expect(r.message).toBeNull();
  });

  it("compara por prefixo, tolerando formatos diferentes", () => {
    expect(assessDeployDrift(A, A.slice(0, 7), TRES_HORAS).status).toBe("current");
    expect(assessDeployDrift(A.toUpperCase(), A, TRES_HORAS).status).toBe("current");
  });

  // O caso que os incidentes pediram.
  it("SHA diferente e commit velho é publicação parada", () => {
    const r = assessDeployDrift(B, A, TRES_HORAS);
    expect(r.status).toBe("stale");
    expect(r.message).toContain("publicação parada");
    expect(r.message).toContain(B.slice(0, 7));
    expect(r.message).toContain(A.slice(0, 7));
  });

  // Deploy em andamento é normal por alguns minutos — alertar aí treinaria
  // todo mundo a ignorar o alerta, que é como um alerta morre.
  it("SHA diferente mas commit recente ainda está na carência", () => {
    expect(assessDeployDrift(B, A, 60_000).status).toBe("current");
    expect(assessDeployDrift(B, A, DEPLOY_GRACE_MS - 1).status).toBe("current");
    expect(assessDeployDrift(B, A, DEPLOY_GRACE_MS).status).toBe("stale");
  });

  // Fora da Vercel não existe SHA de deploy; gritar nesse caso faria a checagem
  // alertar em todo ambiente local até virar ruído.
  it.each([
    [null, A, TRES_HORAS],
    [A, null, TRES_HORAS],
    [A, B, null],
  ])("sem dado suficiente, não afirma nada (%s, %s, %s)", (deployed, latest, idade) => {
    const r = assessDeployDrift(deployed, latest, idade);
    expect(r.status).toBe("unknown");
    expect(r.message).toBeNull();
  });

  it("reporta as horas de atraso na mensagem", () => {
    const r = assessDeployDrift(B, A, 6 * 60 * 60 * 1_000);
    expect(r.message).toContain("~6h");
  });
});
