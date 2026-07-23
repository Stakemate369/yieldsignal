import { loadEnv } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Alerta operacional best-effort pro dono do agente (mesmo padrão já validado
 * no YieldPilot). Serve pra RESPONDER "quem me avisa quando quebra?": o
 * monitor externo (cron-job.org) só bate no /health, mas não fala com o dono;
 * esta função é o canal que fala.
 *
 * Regras de robustez (deliberadas):
 *  - NUNCA lança: uma falha de notificação não pode derrubar a rota que a
 *    disparou (ex.: se o auto-attest falhou e o alerta também, o resultado da
 *    rota ainda tem que voltar pro cron). Todo erro vira log warn e retorna.
 *  - No-op silencioso se TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID não estiverem
 *    ambos configurados — o produto funciona sem alerta, isso é opt-in.
 *  - `fetch` nativo (Node 18+/serverless), sem dependência nova.
 */
export async function sendTelegramAlert(text: string): Promise<void> {
  const env = loadEnv();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      // Corpo do Telegram costuma explicar (chat_id errado, bot bloqueado etc.)
      // — logado pra diagnóstico, mas sem lançar.
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body: body.slice(0, 300) }, "telegram: sendMessage não-OK — alerta não entregue");
    }
  } catch (err) {
    logger.warn({ err }, "telegram: falha enviando alerta — ignorado (não afeta a rota que chamou)");
  }
}
