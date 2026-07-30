import { describe, it, expect } from "vitest";
import { decodeSignalAttestation, type RawAttestation } from "../src/attestation/queryAttestations.js";

// Fixture REAL — resposta ao vivo do GraphQL do EASScan (base.easscan.org)
// pra atestação já publicada em produção (2026-07-17), capturada via curl
// nesta sessão. Não inventada: garante que o parser bate com o formato real
// que o EASScan devolve, não com uma suposição de formato.
const REAL_ATTESTATION_FIXTURE: RawAttestation = {
  id: "0xd2e7111462b3b6985b1b2b80a99ffda25302fd6adfd1b732f67b97776b6b5f82",
  attester: "0x561143BFE9E2D975D92e915B8EfFEAa54119472a",
  time: 1784314751,
  decodedDataJson: JSON.stringify([
    { name: "asset", type: "string", signature: "string asset", value: { name: "asset", type: "string", value: "USDC" } },
    {
      name: "bestProtocol",
      type: "string",
      signature: "string bestProtocol",
      value: { name: "bestProtocol", type: "string", value: "fluid" },
    },
    {
      name: "weightedApyBps",
      type: "uint256",
      signature: "uint256 weightedApyBps",
      value: { name: "weightedApyBps", type: "uint256", value: { type: "BigNumber", hex: "0x01ac" } },
    },
    {
      name: "gapBps",
      type: "uint256",
      signature: "uint256 gapBps",
      value: { name: "gapBps", type: "uint256", value: { type: "BigNumber", hex: "0x0d" } },
    },
    {
      name: "asOf",
      type: "uint64",
      signature: "uint64 asOf",
      value: { name: "asOf", type: "uint64", value: { type: "BigNumber", hex: "0x6a5a7b7d" } },
    },
  ]),
};

describe("decodeSignalAttestation", () => {
  it("decodifica a atestação real já publicada em produção", () => {
    const decoded = decodeSignalAttestation(REAL_ATTESTATION_FIXTURE);
    expect(decoded).toEqual({
      uid: REAL_ATTESTATION_FIXTURE.id,
      attester: REAL_ATTESTATION_FIXTURE.attester,
      time: 1784314751,
      asset: "USDC",
      bestProtocol: "fluid",
      weightedApyBps: 428,
      gapBps: 13,
      asOf: 1784314749,
      // Atestação v1: os campos do v2 vêm ausentes e viram null, sem quebrar
      // a leitura do histórico que já está gravado on-chain.
      runnerUpProtocol: null,
      runnerUpWeightedApyBps: null,
      coverage: null,
    });
  });

  it("lança se um campo esperado estiver ausente", () => {
    const broken: RawAttestation = { ...REAL_ATTESTATION_FIXTURE, decodedDataJson: JSON.stringify([]) };
    expect(() => decodeSignalAttestation(broken)).toThrow(/ausente/);
  });
});

/**
 * O schema v2 acrescenta segundo colocado e cobertura (ver SIGNAL_SCHEMA_V2).
 * Os dois formatos precisam conviver no MESMO decodificador: o histórico já
 * gravado é v1 e não pode ser reescrito.
 */
describe("decodeSignalAttestation — schema v2", () => {
  const V2_FIXTURE: RawAttestation = {
    id: "0x1111111111111111111111111111111111111111111111111111111111111111",
    attester: "0x561143BFE9E2D975D92e915B8EfFEAa54119472a",
    time: 1784400000,
    decodedDataJson: JSON.stringify([
      { name: "asset", type: "string", value: { name: "asset", type: "string", value: "WETH" } },
      { name: "bestProtocol", type: "string", value: { name: "bestProtocol", type: "string", value: "euler" } },
      { name: "weightedApyBps", type: "uint256", value: { name: "weightedApyBps", type: "uint256", value: { type: "BigNumber", hex: "0xfd" } } },
      { name: "gapBps", type: "uint256", value: { name: "gapBps", type: "uint256", value: { type: "BigNumber", hex: "0x6c" } } },
      { name: "asOf", type: "uint64", value: { name: "asOf", type: "uint64", value: { type: "BigNumber", hex: "0x6a5bcc00" } } },
      { name: "runnerUpProtocol", type: "string", value: { name: "runnerUpProtocol", type: "string", value: "aave" } },
      { name: "runnerUpWeightedApyBps", type: "uint256", value: { name: "runnerUpWeightedApyBps", type: "uint256", value: { type: "BigNumber", hex: "0x92" } } },
      { name: "protocolsRead", type: "uint256", value: { name: "protocolsRead", type: "uint256", value: { type: "BigNumber", hex: "0x05" } } },
      { name: "protocolsExpected", type: "uint256", value: { name: "protocolsExpected", type: "uint256", value: { type: "BigNumber", hex: "0x06" } } },
    ]),
  };

  it("decodifica o segundo colocado e a cobertura da leitura", () => {
    const decoded = decodeSignalAttestation(V2_FIXTURE);
    expect(decoded.bestProtocol).toBe("euler");
    expect(decoded.runnerUpProtocol).toBe("aave");
    expect(decoded.runnerUpWeightedApyBps).toBe(146);
    expect(decoded.coverage).toEqual({ read: 5, expected: 6 });
  });

  it("segundo colocado vazio (um único protocolo legível) vira null, não string vazia", () => {
    const fields = JSON.parse(V2_FIXTURE.decodedDataJson) as { name: string; value: { value: unknown } }[];
    const solo = fields.map((f) => (f.name === "runnerUpProtocol" ? { ...f, value: { ...f.value, value: "" } } : f));
    const decoded = decodeSignalAttestation({ ...V2_FIXTURE, decodedDataJson: JSON.stringify(solo) });
    expect(decoded.runnerUpProtocol).toBeNull();
  });

  it("cobertura só é reportada se os DOIS campos existirem — meia informação não vira número", () => {
    const fields = (JSON.parse(V2_FIXTURE.decodedDataJson) as { name: string }[]).filter((f) => f.name !== "protocolsExpected");
    const decoded = decodeSignalAttestation({ ...V2_FIXTURE, decodedDataJson: JSON.stringify(fields) });
    expect(decoded.coverage).toBeNull();
  });
});
