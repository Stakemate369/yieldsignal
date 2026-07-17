import type { SettleResultContext } from "@x402/core/server";
import { logger } from "./logger.js";

export type PaymentChannel = "rest" | "mcp";

/**
 * Registra o FATO de um pagamento liquidado — payer, tx, network, valor e o
 * token usado pra pagar (`requirements.asset`, o token ERC-20 da liquidação
 * x402, NÃO confundir com `AssetId` do produto — o mesmo pagamento em USDC
 * pode ter comprado tanto o sinal de USDC quanto o de WETH). `resourceUrl`
 * vem de `paymentPayload.resource?.url`, populado pelo próprio
 * x402HTTPResourceServer a partir da rota que gerou o 402 original — best
 * effort (mesmo espírito não-garantido do freeTrial.ts), útil pra saber qual
 * endpoint foi pago sem precisar de um mecanismo novo de correlação.
 *
 * Registrada via `onAfterSettle` em DUAS instâncias de x402ResourceServer
 * separadas (REST em expressApp.ts, MCP em mcp.ts) — cada canal precisa do
 * próprio registro, não há um resourceServer compartilhado entre os dois.
 * Nunca lança: uma falha de log não pode derrubar uma liquidação já feita.
 */
export function logSettledPayment(context: SettleResultContext, channel: PaymentChannel): void {
  try {
    logger.info(
      {
        channel,
        payer: context.result.payer,
        transaction: context.result.transaction,
        network: context.result.network,
        amount: context.result.amount ?? context.requirements.amount,
        paymentToken: context.requirements.asset,
        resourceUrl: context.paymentPayload.resource?.url ?? "unknown",
      },
      "pagamento liquidado",
    );
  } catch (err) {
    logger.warn({ err }, "falha ao logar pagamento liquidado — liquidação em si não foi afetada");
  }
}
