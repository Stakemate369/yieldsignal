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
    });
  });

  it("lança se um campo esperado estiver ausente", () => {
    const broken: RawAttestation = { ...REAL_ATTESTATION_FIXTURE, decodedDataJson: JSON.stringify([]) };
    expect(() => decodeSignalAttestation(broken)).toThrow(/ausente/);
  });
});
