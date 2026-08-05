import { describe, expect, it } from "vitest";
import { borrowApyBpsAt, type BorrowRateCurve } from "../src/market-data/rateCurve.js";
import { compoundedRateToApyBps } from "../src/market-data/apyMath.js";

/**
 * Parâmetros REAIS lidos do Comet de USDC na Base em 2026-08-05, e as respostas
 * REAIS que `getBorrowRate(u)` deu nas mesmas utilizações. Não são números
 * inventados pra fazer o teste passar: são o contrato falando.
 */
const WAD = 1e18;
const COMET_USDC = { kink: 0.9, base: 475646879, slopeLow: 880834601, slopeHigh: 114155251141 };
const CONTRACT_ANSWERS: Record<number, number> = {
  5000: 916064179,
  8500: 1224356289,
  9000: 1268398019,
  9300: 4693055553,
  9900: 11542370621,
};

const compoundCurve: BorrowRateCurve = {
  protocol: "compound",
  kinkBps: 9_000,
  rateAtZero: COMET_USDC.base / WAD,
  rateAtKink: (COMET_USDC.base + COMET_USDC.slopeLow * COMET_USDC.kink) / WAD,
  rateAtFull: (COMET_USDC.base + COMET_USDC.slopeLow * COMET_USDC.kink + COMET_USDC.slopeHigh * (1 - COMET_USDC.kink)) / WAD,
  perSecond: true,
  basis: "onchain-rate-function",
};

describe("borrowApyBpsAt", () => {
  // O teste que importa: a curva reconstruída tem que devolver o MESMO APY que
  // sairia da resposta do próprio contrato. Se a fórmula do Comet mudar, ou se
  // alguém mexer na interpolação, isto quebra.
  it.each(Object.entries(CONTRACT_ANSWERS))(
    "reproduz a resposta do contrato em %s bps de utilização",
    (utilizationBps, perSecondRate) => {
      const doContrato = compoundedRateToApyBps(perSecondRate / WAD, true);
      expect(borrowApyBpsAt(compoundCurve, Number(utilizationBps))).toBe(doContrato);
    },
  );

  it("sobe muito mais rápido depois do joelho", () => {
    const antes = borrowApyBpsAt(compoundCurve, 9_000) - borrowApyBpsAt(compoundCurve, 8_700);
    const depois = borrowApyBpsAt(compoundCurve, 9_300) - borrowApyBpsAt(compoundCurve, 9_000);
    expect(depois).toBeGreaterThan(antes * 10);
  });

  // Curva linear simples (Aave-like, APR anual) pra checar a interpolação sem o
  // ruído da composição por segundo.
  const linear: BorrowRateCurve = {
    protocol: "aave",
    kinkBps: 9_000,
    rateAtZero: 0,
    rateAtKink: 0.045,
    rateAtFull: 0.145,
    perSecond: false,
    basis: "onchain-curve-params",
  };

  it("interpola linearmente nas duas pernas", () => {
    expect(borrowApyBpsAt(linear, 0)).toBe(0);
    // Metade do caminho até o joelho = metade da inclinação 1.
    expect(borrowApyBpsAt(linear, 4_500)).toBe(compoundedRateToApyBps(0.0225, false));
    expect(borrowApyBpsAt(linear, 9_000)).toBe(compoundedRateToApyBps(0.045, false));
    // Metade do caminho entre o joelho e 100%.
    expect(borrowApyBpsAt(linear, 9_500)).toBe(compoundedRateToApyBps(0.095, false));
    expect(borrowApyBpsAt(linear, 10_000)).toBe(compoundedRateToApyBps(0.145, false));
  });

  // Extrapolar além do domínio em que a curva foi definida seria inventar.
  it("grampeia utilização fora de 0-100% em vez de extrapolar", () => {
    expect(borrowApyBpsAt(linear, -5_000)).toBe(borrowApyBpsAt(linear, 0));
    expect(borrowApyBpsAt(linear, 50_000)).toBe(borrowApyBpsAt(linear, 10_000));
  });

  it("não divide por zero com joelho degenerado", () => {
    const semPernaBaixa: BorrowRateCurve = { ...linear, kinkBps: 0 };
    const semPernaAlta: BorrowRateCurve = { ...linear, kinkBps: 10_000 };
    expect(Number.isFinite(borrowApyBpsAt(semPernaBaixa, 5_000))).toBe(true);
    expect(Number.isFinite(borrowApyBpsAt(semPernaAlta, 5_000))).toBe(true);
  });
});
