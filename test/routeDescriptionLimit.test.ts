import { describe, expect, it } from "vitest";
import { FINAL_DESCRIPTIONS, MAX_DESCRIPTION_CHARS } from "../src/expressApp.js";

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
  ];

  it("cobre todas as rotas pagas", () => {
    // Guarda contra o teste passar por estar medindo um conjunto vazio ou
    // desatualizado: 3 assets x 2 famílias (signal/decision) + 2 de
    // durabilidade + 2 de capacidade + 2 de sensibilidade — as três últimas são
    // só LendingAssetId (staking não tem mercado de empréstimo, a DefiLlama não
    // itemiza incentivo nos 5 protocolos de staking, e não há curva de juros).
    expect(todas).toHaveLength(14);
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
