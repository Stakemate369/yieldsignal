import { describe, expect, it } from "vitest";
import { FINAL_DESCRIPTIONS, MAX_DESCRIPTION_CHARS, PAID_PATHS } from "../src/expressApp.js";

/**
 * O facilitador da CDP recusa qualquer pagamento cujo `resource.description`
 * passe de 500 caracteres. A recusa NÃO diz o motivo — devolve
 * "'paymentPayload' is invalid: must match one of [x402V2PaymentPayload,
 * x402V1PaymentPayload]" — e o servidor continua servindo 402 normalmente, o
 * que faz a quebra ser invisível de dentro: só o COMPRADOR falha.
 *
 * Aconteceu de verdade em 2026-07-29: um sufixo de 248 chars somado a todas as
 * descrições estourou o limite em 4 das 6 rotas de uma vez, incluindo as 3 de
 * sinal. Ficou 1 dia sem ninguém conseguir pagar antes de alguém notar. A rota
 * de ETH staking nascera com 631 chars e nunca tinha recebido um pagamento.
 *
 * Limite medido por busca binária contra o /verify da CDP em 2026-07-30
 * (500 aceita, 501 recusa). Não está documentado — se um dia mudar, medir de
 * novo com `scripts/findDescriptionLimit.mjs` e ajustar a constante; nunca
 * afrouxar o teste pra fazer uma descrição nova caber.
 */
describe("limite de tamanho da description das rotas pagas", () => {
  const todas = [
    ...Object.entries(FINAL_DESCRIPTIONS.signal).map(([asset, d]) => [`signal/${asset}`, d] as const),
    ...Object.entries(FINAL_DESCRIPTIONS.decision).map(([asset, d]) => [`decision/${asset}`, d] as const),
    ...Object.entries(FINAL_DESCRIPTIONS.durability).map(([asset, d]) => [`durability/${asset}`, d] as const),
    ...Object.entries(FINAL_DESCRIPTIONS.capacity).map(([asset, d]) => [`capacity/${asset}`, d] as const),
    ...Object.entries(FINAL_DESCRIPTIONS.sensitivity).map(([asset, d]) => [`sensitivity/${asset}`, d] as const),
    ...Object.entries(FINAL_DESCRIPTIONS.exposure).map(([asset, d]) => [`exposure/${asset}`, d] as const),
    ...Object.entries(FINAL_DESCRIPTIONS.persistence).map(([asset, d]) => [`persistence/${asset}`, d] as const),
  ];

  it("cobre todas as rotas pagas", () => {
    // Amarrado a PAID_PATHS, não a um número escrito à mão. A versão anterior
    // fixava 14 e a lista acima era hand-kept: quando a família de persistência
    // entrou, o teste seguiu passando medindo as 14 antigas e as 3 descrições
    // novas ficaram SEM verificação de tamanho — que é precisamente a falha
    // invisível (rota que nunca consegue receber pagamento) que este arquivo
    // existe pra impedir. Agora, somar rota paga sem somar descrição quebra aqui.
    expect(todas).toHaveLength(PAID_PATHS.length);
  });

  it.each(todas)("%s cabe no limite do facilitador", (rota, descricao) => {
    expect(
      descricao.length,
      `${rota} tem ${descricao.length} chars — acima de ${MAX_DESCRIPTION_CHARS}, o facilitador vai recusar TODO pagamento nessa rota sem dizer o motivo`,
    ).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
  });

  it("nenhuma description ficou vazia depois de encurtar", () => {
    for (const [rota, descricao] of todas) {
      expect(descricao.trim().length, `${rota} ficou sem descrição`).toBeGreaterThan(80);
    }
  });
});
