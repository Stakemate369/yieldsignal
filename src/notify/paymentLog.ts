import type { SettleResultContext } from "@x402/core/server";
import { logger } from "./logger.js";
import { sendTelegramAlert } from "./telegram.js";
import { recordSale, recordUsage, routeFromResourceUrl } from "../usage/usageStore.js";

export type PaymentChannel = "rest" | "mcp";

// Carteira compradora conhecida do dono (smoke/e-2-e) — pagamentos dela não são
// vendas reais. Outras podem entrar via SELF_PAYER_ADDRESSES. Normalizado em
// minúsculas na comparação. Lido direto de process.env (best-effort) em vez de
// loadEnv: esta checagem nunca pode derrubar/encerrar o processo numa
// liquidação já feita, e não precisa da validação completa do schema.
const DEFAULT_SELF_PAYERS = ["0xC2432775f205333D15eCAe61d56cD7Fe1F6C3c15"];

function selfPayerSet(): Set<string> {
  const fromEnv = (process.env.SELF_PAYER_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return new Set([...DEFAULT_SELF_PAYERS.map((a) => a.toLowerCase()), ...fromEnv]);
}

/** Um pagamento vindo de carteira do próprio dono não é venda. Exportado pra reuso no registro durável. */
export function isSelfPayer(payer: string | undefined | null): boolean {
  if (!payer) return false;
  return selfPayerSet().has(payer.toLowerCase());
}

/**
 * Dispara um alerta no Telegram quando um pagamento liquidado veio de um payer
 * que NÃO é uma carteira do próprio dono — ou seja, uma VENDA REAL a um
 * terceiro. É o único sinal de negócio que importa de verdade ("alguém além de
 * mim está pagando por isso?"): o log já registra tudo, mas ninguém fica lendo
 * log; este alerta fala com o dono.
 *
 * Best-effort e nunca lança (a liquidação já aconteceu). Em serverless não há
 * estado durável pra deduplicar "já avisei deste payer", então alerta em CADA
 * pagamento externo — comportamento desejado enquanto o volume é baixo (você
 * quer saber de cada venda real); se crescer, dá pra deduplicar com storage
 * externo depois. Exportada à parte pra ser testável sem I/O real.
 */
export function alertOnExternalPayer(context: SettleResultContext, channel: PaymentChannel): void {
  try {
    const payer = context.result.payer;
    if (!payer) return;
    if (selfPayerSet().has(payer.toLowerCase())) return; // pagamento próprio — ignora
    const amount = context.result.amount ?? context.requirements.amount ?? "?";
    const resource = context.paymentPayload.resource?.url ?? "unknown";
    void sendTelegramAlert(
      `💰 YieldSignal — PRIMEIRO/NOVO PAGADOR EXTERNO (${channel})\n\n` +
        `Alguém que não é você acabou de pagar pelo produto.\n\n` +
        `Payer: ${payer}\n` +
        `Valor: ${amount}\n` +
        `Rota: ${resource}\n` +
        `Rede: ${context.result.network ?? "?"}\n` +
        `Tx: ${context.result.transaction ?? "?"}`,
    );
  } catch (err) {
    logger.warn({ err }, "falha ao checar/alertar pagador externo — liquidação não afetada");
  }
}

/**
 * Registra o FATO de um pagamento liquidado — payer, tx, network, valor e o
 * token usado pra pagar (`requirements.asset`, o token ERC-20 da liquidação
 * x402, NÃO confundir com `AssetId` do produto — o mesmo pagamento em USDC
 * pode ter comprado tanto o sinal de USDC quanto o de WETH). `resourceUrl`
 * vem de `paymentPayload.resource?.url`, populado pelo próprio
 * x402HTTPResourceServer a partir da rota que gerou o 402 original — best
 * effort — não é garantia rígida, mas é útil pra saber qual
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
  // Alerta de venda real (pagador externo) — guardado à parte com seu próprio
  // try/catch dentro, pra uma falha aqui não afetar o log acima nem a liquidação.
  alertOnExternalPayer(context, channel);
}

/**
 * Registro DURÁVEL da liquidação (contador de funil + histórico de vendas).
 * Separado de `logSettledPayment` de propósito: aquele é síncrono e precisa
 * continuar assim (o alerta de Telegram dispara antes de qualquer await), este
 * é assíncrono porque escreve num store externo e quer ser aguardado dentro do
 * hook de settlement — em serverless, uma promise solta depois da resposta pode
 * ser congelada antes de completar.
 *
 * Motivo de existir: `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` não estão
 * configurados em produção, então o alerta de pagador externo é um no-op hoje —
 * a primeira venda real a um terceiro (2026-07-27) passou silenciosa e só foi
 * descoberta dias depois lendo `Transfer` de USDC on-chain. Isto faz a venda
 * aparecer em /usage.json independente do Telegram.
 *
 * Nunca lança: a liquidação já aconteceu, nada aqui pode desfazê-la.
 */
export async function recordSettlementUsage(context: SettleResultContext, channel: PaymentChannel): Promise<void> {
  try {
    const payer = context.result.payer;
    const external = !isSelfPayer(payer);
    const resource = context.paymentPayload.resource?.url;
    await recordUsage({
      kind: "settled",
      channel,
      route: routeFromResourceUrl(resource),
      outcome: external ? "external" : "self",
    });
    await recordSale({
      at: new Date().toISOString(),
      payer: payer ?? "unknown",
      amount: String(context.result.amount ?? context.requirements.amount ?? "?"),
      resource: context.paymentPayload.resource?.url ?? "unknown",
      channel,
      transaction: String(context.result.transaction ?? "?"),
      external,
    });
  } catch (err) {
    logger.warn({ err }, "falha registrando liquidação de forma durável — liquidação em si não foi afetada");
  }
}
