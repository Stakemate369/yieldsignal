import { describe, it, expect } from "vitest";
import { decodeAbiParameters, decodeFunctionData, zeroAddress, zeroHash } from "viem";
import { encodeSignalData, buildAttestCalldata } from "../src/attestation/encodeSignalAttestation.js";
import { EAS_ABI, SIGNAL_SCHEMA_TYPES } from "../src/attestation/schema.js";
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

describe("encodeSignalData", () => {
  it("codifica os campos manchete na ordem do schema, decodificáveis de volta", () => {
    const data = encodeSignalData(signal());
    const decoded = decodeAbiParameters(SIGNAL_SCHEMA_TYPES, data);
    expect(decoded).toEqual(["USDC", "compound", 495n, 57n, 1784289605n]);
  });

  it("lança se bestProtocol não estiver em rates (sinal inconsistente)", () => {
    expect(() => encodeSignalData(signal({ bestProtocol: "aave" }))).toThrow(/inconsistente/);
  });
});

describe("buildAttestCalldata", () => {
  it("monta calldata de attest() com schema/recipient/revocable corretos e data decodificável", () => {
    const schemaUid = `0x${"11".repeat(32)}` as const;
    const calldata = buildAttestCalldata(schemaUid, signal());

    const { functionName, args } = decodeFunctionData({ abi: EAS_ABI, data: calldata });
    expect(functionName).toBe("attest");
    const [request] = args;
    expect(request.schema).toBe(schemaUid);
    expect(request.data.recipient).toBe(zeroAddress);
    expect(request.data.revocable).toBe(false);
    expect(request.data.refUID).toBe(zeroHash);
    expect(request.data.expirationTime).toBe(0n);

    const decodedSignal = decodeAbiParameters(SIGNAL_SCHEMA_TYPES, request.data.data as `0x${string}`);
    expect(decodedSignal[0]).toBe("USDC");
    expect(decodedSignal[1]).toBe("compound");
  });
});
