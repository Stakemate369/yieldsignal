import { describe, it, expect, vi, beforeEach } from "vitest";
import type { logSettledPayment as LogSettledPayment } from "../src/notify/paymentLog.js";
import type { SettleResultContext } from "@x402/core/server";

let logSettledPayment: typeof LogSettledPayment;
let infoMock: ReturnType<typeof vi.fn>;
let warnMock: ReturnType<typeof vi.fn>;

function context(overrides: Partial<SettleResultContext> = {}): SettleResultContext {
  return {
    paymentPayload: {
      x402Version: 1,
      accepted: { scheme: "exact", network: "eip155:8453", asset: "0xusdc", amount: "10000", payTo: "0xreceiver", maxTimeoutSeconds: 300, extra: {} },
      payload: {},
      resource: { url: "https://yieldsignal.vercel.app/signal/weth-base-yield" },
    },
    requirements: { scheme: "exact", network: "eip155:8453", asset: "0xusdc", amount: "10000", payTo: "0xreceiver", maxTimeoutSeconds: 300, extra: {} },
    declaredExtensions: {},
    result: { success: true, payer: "0xbuyer", transaction: "0xtxhash", network: "eip155:8453", amount: "10000" },
    ...overrides,
  } as SettleResultContext;
}

beforeEach(async () => {
  vi.resetModules();
  infoMock = vi.fn();
  warnMock = vi.fn();
  vi.doMock("../src/notify/logger.js", () => ({
    logger: { info: infoMock, warn: warnMock, error: vi.fn() },
  }));
  ({ logSettledPayment } = await import("../src/notify/paymentLog.js"));
});

describe("logSettledPayment", () => {
  it("loga payer, tx, network, amount, paymentToken e resourceUrl reais do contexto de liquidação", () => {
    logSettledPayment(context(), "rest");
    expect(infoMock).toHaveBeenCalledTimes(1);
    const [fields] = infoMock.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      channel: "rest",
      payer: "0xbuyer",
      transaction: "0xtxhash",
      network: "eip155:8453",
      amount: "10000",
      paymentToken: "0xusdc",
      resourceUrl: "https://yieldsignal.vercel.app/signal/weth-base-yield",
    });
  });

  it("usa channel 'mcp' quando chamado do canal MCP", () => {
    logSettledPayment(context(), "mcp");
    const [fields] = infoMock.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.channel).toBe("mcp");
  });

  it("cai pro amount de requirements quando result.amount está ausente (scheme sem settlement parcial)", () => {
    logSettledPayment(context({ result: { success: true, payer: "0xbuyer", transaction: "0xtxhash", network: "eip155:8453" } }), "rest");
    const [fields] = infoMock.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.amount).toBe("10000");
  });

  it("cai pra 'unknown' quando paymentPayload.resource está ausente — best effort, nunca lança", () => {
    const ctx = context();
    // @ts-expect-error simulando um paymentPayload sem resource (campo opcional)
    ctx.paymentPayload.resource = undefined;
    logSettledPayment(ctx, "rest");
    const [fields] = infoMock.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.resourceUrl).toBe("unknown");
  });

  it("nunca lança, mesmo com um contexto malformado — não pode derrubar a liquidação já feita", () => {
    // @ts-expect-error contexto propositalmente inválido
    expect(() => logSettledPayment(null, "rest")).not.toThrow();
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(infoMock).not.toHaveBeenCalled();
  });
});
