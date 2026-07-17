import fs from "node:fs";
import path from "node:path";
import { logger } from "../notify/logger.js";

interface WalletLock {
  address: string;
  pinnedAt: string;
}

export function lockPathFor(environment: string, baseDir: string = process.cwd()): string {
  return path.resolve(baseDir, `state/${environment}-wallet.lock.json`);
}

/**
 * Lê o endereço travado, se existir. Usado por quem precisa do endereço só
 * como referência/baseline (ex.: cli/withdraw.ts) — nunca como a chave pra
 * RESOLVER a carteira de novo, senão a trava vira tautológica (comparar o
 * endereço consigo mesmo nunca detecta nada). Quem resolve a carteira de
 * verdade deve sempre derivar o endereço a partir das credenciais CDP atuais
 * (nome da conta, não endereço salvo) e só então chamar assertWalletAddressLock.
 */
export function readLockedAddress(environment: string, baseDir: string = process.cwd()): string | null {
  const lockPath = lockPathFor(environment, baseDir);
  if (!fs.existsSync(lockPath)) return null;
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as WalletLock;
  return lock.address;
}

/**
 * Trava o endereço da carteira receptora (auto-provisionada pelo
 * createX402Server a partir de CDP_API_KEY_ID/SECRET/WALLET_SECRET) na
 * primeira verificação e barra qualquer execução seguinte se o endereço
 * resolvido mudar depois disso. Aplicação PROATIVA da lição aprendida no
 * incidente do YieldPilot em 2026-07-16 (troca silenciosa de owner de uma
 * smart wallet CDP quando as credenciais são regeneradas) — aqui a trava
 * já nasce no projeto, em vez de ser adicionada depois de um susto real.
 * Este arquivo só guarda um endereço público, não é segredo.
 */
export function assertWalletAddressLock(
  environment: string,
  resolvedAddress: string,
  baseDir: string = process.cwd(),
): void {
  const lockPath = lockPathFor(environment, baseDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  if (!fs.existsSync(lockPath)) {
    const lock: WalletLock = { address: resolvedAddress, pinnedAt: new Date().toISOString() };
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    logger.warn(
      { address: resolvedAddress, lockPath, environment },
      "endereço da carteira receptora travado pela primeira vez — confira manualmente se é o endereço correto antes de divulgar/usar",
    );
    return;
  }

  const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as WalletLock;
  if (lock.address.toLowerCase() !== resolvedAddress.toLowerCase()) {
    throw new Error(
      `TRAVA DE SEGURANÇA: o endereço da carteira receptora (${environment}) mudou desde a última verificação.\n` +
        `Travado em ${lock.pinnedAt}: ${lock.address}\n` +
        `Resolvido agora:              ${resolvedAddress}\n\n` +
        "Isso normalmente significa que CDP_WALLET_SECRET foi regenerado, criando um owner diferente. " +
        "NÃO aceite pagamentos nem rode o saque até entender por que o endereço mudou. " +
        `Se a mudança for intencional, apague ${lockPath} pra re-travar no endereço novo.`,
    );
  }
}

/**
 * Variante da trava pra ambientes serverless (Vercel), onde não existe disco
 * gravável persistente entre invocações — `assertWalletAddressLock` sozinha
 * não funcionaria (cada cold start veria "nenhum lock ainda" e re-travaria
 * em silêncio, sem nunca detectar uma troca de verdade). Aqui a expectativa
 * vem de configuração (`EXPECTED_WALLET_ADDRESS`), não de um arquivo escrito
 * em runtime — mesma garantia de segurança, sem precisar de banco/KV novo.
 */
export function assertWalletAddressExpectation(expectedAddress: string, resolvedAddress: string): void {
  if (expectedAddress.toLowerCase() !== resolvedAddress.toLowerCase()) {
    throw new Error(
      `TRAVA DE SEGURANÇA: o endereço da carteira receptora não bate com EXPECTED_WALLET_ADDRESS.\n` +
        `Esperado: ${expectedAddress}\n` +
        `Resolvido agora: ${resolvedAddress}\n\n` +
        "Isso normalmente significa que CDP_WALLET_SECRET foi regenerado, criando um owner diferente. " +
        "NÃO aceite pagamentos nem rode o saque até entender por que o endereço mudou.",
    );
  }
}

/**
 * Ponto de entrada único pras duas variantes: usa a checagem por variável de
 * ambiente se `EXPECTED_WALLET_ADDRESS` estiver configurado (produção,
 * serverless); cai pra trava por arquivo local caso contrário (conveniente
 * em desenvolvimento, antes de saber qual vai ser o endereço final).
 */
export function assertWalletAddress(
  environment: string,
  resolvedAddress: string,
  expectedAddress: string,
): void {
  if (expectedAddress) {
    assertWalletAddressExpectation(expectedAddress, resolvedAddress);
    return;
  }
  assertWalletAddressLock(environment, resolvedAddress);
}
