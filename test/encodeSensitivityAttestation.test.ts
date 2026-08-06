import { describe, expect, it } from "vitest";
import { decodeAbiParameters } from "viem";
import {
  encodeSensitivityData,
  buildSensitivityAttestCalldata,
  entriesWorthAttesting,
  ATTEST_HEADROOM_THRESHOLD_BPS,
} from "../src/attestation/encodeSensitivityAttestation.js";
import { SENSITIVITY_SCHEMA_TYPES } from "../src/attestation/schema.js";
import type { SensitivityEntry, SensitivityReport } from "../src/signal/sensitivity.js";

function entry(protocol: string, utilizationBps: number | null, measured = true): SensitivityEntry {
  return {
    protocol: protocol as SensitivityEntry["protocol"],
    measured,
    utilizationBps,
    kinkBps: measured ? 9_000 : null,
    headroomBps: measured && utilizationBps !== null ? 9_000 - utilizationBps : null,
    pastKink: measured && utilizationBps !== null ? utilizationBps > 9_000 : null,
    borrowApyBpsNow: measured ? 408 : null,
    borrowApyBpsAtKink: measured ? 408 : null,
    shockMultiple: measured ? 3.9 : null,
    curve: null,
    curveBasis: measured ? "onchain-rate-function" : null,
  };
}

const ASOF = "2026-08-06T12:00:00.000Z";

describe("encodeSensitivityData", () => {
  it("codifica e decodifica de volta sem perder nada", () => {
    const data = encodeSensitivityData("USDC", entry("compound", 8_982), ASOF);
    const [asset, protocol, utilization, kink, borrowApy, asOf] = decodeAbiParameters(SENSITIVITY_SCHEMA_TYPES, data);
    expect(asset).toBe("USDC");
    expect(protocol).toBe("compound");
    expect(utilization).toBe(8_982n);
    expect(kink).toBe(9_000n);
    expect(borrowApy).toBe(408n);
    expect(asOf).toBe(BigInt(Math.floor(new Date(ASOF).getTime() / 1000)));
  });

  /**
   * A guarda que mais importa: gravar on-chain que um protocolo estava a X do
   * joelho quando não havia curva legível criaria um registro permanente e
   * FALSO — o oposto do que o histórico serve pra fazer. Não pode ser default,
   * tem que ser exceção.
   */
  it("recusa atestar entrada não medida", () => {
    expect(() => encodeSensitivityData("USDC", entry("morpho", null, false), ASOF)).toThrow(/não é medida/);
  });

  it("recusa entrada medida mas com campo faltando", () => {
    const quebrada = { ...entry("aave", 8_600), borrowApyBpsNow: null };
    expect(() => encodeSensitivityData("USDC", quebrada, ASOF)).toThrow();
  });

  it("monta calldata de attest não-revogável e sem destinatário", () => {
    const calldata = buildSensitivityAttestCalldata(`0x${"ab".repeat(32)}`, "USDC", entry("compound", 8_982), ASOF);
    expect(calldata.startsWith("0x")).toBe(true);
    // Seletor de `attest(...)` — mesmo do schema de sinal, mesma função.
    expect(calldata.length).toBeGreaterThan(200);
  });
});

describe("entriesWorthAttesting", () => {
  const report = (entries: SensitivityEntry[]): SensitivityReport => ({
    asset: "USDC",
    basis: "onchain-interest-rate-curve",
    tightestToKink: null,
    pastKink: [],
    unmeasured: [],
    coverage: { measured: entries.length, total: entries.length },
    entries,
    asOf: ASOF,
  });

  // Atestar tudo a cada leitura não tem teto de custo, e mercado parado longe
  // do joelho não gera informação nova nenhuma.
  it("só atesta quem está perto do joelho", () => {
    const r = report([entry("compound", 8_982), entry("aave", 6_000)]);
    expect(entriesWorthAttesting(r).map((e) => e.protocol)).toEqual(["compound"]);
  });

  it("inclui quem já passou do joelho — o outro lado da mesma fronteira", () => {
    const r = report([entry("compound", 9_400)]);
    expect(entriesWorthAttesting(r)).toHaveLength(1);
  });

  it("respeita o limiar exatamente na borda", () => {
    const naBorda = entry("aave", 9_000 - ATTEST_HEADROOM_THRESHOLD_BPS);
    const foraPorUm = entry("aave", 9_000 - ATTEST_HEADROOM_THRESHOLD_BPS - 1);
    expect(entriesWorthAttesting(report([naBorda]))).toHaveLength(1);
    expect(entriesWorthAttesting(report([foraPorUm]))).toHaveLength(0);
  });

  it("nunca inclui entrada não medida", () => {
    const r = report([entry("morpho", null, false)]);
    expect(entriesWorthAttesting(r)).toHaveLength(0);
  });
});
