import { describe, it, expect } from "vitest";
import { decodeAbiParameters, decodeFunctionData, zeroAddress, zeroHash } from "viem";
import { encodeSignalData, encodeSignalDataV2, buildAttestCalldata } from "../src/attestation/encodeSignalAttestation.js";
import { EAS_ABI, SIGNAL_SCHEMA_TYPES, SIGNAL_SCHEMA_TYPES_V2 } from "../src/attestation/schema.js";
import type { YieldSignal } from "../src/signal/computeSignal.js";

function signal(overrides: Partial<YieldSignal> = {}): YieldSignal {
  return {
    asset: "USDC",
    bestProtocol: "compound",
    gapBps: 57,
    rates: [
      { protocol: "compound", apyBps: 500, apyBaseBps: 500, apyRewardBps: 0, rewardBasis: "reported", tvlUsd: 5_000_000, tvlBasis: "total-supplied", weightedApyBps: 495, source: "onchain", asOf: "2026-07-17T12:00:00.000Z" },
      { protocol: "moonwell", apyBps: 440, apyBaseBps: 440, apyRewardBps: 0, rewardBasis: "reported", tvlUsd: 5_000_000, tvlBasis: "total-supplied", weightedApyBps: 438, source: "defillama", asOf: "2026-07-17T12:00:00.000Z" },
    ],
    omittedProtocols: [],
    coverage: { read: 2, expected: 2 },
    apyBasis: "supply-apy-total-incl-rewards",
    incompleteRewardData: [],
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

/**
 * Schema v2 (ver SIGNAL_SCHEMA_V2): grava também o 2º colocado e a cobertura da
 * leitura. Sem isso, a pontuação por janela consegue dizer se a chamada se
 * sustentou, mas nunca contra o que ela competia — e o histórico público não
 * distingue atestação feita sobre leitura completa de outra feita com fonte muda.
 */
describe("encodeSignalDataV2", () => {
  it("codifica os 9 campos do v2 e é decodificável de volta", () => {
    const fixture = signal();
    const decoded = decodeAbiParameters(SIGNAL_SCHEMA_TYPES_V2, encodeSignalDataV2(fixture));
    expect(decoded[0]).toBe(fixture.asset);
    expect(decoded[1]).toBe(fixture.bestProtocol);
    expect(decoded[5]).toBe("moonwell"); // 2º colocado
    expect(Number(decoded[6])).toBe(438);
    expect(Number(decoded[7])).toBe(fixture.coverage.read);
    expect(Number(decoded[8])).toBe(fixture.coverage.expected);
  });

  it("o v1 continua sendo prefixo exato do v2 — mesma ordem, mesmos 5 primeiros campos", () => {
    const fixture = signal();
    const v1 = decodeAbiParameters(SIGNAL_SCHEMA_TYPES, encodeSignalData(fixture));
    const v2 = decodeAbiParameters(SIGNAL_SCHEMA_TYPES_V2, encodeSignalDataV2(fixture));
    expect(v2.slice(0, 5)).toEqual(v1);
  });

  it("sem 2º colocado grava vazio/zero em vez de inventar concorrente", () => {
    const solo = signal();
    solo.rates = solo.rates.filter((r) => r.protocol === solo.bestProtocol);
    const decoded = decodeAbiParameters(SIGNAL_SCHEMA_TYPES_V2, encodeSignalDataV2(solo));
    expect(decoded[5]).toBe("");
    expect(Number(decoded[6])).toBe(0);
  });

  it("buildAttestCalldata só grava no formato v2 quando a versão é pedida explicitamente", () => {
    const fixture = signal();
    const uid = `0x${"11".repeat(32)}` as `0x${string}`;
    expect(buildAttestCalldata(uid, fixture)).toBe(buildAttestCalldata(uid, fixture, 1));
    expect(buildAttestCalldata(uid, fixture, 2)).not.toBe(buildAttestCalldata(uid, fixture, 1));
  });
});
