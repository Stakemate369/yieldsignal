/**
 * Rótulo do caminho que deu 404, com CARDINALIDADE LIMITADA.
 *
 * Por que existe: a primeira leitura do funil (30/07/2026) mostrou 395 `not_found`
 * contra 456 `challenged` — quase metade do tráfego não achou a porta — e o número
 * era inacionável, porque só existia o total. "Agente errando o path do produto" e
 * "scanner varrendo /wp-admin" produzem o mesmo contador e pedem reações opostas: a
 * primeira é um alias que falta, a segunda é ruído a ignorar.
 *
 * Por que NÃO é o caminho cru: cada rótulo vira um campo de hash no Redis, e este
 * store é COMPARTILHADO com o YieldPilot, que guarda estado de um agente que move
 * dinheiro. Gravar o path literal deixaria um scanner criar milhares de campos e
 * estourar a cota free — telemetria derrubando o agente financeiro. Então o conjunto
 * de rótulos possíveis é fechado por construção:
 *
 *   - caminho que parece produto  -> até 2 segmentos normalizados (ex. `signal/usd`)
 *   - caminho de varredura óbvia  -> `noise`
 *   - qualquer outra coisa        -> `other`
 *
 * Isso responde exatamente a pergunta que decide a ação, sem gravar entrada livre.
 */

/** Primeiros segmentos que indicam alguém procurando o PRODUTO, não vasculhando. */
const RAIZES_DE_PRODUTO = new Set([
  "signal",
  "signals",
  "decision",
  "decisions",
  "yield",
  "quote",
  "price",
  "rates",
  "rate",
  "apy",
  "accuracy",
  "track-record",
  "trackrecord",
  "guarantee",
  "agent-card",
  "agentcard",
  "health",
  "usage",
  "mcp",
  "api",
  "v1",
  "well-known",
  "docs",
  "openapi",
  "schema",
  "x402",
]);

/** Marcas de varredura automática de vulnerabilidade — não é cliente perdido. */
const RUIDO = /(wp-|wordpress|phpmyadmin|\.php$|\.asp|\.aspx|cgi-bin|\.git|\.env|\.ssh|\.aws|admin|backup|shell|eval-stdin|vendor|autodiscover|owa\/|boaform|hnap|\.sql|\.zip|\.bak)/i;

const limpar = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 24);

export function notFoundLabel(caminho: string): string {
  if (typeof caminho !== "string" || caminho.length === 0) return "other";
  if (caminho.length > 512) return "noise";
  if (RUIDO.test(caminho)) return "noise";

  const segmentos = caminho.split("/").filter(Boolean);
  if (segmentos.length === 0) return "root";

  const primeiro = limpar(segmentos[0]);
  if (!primeiro) return "other";
  if (!RAIZES_DE_PRODUTO.has(primeiro)) return "other";

  const segundo = segmentos[1] ? limpar(segmentos[1]) : "";
  return segundo ? `${primeiro}/${segundo}` : primeiro;
}
