import { createHash } from "node:crypto";

const FREE_CALLS_PER_DAY = 3;
const dailyUsage = new Map<string, { day: string; count: number }>();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function ipHash(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

/**
 * Cota gratuita simples pra um agente novo testar antes de pagar — mesmo
 * espírito "dev-first" já validado no QuantumScan (feedback_quantumscan_dev_first_strategy).
 * Contador em memória, por instância serverless "quente": reseta em cold
 * start e não é compartilhado entre instâncias — não é um teto rígido de
 * verdade, mas o objetivo aqui é remover fricção de adoção, não garantir
 * um limite exato. Adicionar um contador persistente de verdade (KV/DB)
 * é um passo futuro, só se a leniência atual virar problema real.
 */
export function consumeFreeTrial(ip: string): boolean {
  const key = ipHash(ip);
  const today = todayKey();
  const existing = dailyUsage.get(key);
  if (!existing || existing.day !== today) {
    dailyUsage.set(key, { day: today, count: 1 });
    return true;
  }
  if (existing.count >= FREE_CALLS_PER_DAY) return false;
  existing.count += 1;
  return true;
}
