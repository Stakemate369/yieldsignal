import { describe, it, expect, vi } from "vitest";
import { classifyIncoming, usageEntryMiddleware } from "../src/usage/usageMiddleware.js";

describe("classifyIncoming", () => {
  it("conta como tentativa de pagamento quando vem header X-PAYMENT", () => {
    expect(classifyIncoming({ paymentHeader: "eyJ4NDAy..." })).toBe("paid_attempt");
  });

  it("sem pagamento é 402 servido — inclui sonda de descoberta", () => {
    expect(classifyIncoming({ paymentHeader: undefined })).toBe("challenged");
  });

  it("header vazio não conta como tentativa de pagamento", () => {
    expect(classifyIncoming({ paymentHeader: "" })).toBe("challenged");
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
