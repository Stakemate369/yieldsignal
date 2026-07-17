/**
 * Memoização simples com TTL — mesmo padrão já usado em defillamaPools.ts
 * (cache + promise em voo compartilhada), extraído aqui pra reaproveitar nos
 * leitores da Camada 1 (Aave/Compound), que liam direto on-chain a cada
 * chamada paga. Com múltiplos agentes chamando com frequência, isso vira
 * gargalo de RPC público de verdade — um TTL curto (30-60s) resolve sem
 * comprometer a "atualidade" que é o produto vendido (taxa de juros não
 * muda materialmente em escala de segundos).
 */
export function cachedWithTtl<T>(fn: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let cache: { value: T; fetchedAt: number } | null = null;
  let inFlight: Promise<T> | null = null;

  return async () => {
    if (cache && Date.now() - cache.fetchedAt < ttlMs) return cache.value;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const value = await fn();
        cache = { value, fetchedAt: Date.now() };
        return value;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
