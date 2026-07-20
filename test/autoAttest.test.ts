import { describe, it, expect } from "vitest";
import { decideAutoAttest } from "../src/attestation/autoAttest.js";
import type { YieldSignal } from "../src/signal/computeSignal.js";
import type { DecodedSignalAttestation } from "../src/attestation/queryAttestations.js";

function signal(overrides: Partial<YieldSignal> = {}): YieldSignal {
  return {
    asset: "USDC",
    bestProtocol: "compound",
    gapBps: 50,
    rates: [{ protocol: "compound", apyBps: 500, weightedApyBps: 495, source: "onchain", asOf: "2026-07-17T12:00:00.000Z" }],
    asOf: "2026-07-17T12:00:00.000Z",
    ...overrides,
  };
}

function attestation(overrides: Partial<DecodedSignalAttestation> = {}): DecodedSignalAttestation {
  return {
    uid: "0x11",
    attester: "0x22",
    time: Math.floor(new Date("2026-07-17T06:00:00.000Z").getTime() / 1000),
    asset: "USDC",
    bestProtocol: "compound",
    weightedApyBps: 495,
    gapBps: 50,
    asOf: Math.floor(new Date("2026-07-17T06:00:00.000Z").getTime() / 1000),
    ...overrides,
  } as DecodedSignalAttestation;
}

const NOW = new Date("2026-07-17T12:00:00.000Z");

describe("decideAutoAttest", () => {
  it("atesta se não houver atestação anterior", () => {
    const decision = decideAutoAttest({ signal: signal(), lastAttestation: undefined, now: NOW });
    expect(decision.shouldAttest).toBe(true);
    expect(decision.reason).toMatch(/nenhuma atestação anterior/);
  });

  it("atesta se o melhor protocolo mudou", () => {
    const decision = decideAutoAttest({
      signal: signal({ bestProtocol: "aave" }),
      lastAttestation: attestation({ bestProtocol: "compound" }),
      now: NOW,
    });
    expect(decision.shouldAttest).toBe(true);
    expect(decision.reason).toMatch(/melhor protocolo mudou/);
  });

  it("atesta se o gap mudou mais que o limiar (25 bps)", () => {
    const decision = decideAutoAttest({
      signal: signal({ gapBps: 80 }),
      lastAttestation: attestation({ gapBps: 50 }),
      now: NOW,
    });
    expect(decision.shouldAttest).toBe(true);
    expect(decision.reason).toMatch(/gap mudou/);
  });

  it("NÃO atesta se o gap mudou menos que o limiar", () => {
    const decision = decideAutoAttest({
      signal: signal({ gapBps: 60 }),
      lastAttestation: attestation({ gapBps: 50, time: Math.floor(NOW.getTime() / 1000) - 3600 }),
      now: NOW,
    });
    expect(decision.shouldAttest).toBe(false);
  });

  it("atesta se a última atestação passou do teto de frescor (12h)", () => {
    const decision = decideAutoAttest({
      signal: signal(),
      lastAttestation: attestation({ time: Math.floor(NOW.getTime() / 1000) - 13 * 3600 }),
      now: NOW,
    });
    expect(decision.shouldAttest).toBe(true);
    expect(decision.reason).toMatch(/teto de frescor/);
  });

  it("NÃO atesta se sinal estável e atestação recente", () => {
    const decision = decideAutoAttest({
      signal: signal(),
      lastAttestation: attestation({ time: Math.floor(NOW.getTime() / 1000) - 3600 }),
      now: NOW,
    });
    expect(decision.shouldAttest).toBe(false);
    expect(decision.reason).toMatch(/nada a fazer/);
  });
});
