import { describe, it, expect, vi } from "vitest";
import { classifyIncoming, usageEntryMiddleware } from "../src/usage/usageMiddleware.js";

describe("classifyIncoming", () => {
  it("conta como tentativa de pagamento quando vem o header legado X-PAYMENT", () => {
    expect(classifyIncoming({ paymentHeader: "eyJ4NDAy..." })).toBe("paid_attempt");
  });

  // Regressão de 2026-08-10: checando só `x-payment`, paid_attempt marcou ZERO
  // durante toda a vida do serviço. O x402 v2 manda `payment-signature`, e
  // pagamento real caía em `challenged` — o funil não conseguia separar "tentou
  // pagar" de "desistiu". Ordem e conjunto espelham @x402/express.
  it("conta como tentativa de pagamento com o header v2 payment-signature", () => {
    expect(classifyIncoming({ paymentSignature: "eyJ2Mi4u...", paymentHeader: undefined })).toBe("paid_attempt");
  });

  it("qualquer um dos dois headers basta", () => {
    expect(classifyIncoming({ paymentSignature: "a", paymentHeader: "b" })).toBe("paid_attempt");
  });

  it("sem pagamento é 402 servido — inclui sonda de descoberta", () => {
    expect(classifyIncoming({ paymentSignature: undefined, paymentHeader: undefined })).toBe("challenged");
  });

  it("headers vazios não contam como tentativa de pagamento", () => {
    expect(classifyIncoming({ paymentSignature: "", paymentHeader: "" })).toBe("challenged");
  });
});

describe("usageEntryMiddleware", () => {
  it("sempre chama next(), mesmo sem store configurado", async () => {
    const next = vi.fn();
    const mw = usageEntryMiddleware("signal", "ETH_STAKING");
    // Sem credencial de Redis no ambiente de teste, recordUsage cai no contador
    // em memória e resolve normalmente — o pedido nunca fica preso.
    await mw({ headers: {}, query: {} } as never, {} as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("chama next() mesmo quando o store falha (telemetria não bloqueia o produto)", async () => {
    const next = vi.fn();
    const mw = usageEntryMiddleware("decision", "USDC");
    await mw({ headers: { "x-payment": "abc" }, query: { trial: "1" } } as never, {} as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
