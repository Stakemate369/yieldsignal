const SECONDS_PER_YEAR = 31_536_000;

/**
 * Converte uma taxa por-segundo (fração decimal, ex.: rate/1e18 ou rate/1e27
 * já resolvido pelo chamador) em APY composto, em basis points. Mesma fórmula
 * usada tanto pra Aave (liquidityRate em ray, anualizado linear) quanto pra
 * Compound (getSupplyRate por segundo) — extraída pra um só lugar depois de
 * estar duplicada nos dois arquivos com o mesmo comentário "mesmo padrão".
 */
export function compoundedRateToApyBps(perSecondOrPerYearFraction: number, alreadyPerSecond: boolean): number {
  const perSecond = alreadyPerSecond ? perSecondOrPerYearFraction : perSecondOrPerYearFraction / SECONDS_PER_YEAR;
  const apy = Math.pow(1 + perSecond, SECONDS_PER_YEAR) - 1;
  return Math.round(apy * 10_000);
}
