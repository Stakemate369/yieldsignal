import { logger } from "../notify/logger.js";

/**
 * Contador de USO durável — responde "isso está sendo usado, e onde o funil
 * vaza?" sem depender do log de runtime da plataforma.
 *
 * Por que isto existe: o log da Vercel é inacessível por fora (o MCP devolve
 * 403 nesse escopo e a retenção da CLI é curta), então todo `logger.info` de
 * uso que este projeto já escrevia era efetivamente cego — o dono só conseguia
 * auditar o que foi PAGO, lendo `Transfer` de USDC on-chain. Sem os números de
 * 402 servido / trial / erro não há como saber se o problema é "ninguém chega"
 * ou "chega e não paga", que exigem ações opostas.
 *
 * Backend: qualquer Redis com API REST (Upstash, Vercel KV). A descoberta das
 * credenciais é por SUFIXO do nome da variável, não por nome exato, porque a
 * integração de storage da Vercel PREFIXA as variáveis que injeta (no projeto
 * irmão elas chegaram como `UPSTASH_REDIS_REST_KV_REST_API_URL`) — casar só
 * `KV_REST_API_URL` exato daria "não configurado" com o store já conectado.
 *
 * Sem credencial nenhuma, cai num contador em memória: continua útil em
 * desenvolvimento e nunca quebra a produção, mas em serverless cada instância
 * tem o seu (e some no reciclo). `/usage.json` expõe isso como
 * `durable: false` — número parcial nunca deve ser lido como completo.
 *
 * Nada aqui lança: uma falha de telemetria não pode derrubar uma resposta paga
 * nem uma liquidação já feita.
 */

/** Etapas do funil. A ordem aqui é a ordem em que aparecem numa chamada real. */
export type UsageKind =
  /** 402 devolvido: chegou sem pagamento e sem trial (inclui sonda de descoberta). */
  | "challenged"
  /** Chegou COM header de pagamento — tentativa real de compra. */
  | "paid_attempt"
  /** Consumiu uma chamada do free trial (?trial=1). */
  | "trial"
  /** Resposta de produto entregue com sucesso. */
  | "served"
  /** Falha ao gerar o produto (leitura de taxa etc.) — 503. */
  | "failed"
  /** Pagamento liquidado (vem do onAfterSettle, não do middleware). */
  | "settled"
  /** Rota inexistente — mede quanto do tráfego erra o caminho. */
  | "not_found";

export type UsageRoute = "signal" | "decision" | "other";
export type UsageChannel = "rest" | "mcp";

export interface UsageEvent {
  kind: UsageKind;
  route?: UsageRoute;
  channel?: UsageChannel;
  /** AssetId quando aplicável — string livre aqui pra este módulo não depender do domínio. */
  asset?: string;
  /**
   * Qualificador extra do evento (ex.: `external`/`self` num settlement, pra
   * separar venda real de autoteste sem precisar de um `kind` novo).
   */
  outcome?: string;
}

/** Deduz a rota do produto a partir da URL do recurso pago (o settlement só conhece a URL). */
export function routeFromResourceUrl(url: string | undefined): UsageRoute {
  if (!url) return "other";
  if (url.includes("/decision/")) return "decision";
  if (url.includes("/signal/")) return "signal";
  return "other";
}

const KEY_PREFIX = "yieldsignal:usage";
const DAY_TTL_SECONDS = 90 * 24 * 60 * 60;
const SALES_KEY = `${KEY_PREFIX}:sales`;
const SALES_KEEP = 50;
const DEFAULT_TIMEOUT_MS = 800;

/**
 * Campo contador de eventos do dia, usado como ORÇAMENTO. Nome com `_` na
 * frente pra não colidir com nenhum campo de evento real.
 */
const EVENTS_FIELD = "_events";

/**
 * Teto de eventos por dia. Existe porque este store compartilha a instância de
 * Redis com o YieldPilot — um agente que movimenta dinheiro de verdade. Sem
 * teto, uma enxurrada de sondas de descoberta (cada 402 é um evento) poderia
 * consumir a cota do plano free e fazer a gravação de ESTADO do YieldPilot
 * falhar. Telemetria nunca pode degradar o agente financeiro.
 *
 * 800 eventos/dia ≈ 4.800 comandos/dia, ordens de magnitude acima do tráfego
 * real (dezenas por dia) e ainda bem abaixo da cota, deixando folga pro vizinho.
 * As chaves são todas `yieldsignal:usage:*`, então nunca há colisão de dado —
 * a disputa possível é só de cota, e é isso que este teto resolve.
 */
