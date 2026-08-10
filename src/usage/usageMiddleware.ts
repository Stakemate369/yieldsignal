import type { Request, Response, NextFunction } from "express";
import { recordUsage, type UsageKind, type UsageRoute } from "./usageStore.js";

/**
 * Classifica a INTENÇÃO da request antes de ela ser processada, em vez de
 * inspecionar o status da resposta depois.
 *
 * Por que assim: o middleware de pagamento do x402 devolve 402 exatamente
 * quando não vem header de pagamento. Então a etapa do funil é dedutível na
 * ENTRADA, sem precisar interceptar `res.end`/`res.writeHead` — e isso importa
 * em serverless, porque registrar depois da resposta significa registrar numa
 * promise solta que a plataforma pode congelar antes de completar.
 *
 * SÃO DOIS HEADERS, não um. O x402 v2 manda `payment-signature`; `x-payment` é
 * o nome do v1, mantido como alternativa. A ordem e o conjunto vêm de
 * `@x402/express` (`dist/esm/index.mjs`), que resolve exatamente
 * `getHeader("payment-signature") || getHeader("x-payment")` — este módulo
 * espelha essa linha de propósito, pra que a classificação do funil e a decisão
 * real de cobrança nunca discordem.
 *
 * Bug real medido em 2026-08-10: checando só `x-payment`, `paid_attempt` marcou
 * ZERO durante toda a vida do serviço, incluindo 4 pagamentos disparados na
 * mesma sessão em que isto foi escrito — clientes v2 mandam `payment-signature`
 * e caíam em `challenged`. O funil ficava sem conseguir separar "chegou e
 * tentou pagar" de "chegou e desistiu", que é a distinção que decide se o
 * problema é preço ou é descoberta.
 *
 * Desde a remoção da degustação gratuita (2026-08-10) só existem dois estados:
 * tentou pagar ou não tentou. `?trial=1` virou parâmetro desconhecido e conta
 * como `challenged`, igual a qualquer outra request sem pagamento.
 *
 * Imprecisão conhecida e aceita: um header de pagamento presente mas inválido
 * conta como `paid_attempt` (não como `challenged`), embora a resposta acabe
 * sendo 402. É o comportamento desejável pra este uso — "alguém tentou pagar"
 * é informação melhor que "levou 402".
 */
export function classifyIncoming(params: { paymentHeader: unknown; paymentSignature?: unknown }): UsageKind {
  return params.paymentSignature || params.paymentHeader ? "paid_attempt" : "challenged";
}

/**
 * Middleware de entrada por rota de produto. Registra a etapa do funil e segue.
 * `await` é intencional (ver recordUsage) e tem timeout curto embutido; uma
 * falha de telemetria nunca bloqueia nem atrasa além disso.
 */
export function usageEntryMiddleware(route: UsageRoute, asset: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    // try/finally: este projeto roda em Express 4, que NÃO captura rejeição de
    // handler assíncrono — uma promise rejeitada aqui viraria unhandled
    // rejection e derrubaria o processo (não existe processGuards neste repo).
    // `recordUsage` já promete nunca lançar, mas a request não pode depender
    // dessa promessa pra chegar no próximo handler.
    try {
      const kind = classifyIncoming({
        paymentSignature: req.headers["payment-signature"],
        paymentHeader: req.headers["x-payment"],
      });
      await recordUsage({ kind, route, channel: "rest", asset });
    } catch {
      // Telemetria nunca bloqueia o produto — segue pro handler real.
    } finally {
      next();
    }
  };
}
