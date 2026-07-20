import { describe, it, expect } from "vitest";
import { keccak256, toBytes, verifyTypedData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignalTypedData, eip712ForTransport } from "../src/signal/signResponse.js";
import type { YieldSignal } from "../src/signal/computeSignal.js";

function signal(overrides: Partial<YieldSignal> = {}): YieldSignal {
  return {
    asset: "USDC",
    bestProtocol: "compound",
    gapBps: 57,
    rates: [
      { protocol: "compound", apyBps: 500, weightedApyBps: 495, source: "onchain", asOf: "2026-07-17T12:00:00.000Z" },
      { protocol: "moonwell", apyBps: 440, weightedApyBps: 438, source: "defillama", asOf: "2026-07-17T12:00:00.000Z" },
    ],
    asOf: "2026-07-17T12:00:05.000Z",
    ...overrides,
  };
}

describe("buildSignalTypedData", () => {
  it("amarra o contentHash ao texto exato servido (keccak256)", () => {
    const raw = JSON.stringify(signal());
    const typed = buildSignalTypedData(signal(), raw, 8453);
    expect(typed.message.contentHash).toBe(keccak256(toBytes(raw)));
  });

  it("reusa os campos manchete do sinal (mesmos tipos do schema EAS)", () => {
    const raw = JSON.stringify(signal());
    const typed = buildSignalTypedData(signal(), raw, 8453);
    expect(typed.message.asset).toBe("USDC");
    expect(typed.message.bestProtocol).toBe("compound");
    expect(typed.message.weightedApyBps).toBe(495n);
    expect(typed.message.gapBps).toBe(57n);
    expect(typed.message.asOf).toBe(1784289605n);
    expect(typed.domain).toEqual({ name: "YieldSignal", version: "1", chainId: 8453 });
  });

  it("lança se bestProtocol não estiver em rates (sinal inconsistente)", () => {
    const raw = "{}";
    expect(() => buildSignalTypedData(signal({ bestProtocol: "aave" }), raw, 8453)).toThrow(/inconsistente/);
  });

  it("assinatura EIP-712 sobre o typed data é verificável de ponta a ponta (viem.verifyTypedData)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const raw = JSON.stringify(signal());
    const typed = buildSignalTypedData(signal(), raw, 8453);
    const signature = await account.signTypedData(typed);

    const valid = await verifyTypedData({
      address: account.address,
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
      signature,
    });
    expect(valid).toBe(true);
  });
});

describe("eip712ForTransport", () => {
  it("achata bigint pra string decimal, seguro pra JSON.stringify", () => {
    const raw = JSON.stringify(signal());
    const typed = buildSignalTypedData(signal(), raw, 8453);
    const transport = eip712ForTransport(typed);
    expect(() => JSON.stringify(transport)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(transport));
    expect(parsed.message.weightedApyBps).toBe("495");
    expect(parsed.message.gapBps).toBe("57");
    expect(parsed.message.asOf).toBe("1784289605");
    expect(parsed.message.contentHash).toBe(typed.message.contentHash);
  });
});