const DEFAULT_MAX_EVENTS_PER_DAY = 800;

function maxEventsPerDay(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.USAGE_MAX_EVENTS_PER_DAY);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_EVENTS_PER_DAY;
}

/**
 * Marca, por instância, que o orçamento do dia estourou. Uma vez marcado, os
 * eventos seguintes não gastam comando NENHUM (nem o INCR do contador). Em
 * serverless cada instância descobre isso por conta própria na primeira
 * gravação depois do teto — custo de descoberta baixo e limitado.
 */
let budgetExhaustedForDay: string | null = null;

/** Só pros testes. */
export function __resetBudgetForTest(): void {
  budgetExhaustedForDay = null;
}

export interface RedisRestConfig {
  url: string;
  token: string;
  /** Nome da variável de ambiente de onde a URL veio — só pra diagnóstico em /usage.json. */
  source: string;
}

/**
 * Acha credencial de Redis REST no ambiente por sufixo. Aceita, em ordem de
 * precedência: override explícito deste projeto, depois qualquer variável
 * terminando em `KV_REST_API_URL` ou `REDIS_REST_URL` (com ou sem prefixo da
 * integração), derivando o token pela mesma variável com `URL`→`TOKEN`.
 */
/**
 * Limpa um valor de variável de ambiente: espaços e ASPAS ENVOLVENTES.
 *
 * As aspas importam de verdade: arquivos `.env` costumam guardar
 * `URL="https://..."`, e copiar esse valor pra um painel/CLI leva as aspas
 * junto. O resultado é `fetch('"https://..."/pipeline')` — URL inválida, exceção
 * capturada, telemetria degradando pra memória em silêncio. Bug real cometido
 * ao portar a credencial do projeto irmão; barato de neutralizar aqui.
 */
function cleanEnvValue(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^['"]|['"]$/g, "").trim();
}

export function resolveRedisRestConfig(env: NodeJS.ProcessEnv = process.env): RedisRestConfig | null {
  const explicitUrl = cleanEnvValue(env.USAGE_REDIS_REST_URL);
  const explicitToken = cleanEnvValue(env.USAGE_REDIS_REST_TOKEN);
  if (explicitUrl && explicitToken) {
    return { url: explicitUrl.replace(/\/+$/, ""), token: explicitToken, source: "USAGE_REDIS_REST_URL" };
  }

  const urlKeys = Object.keys(env).filter((k) => /(?:KV_REST_API_URL|REDIS_REST_URL)$/.test(k));
  // Nome mais curto primeiro: prefere `KV_REST_API_URL` puro ao prefixado,
  // comportamento estável quando as duas formas coexistem.
  urlKeys.sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const urlKey of urlKeys) {
    const url = cleanEnvValue(env[urlKey]);
    if (!url) continue;
    const tokenKey = urlKey.replace(/URL$/, "TOKEN");
    const token = cleanEnvValue(env[tokenKey]);
    if (!token) continue;
    return { url: url.replace(/\/+$/, ""), token, source: urlKey };
  }
  return null;
}

/** Nomes de campo (hash) que um evento incrementa: um agregado + um detalhado. */
export function usageFields(event: UsageEvent): string[] {
  const fields: string[] = [event.kind];
  const parts = [event.kind, event.channel, event.route, event.asset, event.outcome].filter((p): p is string =>
    Boolean(p),
  );
  if (parts.length > 1) fields.push(parts.join(":"));
  return fields;
}

export function dayKey(now: Date = new Date()): string {
  return `${KEY_PREFIX}:day:${now.toISOString().slice(0, 10)}`;
}

export const TOTAL_KEY = `${KEY_PREFIX}:total`;

/** Contador em memória usado quando não há Redis configurado. */
const memoryCounts = new Map<string, number>();
const memorySales: string[] = [];

function bumpMemory(fields: string[]): void {
  for (const f of fields) memoryCounts.set(f, (memoryCounts.get(f) ?? 0) + 1);
}

