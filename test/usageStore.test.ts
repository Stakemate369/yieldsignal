import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveRedisRestConfig,
  usageFields,
  routeFromResourceUrl,
  flatHashToCounts,
  recordUsage,
  recordSale,
  readUsage,
  dayKey,
  TOTAL_KEY,
  __resetMemoryCountsForTest,
  __resetBudgetForTest,
  probeUsageStore,
  type FetchLike,
} from "../src/usage/usageStore.js";

/** Resposta fake do formato do REST do Upstash: array de {result}. */
function okResponse(results: unknown[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => results.map((result) => ({ result })),
  } as unknown as Response;
}

beforeEach(() => {
  __resetMemoryCountsForTest();
  __resetBudgetForTest();
});

describe("resolveRedisRestConfig", () => {
  it("usa o override explícito do projeto quando url e token estão presentes", () => {
    const cfg = resolveRedisRestConfig({
      USAGE_REDIS_REST_URL: "https://redis.example.com/",
      USAGE_REDIS_REST_TOKEN: "tok",
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ url: "https://redis.example.com", token: "tok", source: "USAGE_REDIS_REST_URL" });
  });

  it("casa por SUFIXO, achando a variável PREFIXADA que a integração de storage da Vercel injeta", () => {
    // Nome real observado no projeto irmão: a integração prefixa o par que injeta.
    const cfg = resolveRedisRestConfig({
      UPSTASH_REDIS_REST_KV_REST_API_URL: "https://x.upstash.io",
      UPSTASH_REDIS_REST_KV_REST_API_TOKEN: "tok2",
    } as NodeJS.ProcessEnv);
    expect(cfg?.url).toBe("https://x.upstash.io");
    expect(cfg?.token).toBe("tok2");
    expect(cfg?.source).toBe("UPSTASH_REDIS_REST_KV_REST_API_URL");
  });

  it("prefere o nome mais curto quando as duas formas coexistem (comportamento estável)", () => {
    const cfg = resolveRedisRestConfig({
      KV_REST_API_URL: "https://curto.io",
      KV_REST_API_TOKEN: "curto",
      UPSTASH_REDIS_REST_KV_REST_API_URL: "https://longo.io",
      UPSTASH_REDIS_REST_KV_REST_API_TOKEN: "longo",
    } as NodeJS.ProcessEnv);
    expect(cfg?.url).toBe("https://curto.io");
  });

  it("tira ASPAS ENVOLVENTES do valor — .env costuma guardar URL=\"https://...\" e a aspa viajava pro fetch", () => {
    const cfg = resolveRedisRestConfig({
      UPSTASH_REDIS_REST_KV_REST_API_URL: '"https://x.upstash.io"',
      UPSTASH_REDIS_REST_KV_REST_API_TOKEN: "'tok3'",
    } as NodeJS.ProcessEnv);
    expect(cfg?.url).toBe("https://x.upstash.io");
    expect(cfg?.token).toBe("tok3");
  });

  it("devolve null quando existe URL mas não existe o token correspondente", () => {
    expect(resolveRedisRestConfig({ KV_REST_API_URL: "https://x.io" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("devolve null num ambiente sem nenhuma credencial", () => {
    expect(resolveRedisRestConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("usageFields", () => {
  it("gera um campo agregado e um detalhado", () => {
    expect(usageFields({ kind: "challenged", channel: "rest", route: "signal", asset: "USDC" })).toEqual([
      "challenged",
      "challenged:rest:signal:USDC",
    ]);
  });

  it("inclui o qualificador outcome (venda externa x autoteste)", () => {
    expect(usageFields({ kind: "settled", channel: "mcp", route: "decision", outcome: "external" })).toEqual([
      "settled",
      "settled:mcp:decision:external",
    ]);
  });

  it("não duplica o campo quando o evento não tem nenhum detalhe", () => {
    expect(usageFields({ kind: "not_found" })).toEqual(["not_found"]);
  });
});

describe("routeFromResourceUrl", () => {
  it("distingue decision de signal pelo path do recurso pago", () => {
    expect(routeFromResourceUrl("https://x.app/decision/usdc-base-yield")).toBe("decision");
    expect(routeFromResourceUrl("https://x.app/signal/eth-staking-yield")).toBe("signal");
    expect(routeFromResourceUrl("https://x.app/outra")).toBe("other");
    expect(routeFromResourceUrl(undefined)).toBe("other");
  });
});

describe("flatHashToCounts", () => {
  it("converte o array plano do HGETALL em objeto numérico", () => {
    expect(flatHashToCounts(["challenged", "3", "served", "1"])).toEqual({ challenged: 3, served: 1 });
  });

  it("aceita também objeto direto (backends que já devolvem mapa)", () => {
    expect(flatHashToCounts({ challenged: "2" })).toEqual({ challenged: 2 });
  });

  it("degrada valor não numérico pra 0 em vez de NaN", () => {
    expect(flatHashToCounts(["x", "abc"])).toEqual({ x: 0 });
  });

  it("devolve objeto vazio pra chave inexistente (null)", () => {
    expect(flatHashToCounts(null)).toEqual({});
  });
});

describe("recordUsage", () => {
  const env = { KV_REST_API_URL: "https://r.io", KV_REST_API_TOKEN: "t" } as NodeJS.ProcessEnv;

  it("incrementa o dia E o total, e põe TTL no dia", async () => {
    const fetchImpl = vi.fn(async () => okResponse([1, 1, 1, 1, 1, 1])) as unknown as FetchLike;
    const now = new Date("2026-07-29T12:00:00Z");
    const ok = await recordUsage({ kind: "challenged", channel: "rest", route: "signal", asset: "USDC" }, { fetchImpl, env, now });

    expect(ok).toBe(true);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://r.io/pipeline");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
    const commands = JSON.parse(init.body as string) as unknown[][];
    // contador de orçamento + 2 campos x 2 chaves + EXPIRE
    expect(commands).toHaveLength(6);
    expect(commands).toEqual(
      expect.arrayContaining([
        ["HINCRBY", dayKey(now), "challenged", 1],
        ["HINCRBY", TOTAL_KEY, "challenged", 1],
        ["HINCRBY", dayKey(now), "challenged:rest:signal:USDC", 1],
      ]),
    );
    expect(commands[commands.length - 1][0]).toBe("EXPIRE");
  });

  it("devolve false e NÃO lança quando o fetch rejeita — telemetria nunca derruba a request", async () => {
    const fetchImpl = (async () => {
      throw new Error("rede caiu");
    }) as unknown as FetchLike;
    await expect(recordUsage({ kind: "served" }, { fetchImpl, env })).resolves.toBe(false);
  });

  it("devolve false quando o Redis responde status não-ok", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => [] }) as unknown as Response) as FetchLike;
    await expect(recordUsage({ kind: "served" }, { fetchImpl, env })).resolves.toBe(false);
  });

  it("devolve false (contador em memória) quando não há credencial configurada", async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    await expect(recordUsage({ kind: "served" }, { fetchImpl, env: {} as NodeJS.ProcessEnv })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborta por timeout sem lançar", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as FetchLike;
    await expect(recordUsage({ kind: "served" }, { fetchImpl, env, timeoutMs: 5 })).resolves.toBe(false);
  });
});

describe("recordSale", () => {
  it("empilha a venda e corta a lista (LPUSH + LTRIM)", async () => {
    const fetchImpl = vi.fn(async () => okResponse([1, "OK"])) as unknown as FetchLike;
    const ok = await recordSale(
      {
        at: "2026-07-27T23:45:41.000Z",
        payer: "0xfe2d",
        amount: "10000",
        resource: "https://x.app/signal/usdc-base-yield",
        channel: "rest",
        transaction: "0xeb07",
        external: true,
      },
      { fetchImpl, env: { KV_REST_API_URL: "https://r.io", KV_REST_API_TOKEN: "t" } as NodeJS.ProcessEnv },
    );
    expect(ok).toBe(true);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const commands = JSON.parse(init.body as string) as unknown[][];
    expect(commands[0][0]).toBe("LPUSH");
    expect(commands[1][0]).toBe("LTRIM");
    expect(String(commands[0][2])).toContain("0xfe2d");
  });
});

describe("readUsage", () => {
  it("marca durable:false e devolve o contador em memória sem credencial", async () => {
    await recordUsage({ kind: "served" }, { env: {} as NodeJS.ProcessEnv, fetchImpl: vi.fn() as unknown as FetchLike });
    const report = await readUsage(3, { env: {} as NodeJS.ProcessEnv });
    expect(report.durable).toBe(false);
    expect(report.backend).toBeNull();
    expect(report.total.served).toBe(1);
  });

  it("monta o relatório a partir do pipeline (total, dias com dado e vendas)", async () => {
    const now = new Date("2026-07-29T12:00:00Z");
    const sale = JSON.stringify({ at: "2026-07-27T23:45:41.000Z", payer: "0xfe2d", external: true });
    const fetchImpl = (async () =>
      okResponse([
        ["challenged", "9", "served", "4"], // total
        ["challenged", "2"], // hoje
        [], // ontem, sem dado
        [], // anteontem
        [sale, "{lixo-não-json}"],
      ])) as FetchLike;

    const report = await readUsage(3, {
      env: { KV_REST_API_URL: "https://r.io", KV_REST_API_TOKEN: "t" } as NodeJS.ProcessEnv,
      fetchImpl,
      now,
    });

    expect(report.durable).toBe(true);
    expect(report.backend).toBe("KV_REST_API_URL");
    expect(report.total).toEqual({ challenged: 9, served: 4 });
    expect(report.days).toEqual([{ day: "2026-07-29", counts: { challenged: 2 } }]);
    // Venda malformada é descartada em silêncio, a boa sobrevive.
    expect(report.sales).toHaveLength(1);
    expect(report.sales[0].payer).toBe("0xfe2d");
  });
});

describe("teto diário de eventos (protege a cota compartilhada)", () => {
  const env = { KV_REST_API_URL: "https://r.io", KV_REST_API_TOKEN: "t", USAGE_MAX_EVENTS_PER_DAY: "3" } as NodeJS.ProcessEnv;

  beforeEach(() => {
    __resetBudgetForTest();
  });

  it("o contador de eventos vem primeiro no pipeline (resultado[0] é o total do dia)", async () => {
    const fetchImpl = vi.fn(async () => okResponse([1, 1, 1, 1, 1, 1])) as unknown as FetchLike;
    await recordUsage({ kind: "challenged", asset: "USDC" }, { fetchImpl, env });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const commands = JSON.parse(init.body as string) as unknown[][];
    expect(commands[0][2]).toBe("_events");
  });

  it("para de gastar comandos com RUÍDO depois de estourar o teto, até virar o dia", async () => {
    // Primeira gravação já devolve contador no teto (3) -> marca estourado.
    const fetchImpl = vi.fn(async () => okResponse([3, 1, 1, 1, 1, 1])) as unknown as FetchLike;
    const now = new Date("2026-07-29T10:00:00Z");
    await recordUsage({ kind: "challenged" }, { fetchImpl, env, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Varredura seguinte no MESMO dia não faz request nenhum.
    await recordUsage({ kind: "challenged" }, { fetchImpl, env, now });
    await recordUsage({ kind: "not_found" }, { fetchImpl, env, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Dia seguinte volta a gravar tudo.
    await recordUsage({ kind: "challenged" }, { fetchImpl, env, now: new Date("2026-07-30T10:00:00Z") });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Regressão de 10/08/2026: com o teto valendo pra todo mundo, o ruído de
  // varredura (~700/dia contra teto de 800) enchia o orçamento antes do meio do
  // dia e o funil registrava `settled: 1` para 17 liquidações reais — apagando
  // justamente as linhas que dizem se o serviço vende.
  it("etapas de venda continuam gravando mesmo com o teto estourado", async () => {
    const fetchImpl = vi.fn(async () => okResponse([3, 1, 1, 1, 1, 1])) as unknown as FetchLike;
    const now = new Date("2026-07-29T10:00:00Z");
    await recordUsage({ kind: "challenged" }, { fetchImpl, env, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await recordUsage({ kind: "paid_attempt" }, { fetchImpl, env, now });
    await recordUsage({ kind: "served" }, { fetchImpl, env, now });
    await recordUsage({ kind: "settled" }, { fetchImpl, env, now });
    await recordUsage({ kind: "failed" }, { fetchImpl, env, now });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("abaixo do teto não pausa nada", async () => {
    const fetchImpl = vi.fn(async () => okResponse([1, 1, 1, 1, 1, 1])) as unknown as FetchLike;
    await recordUsage({ kind: "served" }, { fetchImpl, env });
    await recordUsage({ kind: "served" }, { fetchImpl, env });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("probeUsageStore (vigia)", () => {
  const env = { KV_REST_API_URL: "https://r.io", KV_REST_API_TOKEN: "t" } as NodeJS.ProcessEnv;

  it("ok quando grava e lê de volta o mesmo valor", async () => {
    const now = new Date("2026-07-29T10:00:00Z");
    const fetchImpl = (async () => okResponse(["OK", String(now.getTime()), 1])) as FetchLike;
    const health = await probeUsageStore({ fetchImpl, env, now });
    expect(health).toEqual({ ok: true, durable: true, backend: "KV_REST_API_URL" });
  });

  it("NÃO ok quando lê de volta valor diferente (store respondendo lixo)", async () => {
    const fetchImpl = (async () => okResponse(["OK", "valor-errado", 1])) as FetchLike;
    const health = await probeUsageStore({ fetchImpl, env, now: new Date("2026-07-29T10:00:00Z") });
    expect(health.ok).toBe(false);
    expect(health.error).toMatch(/leu de volta valor diferente/);
  });

  it("NÃO ok quando o store não responde", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 429, json: async () => [] }) as unknown as Response) as FetchLike;
    const health = await probeUsageStore({ fetchImpl, env });
    expect(health.ok).toBe(false);
    expect(health.error).toMatch(/não respondeu/);
  });

  it("NÃO ok e sem backend quando não há credencial (contando só em memória)", async () => {
    const health = await probeUsageStore({ env: {} as NodeJS.ProcessEnv });
    expect(health).toMatchObject({ ok: false, durable: false, backend: null });
  });

  it("nunca lança, mesmo com o fetch explodindo", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as FetchLike;
    await expect(probeUsageStore({ fetchImpl, env })).resolves.toMatchObject({ ok: false });
  });
});
