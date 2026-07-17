/**
 * Dois padrões de retry curto usados nos caminhos de execução real, pra
 * mitigar RPC replica lag: um passo on-chain confirma, mas a próxima leitura
 * dependente (saldo, allowance, estimativa de gas) bate num nó/serviço que
 * ainda não viu o bloco mais recente. Mesmo módulo já provado no YieldPilot
 * (bugs reais encontrados e corrigidos lá em 2026-07-16) — copiado aqui
 * porque a mesma classe de problema se aplica a qualquer leitura/transação
 * via RPC público da Base.
 */

export async function retryUntil<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const { attempts = 5, delayMs = 1500 } = options;
  let value: T | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      value = await read();
      lastErr = undefined;
      if (predicate(value)) return value;
    } catch (err) {
      lastErr = err;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (lastErr !== undefined) throw lastErr;
  return value as T;
}

export async function retryOnError<T>(
  send: () => Promise<T>,
  isRetryable: (err: unknown) => boolean,
  options: { attempts?: number; delayMs?: number; onRetry?: (attempt: number, err: unknown) => void } = {},
): Promise<T> {
  const { attempts = 3, delayMs = 2000, onRetry } = options;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (!isRetryable(err) || attempt === attempts) throw err;
      onRetry?.(attempt, err);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("inalcançável");
}