/** Injetável nos testes — evita rede real. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function redisPipeline(
  config: RedisRestConfig,
  commands: (string | number)[][],
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<unknown[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${config.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "usage store: Redis REST devolveu status não-ok");
      return null;
    }
    const json = (await res.json()) as { result?: unknown; error?: string }[];
    return Array.isArray(json) ? json.map((r) => r?.result ?? null) : null;
  } finally {
    clearTimeout(timer);
  }
}

export interface RecordOptions {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  timeoutMs?: number;
}

/**
 * Registra um evento do funil. `await`-ado de propósito no caminho da request
 * (com timeout curto): em função serverless uma promise solta depois da
 * resposta pode ser congelada antes de completar, e perder justamente o evento
 * da última chamada de uma instância — que, no volume atual, é grande parte dos
 * dados. Nunca lança e nunca propaga erro pro chamador.
 */
export async function recordUsage(event: UsageEvent, options: RecordOptions = {}): Promise<boolean> {
  const fields = usageFields(event);
  try {
    const env = options.env ?? process.env;
    const config = resolveRedisRestConfig(env);
    if (!config) {
      bumpMemory(fields);
      return false;
    }
    const key = dayKey(options.now ?? new Date());

    // Orçamento estourado neste dia: não gasta nem o comando do contador.
    if (budgetExhaustedForDay === key) {
      bumpMemory(fields);
      return false;
    }

    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    // O contador de eventos vem PRIMEIRO pra o resultado[0] ser o total do dia.
    const commands: (string | number)[][] = [["HINCRBY", key, EVENTS_FIELD, 1]];
    for (const f of fields) {
      commands.push(["HINCRBY", key, f, 1]);
      commands.push(["HINCRBY", TOTAL_KEY, f, 1]);
    }
    commands.push(["EXPIRE", key, DAY_TTL_SECONDS]);
    const result = await redisPipeline(config, commands, fetchImpl, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (result === null) {
      bumpMemory(fields);
      return false;
    }

    const eventsToday = Number(result[0]);
    if (Number.isFinite(eventsToday) && eventsToday >= maxEventsPerDay(env)) {
      budgetExhaustedForDay = key;
      logger.warn(
        { eventsToday, key },
        "usage store: teto diário de eventos atingido — telemetria pausada até virar o dia (protege a cota compartilhada com o YieldPilot)",
      );
    }
    return true;
  } catch (err) {
    // Inclui abort por timeout — telemetria nunca é motivo pra falhar a request.
    logger.warn({ err, kind: event.kind }, "usage store: falha registrando evento (ignorada)");
    bumpMemory(fields);
    return false;
  }
}

export interface SaleRecord {
  at: string;
  payer: string;
  amount: string;
  resource: string;
  channel: string;
  transaction: string;
  external: boolean;
}

/**
 * Guarda o registro de uma VENDA de forma durável. Existe porque o alerta de
 * pagador externo hoje só fala por Telegram, e `TELEGRAM_BOT_TOKEN`/`CHAT_ID`
 * não estão configurados em produção — a primeira venda real a um terceiro
 * (2026-07-27) passou silenciosa e só foi descoberta dias depois lendo a
 * blockchain. Com isto a venda fica legível em /usage.json mesmo sem Telegram.
 */
export async function recordSale(sale: SaleRecord, options: RecordOptions = {}): Promise<boolean> {
  try {
    const config = resolveRedisRestConfig(options.env ?? process.env);
    const payload = JSON.stringify(sale);
    if (!config) {
      memorySales.unshift(payload);
      memorySales.splice(SALES_KEEP);
      return false;
    }
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    const result = await redisPipeline(
      config,
      [
        ["LPUSH", SALES_KEY, payload],
        ["LTRIM", SALES_KEY, 0, SALES_KEEP - 1],
      ],
      fetchImpl,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (result === null) {
      memorySales.unshift(payload);
      memorySales.splice(SALES_KEEP);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, "usage store: falha registrando venda (ignorada)");
    return false;
  }
}

export interface UsageReport {
  /** false = número PARCIAL (contador em memória da instância), não leia como total. */
  durable: boolean;
  backend: string | null;
  total: Record<string, number>;
  days: { day: string; counts: Record<string, number> }[];
  sales: SaleRecord[];
  asOf: string;
}

/** Converte o array plano do HGETALL do REST ({f1,v1,f2,v2,...}) em objeto numérico. */
export function flatHashToCounts(flat: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const field = String(flat[i]);
      const value = Number(flat[i + 1]);
      out[field] = Number.isFinite(value) ? value : 0;
    }
    return out;
  }
  // Alguns backends devolvem objeto direto em vez de array plano.
  if (flat && typeof flat === "object") {
    for (const [k, v] of Object.entries(flat as Record<string, unknown>)) {
      const value = Number(v);
      out[k] = Number.isFinite(value) ? value : 0;
    }
  }
  return out;
}

