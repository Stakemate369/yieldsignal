import type { Request, Response, NextFunction } from "express";
import { recordUsage, type UsageKind, type UsageRoute } from "./usageStore.js";

/**
 * Classifica a INTENÇÃO da request antes de ela ser processada, em vez de
 * inspecionar o status da resposta depois.
 *
 * Por que assim: o middleware de pagamento do x402 devolve 402 exatamente
 * quando não vem header `X-PAYMENT` (nome confirmado no pacote instalado
 * `@x402/core`, não na documentação). Então a etapa do funil é dedutível na
 * ENTRADA, sem precisar interceptar `res.end`/`res.writeHead` — e isso importa
 * em serverless, porque registrar depois da resposta significa registrar numa
 * promise solta que a plataforma pode congelar antes de completar.
 *
 * Imprecisão conhecida e aceita: um header de pagamento presente mas inválido
 * conta como `paid_attempt` (não como `challenged`), embora a resposta acabe
 * sendo 402. É o comportamento desejável pra este uso — "alguém tentou pagar"
 * é informação melhor que "levou 402".
 */
export function classifyIncoming(params: { paymentHeader: unknown; trialParam: unknown }): UsageKind {
  if (params.paymentHeader) return "paid_attempt";
  if (params.trialParam === "1") return "trial";
  return "challenged";
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
      const kind = classifyIncoming({ paymentHeader: req.headers["x-payment"], trialParam: req.query.trial });
      await recordUsage({ kind, route, channel: "rest", asset });
    } catch {
      // Telemetria nunca bloqueia o produto — segue pro handler real.
    } finally {
      next();
    }
  };
}
