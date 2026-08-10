import { describe, expect, it } from "vitest";
import {
  PAID_PATHS,
  SHORT_ALIASES,
  FINAL_DESCRIPTIONS,
  RESOURCE_PATHS,
  DECISION_PATHS,
  DURABILITY_PATHS,
  CAPACITY_PATHS,
  SENSITIVITY_PATHS,
  EXPOSURE_PATHS,
  PERSISTENCE_PATHS,
} from "../src/expressApp.js";

/**
 * Guarda da TABELA de rotas. Não sobe o app (isso exigiria credenciais CDP),
 * mas cobre a classe de erro que o servidor esconde: um alias colidindo com um
 * caminho pago serviria um redirect onde deveria sair um 402, e a quebra
 * apareceria só do lado do COMPRADOR — o servidor continuaria respondendo
 * normalmente e parecendo saudável. Mesmo modo de falha invisível do limite de
 * 500 chars da description, que já custou um dia sem conseguir receber.
 */
describe("tabela de rotas", () => {
  it("cobre as 7 famílias de produto", () => {
    // 3 assets de signal + 3 de decisão + 3 de persistência + 2 cada de
    // durabilidade, capacidade, sensibilidade e exposição (só LendingAssetId nas
    // quatro analíticas). Persistência cobre os 3 porque a fonte dela é o
    // histórico atestado, que existe para os 3 — não a curva de juros.
    expect(PAID_PATHS).toHaveLength(17);
  });

  it("toda rota de persistência tem descrição própria", () => {
    for (const [asset, path] of Object.entries(PERSISTENCE_PATHS)) {
      expect(PAID_PATHS).toContain(path);
      expect(FINAL_DESCRIPTIONS.persistence[asset as keyof typeof FINAL_DESCRIPTIONS.persistence]).toBeTruthy();
    }
  });

  it("nenhum caminho pago se repete", () => {
    expect(new Set(PAID_PATHS).size).toBe(PAID_PATHS.length);
  });

  // O teste que justifica o arquivo.
  it("nenhum alias colide com um caminho pago", () => {
    const pagos = new Set(PAID_PATHS);
    for (const alias of Object.keys(SHORT_ALIASES)) {
      expect(pagos.has(alias), `o alias ${alias} sombrearia a rota paga de mesmo nome`).toBe(false);
    }
  });

  it("todo alias aponta pra um caminho pago que existe", () => {
    const pagos = new Set(PAID_PATHS);
    for (const [alias, destino] of Object.entries(SHORT_ALIASES)) {
      expect(pagos.has(destino), `o alias ${alias} aponta pra ${destino}, que não é rota paga`).toBe(true);
    }
  });

  it("todo caminho pago tem descrição", () => {
    const comDescricao = new Set([
      ...Object.values(RESOURCE_PATHS).map((p, i) => [p, Object.values(FINAL_DESCRIPTIONS.signal)[i]] as const),
      ...Object.values(DECISION_PATHS).map((p, i) => [p, Object.values(FINAL_DESCRIPTIONS.decision)[i]] as const),
      ...Object.values(DURABILITY_PATHS).map((p, i) => [p, Object.values(FINAL_DESCRIPTIONS.durability)[i]] as const),
      ...Object.values(CAPACITY_PATHS).map((p, i) => [p, Object.values(FINAL_DESCRIPTIONS.capacity)[i]] as const),
      ...Object.values(SENSITIVITY_PATHS).map((p, i) => [p, Object.values(FINAL_DESCRIPTIONS.sensitivity)[i]] as const),
      ...Object.values(EXPOSURE_PATHS).map((p, i) => [p, Object.values(FINAL_DESCRIPTIONS.exposure)[i]] as const),
    ]);
    expect(comDescricao.size).toBe(14);
    for (const [caminho, descricao] of comDescricao) {
      expect(typeof descricao, `${caminho} sem descrição`).toBe("string");
      expect((descricao as string).length, `${caminho} com descrição vazia`).toBeGreaterThan(80);
    }
  });

  // Alias sem barra inicial nunca casaria no Express, e o 404 engoliria em
  // silêncio — exatamente o "falso 404" que o mapa de endpoints existe pra
  // eliminar.
  it("todo alias e todo caminho pago começam com barra", () => {
    for (const p of [...PAID_PATHS, ...Object.keys(SHORT_ALIASES)]) {
      expect(p.startsWith("/"), `${p} não começa com /`).toBe(true);
    }
  });

  /**
   * `/durability`, `/capacity`, `/sensitivity` e `/exposure` sem asset resolvem
   * pra USDC de propósito, NÃO pro FLAGSHIP_ASSET (ETH_STAKING) como as rotas
   * de signal/decision: staking não tem essas quatro rotas, então apontar pro
   * flagship geraria 404 justamente no chute mais provável.
   */
  it("as famílias sem staking resolvem o alias nu pra USDC", () => {
    expect(SHORT_ALIASES["/durability"]).toBe(DURABILITY_PATHS.USDC);
    expect(SHORT_ALIASES["/capacity"]).toBe(CAPACITY_PATHS.USDC);
    expect(SHORT_ALIASES["/sensitivity"]).toBe(SENSITIVITY_PATHS.USDC);
    expect(SHORT_ALIASES["/exposure"]).toBe(EXPOSURE_PATHS.USDC);
  });

  it("signal e decision nus resolvem pro asset de vitrine", () => {
    expect(SHORT_ALIASES["/signal"]).toBe(RESOURCE_PATHS.ETH_STAKING);
    expect(SHORT_ALIASES["/decision"]).toBe(DECISION_PATHS.ETH_STAKING);
  });
});