/** Lê o relatório de uso. `days` cobre os últimos `dayCount` dias (hoje inclusive). */
export async function readUsage(dayCount = 14, options: RecordOptions = {}): Promise<UsageReport> {
  const asOf = new Date().toISOString();
  const config = resolveRedisRestConfig(options.env ?? process.env);
  if (!config) {
    return {
      durable: false,
      backend: null,
      total: Object.fromEntries(memoryCounts),
      days: [],
      sales: memorySales.map((s) => JSON.parse(s) as SaleRecord),
      asOf,
    };
  }

  const now = options.now ?? new Date();
  const dayKeys: string[] = [];
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    dayKeys.push(dayKey(d));
  }

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const commands: (string | number)[][] = [
    ["HGETALL", TOTAL_KEY],
    ...dayKeys.map((k) => ["HGETALL", k]),
    ["LRANGE", SALES_KEY, 0, SALES_KEEP - 1],
  ];
  const result = await redisPipeline(config, commands, fetchImpl, (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) * 4);
  if (result === null) {
    return { durable: false, backend: config.source, total: Object.fromEntries(memoryCounts), days: [], sales: [], asOf };
  }

  const total = flatHashToCounts(result[0]);
  const days = dayKeys
    .map((k, i) => ({ day: k.slice(`${KEY_PREFIX}:day:`.length), counts: flatHashToCounts(result[i + 1]) }))
    .filter((d) => Object.keys(d.counts).length > 0);
  const rawSales = result[dayKeys.length + 1];
  const sales: SaleRecord[] = Array.isArray(rawSales)
    ? rawSales.flatMap((s) => {
        try {
          return [JSON.parse(String(s)) as SaleRecord];
        } catch {
          return [];
        }
      })
    : [];

  return { durable: true, backend: config.source, total, days, sales, asOf };
}

export interface StoreHealth {
  /** true = escreveu E leu de volta o valor esperado num store real. */
  ok: boolean;
  /** false = está contando só em memória (número parcial, some no reciclo da instância). */
  durable: boolean;
  /** Nome da variável de ambiente de onde a credencial veio, ou null. */
  backend: string | null;
  error?: string;
}

/**
 * Sonda de saúde do store: grava uma chave própria, lê de volta e apaga.
 *
 * Existe pra que uma quebra da telemetria seja AVISADA em vez de descoberta
 * meses depois. O modo de falha silenciosa é o perigoso: o produto continua
 * funcionando (a telemetria é best-effort de propósito), então nada chama
 * atenção — exatamente o que aconteceu com a primeira venda real, que passou
 * dias sem ninguém saber porque o alerta dependia de uma variável não
 * configurada. Chamada 1x/dia pelo gatilho de auto-attest, que já tem cron
 * externo e já sabe alertar no Telegram: nenhuma infraestrutura nova.
 *
 * Custa ~3 comandos por dia. Nunca lança.
 */
export async function probeUsageStore(options: RecordOptions = {}): Promise<StoreHealth> {
  const env = options.env ?? process.env;
  const config = resolveRedisRestConfig(env);
  if (!config) {
    return { ok: false, durable: false, backend: null, error: "nenhuma credencial de Redis configurada — contando só em memória" };
  }
  const probeKey = `${KEY_PREFIX}:healthprobe`;
  try {
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    const stamp = String((options.now ?? new Date()).getTime());
    const result = await redisPipeline(
      config,
      [
        ["SET", probeKey, stamp, "EX", 120],
        ["GET", probeKey],
        ["DEL", probeKey],
      ],
      fetchImpl,
      (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) * 3,
    );
    if (result === null) {
      return { ok: false, durable: false, backend: config.source, error: "store não respondeu (rede, credencial inválida ou cota estourada)" };
    }
    if (String(result[1]) !== stamp) {
      return {
        ok: false,
        durable: false,
        backend: config.source,
        error: `escreveu mas leu de volta valor diferente (esperado ${stamp}, veio ${String(result[1])})`,
      };
    }
    return { ok: true, durable: true, backend: config.source };
  } catch (err) {
    return {
      ok: false,
      durable: false,
      backend: config.source,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Só pros testes — zera o estado em memória entre casos. */
export function __resetMemoryCountsForTest(): void {
  memoryCounts.clear();
  memorySales.length = 0;
}
