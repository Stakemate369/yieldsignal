import { describe, it, expect, vi } from "vitest";
import { retryUntil, retryOnError } from "../src/execution/retry.js";

describe("retryUntil", () => {
  it("retorna na primeira tentativa se o predicate já passa", async () => {
    const read = vi.fn<() => Promise<bigint>>().mockResolvedValue(10n);
    const result = await retryUntil(read, (v) => v > 0n, { attempts: 5, delayMs: 0 });
    expect(result).toBe(10n);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("retenta até o predicate passar (simula RPC replica lag)", async () => {
    const read = vi.fn<() => Promise<bigint>>().mockResolvedValueOnce(0n).mockResolvedValueOnce(0n).mockResolvedValueOnce(42n);
    const result = await retryUntil(read, (v) => v > 0n, { attempts: 5, delayMs: 0 });
    expect(result).toBe(42n);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("esgota as tentativas e retorna o último valor lido, sem lançar", async () => {
    const read = vi.fn<() => Promise<bigint>>().mockResolvedValue(0n);
    const result = await retryUntil(read, (v) => v > 0n, { attempts: 3, delayMs: 0 });
    expect(result).toBe(0n);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("retenta se a própria leitura lançar (RPC falhando de verdade, não só devolvendo dado velho)", async () => {
    const read = vi
      .fn<() => Promise<bigint>>()
      .mockRejectedValueOnce(new Error("RPC Request failed."))
      .mockResolvedValueOnce(42n);
    const result = await retryUntil(read, (v) => v > 0n, { attempts: 5, delayMs: 0 });
    expect(result).toBe(42n);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("propaga o erro se TODAS as tentativas lançarem", async () => {
    const read = vi.fn<() => Promise<bigint>>().mockRejectedValue(new Error("RPC Request failed."));
    await expect(retryUntil(read, (v) => v > 0n, { attempts: 3, delayMs: 0 })).rejects.toThrow("RPC Request failed.");
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe("retryOnError", () => {
  it("retorna na primeira tentativa se não lança", async () => {
    const send = vi.fn().mockResolvedValue("0xhash");
    const result = await retryOnError(send, () => true, { attempts: 3, delayMs: 0 });
    expect(result).toBe("0xhash");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retenta erro retryable e sucede numa tentativa seguinte", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("RPC Request failed."))
      .mockResolvedValueOnce("0xhash");
    const result = await retryOnError(send, (err) => (err as Error).message.includes("RPC Request failed"), {
      attempts: 3,
      delayMs: 0,
    });
    expect(result).toBe("0xhash");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("propaga um erro NÃO retryable já na primeira tentativa, sem retentar", async () => {
    const send = vi.fn().mockRejectedValue(new Error("insufficient balance"));
    await expect(
      retryOnError(send, (err) => (err as Error).message.includes("RPC Request failed"), { attempts: 3, delayMs: 0 }),
    ).rejects.toThrow("insufficient balance");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("propaga o erro retryable depois de esgotar todas as tentativas", async () => {
    const send = vi.fn().mockRejectedValue(new Error("RPC Request failed."));
    await expect(retryOnError(send, () => true, { attempts: 3, delayMs: 0 })).rejects.toThrow("RPC Request failed.");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("chama onRetry a cada tentativa que falha mas ainda vai retentar", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("RPC Request failed.")).mockResolvedValueOnce("0xhash");
    const onRetry = vi.fn();
    await retryOnError(send, () => true, { attempts: 3, delayMs: 0, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });
});
