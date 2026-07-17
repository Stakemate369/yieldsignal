import readline from "node:readline/promises";
import { createPublicClient, decodeEventLog, encodeFunctionData, formatEther, http, zeroAddress } from "viem";
import { loadEnv } from "../config/env.js";
import { EAS_BASE_MAINNET, withdrawNetworkFor } from "../config/networks.js";
import { SCHEMA_REGISTRY_ABI, SIGNAL_SCHEMA } from "../attestation/schema.js";
import { getSignerAccount } from "../wallet/signerAccount.js";
import { logger } from "../notify/logger.js";

/**
 * Registro ÚNICO do schema de atestação — roda uma vez, gasta um pouco de
 * gas real na Base mainnet, e imprime o UID que vai em EAS_SCHEMA_UID pra
 * `npm run attest` funcionar dali em diante. Exige "CONFIRM" digitado à mão,
 * mesmo padrão de cli/withdraw.ts (única outra ação deste projeto que gasta
 * fundo/gas real) — nunca deve ser chamada de forma automática.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (env.X402_ENVIRONMENT !== "production") {
    throw new Error(
      'EAS só faz sentido sobre dado real de mainnet — rode com X402_ENVIRONMENT="production" (gasta ETH real de gas na Base).',
    );
  }
  if (env.EAS_SCHEMA_UID) {
    console.log(`EAS_SCHEMA_UID já está configurado (${env.EAS_SCHEMA_UID}) — nada a fazer.`);
    console.log("Apague a variável antes de rodar este script de novo, se a intenção é registrar um schema novo.");
    return;
  }

  const signer = await getSignerAccount();
  const { chain } = withdrawNetworkFor(env.X402_ENVIRONMENT);
  const publicClient = createPublicClient({ chain, transport: http() });
  const ethBalance = await publicClient.getBalance({ address: signer.address });

  console.log("\nRegistro de schema EAS — Base mainnet, transação real, gasta ETH de gas.\n");
  console.log(`Schema:          "${SIGNAL_SCHEMA}"`);
  console.log(`Resolver:        ${zeroAddress} (nenhum — dado puro, sem lógica de validação on-chain)`);
  console.log(`Revocable:       false (atestações futuras registram um fato histórico, não devem ser apagáveis)`);
  console.log(`SchemaRegistry:  ${EAS_BASE_MAINNET.schemaRegistry}`);
  console.log(`Conta:           ${signer.address}`);
  console.log(`Saldo ETH:       ${formatEther(ethBalance)} ETH`);
  if (ethBalance === 0n) {
    throw new Error(
      `${signer.address} não tem ETH pra gas na Base mainnet — mande um pouco (alguns centavos de dólar bastam) antes de rodar de novo.`,
    );
  }
  console.log('\nDigite "CONFIRM" pra prosseguir, ou qualquer outra coisa pra cancelar:');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("> ");
  rl.close();
  if (answer.trim() !== "CONFIRM") {
    console.log("Cancelado — nenhuma transação enviada.");
    return;
  }

  const data = encodeFunctionData({
    abi: SCHEMA_REGISTRY_ABI,
    functionName: "register",
    args: [SIGNAL_SCHEMA, zeroAddress, false],
  });

  // Mesmo cuidado de cli/withdraw.ts: um erro aqui pode ter acontecido DEPOIS
  // do envio já ter sido aceito. Reenviar às cegas arriscaria só gas perdido
  // aqui (`register()` reverte com `AlreadyExists` num schema duplicado, não
  // duplica o registro de verdade) — mas ainda vale diagnosticar antes de
  // reenviar, mesmo padrão usado em cli/attestSignal.ts.
  let transactionHash: `0x${string}`;
  try {
    transactionHash = await signer.sendTransaction({ to: EAS_BASE_MAINNET.schemaRegistry, data });
  } catch (err) {
    const balanceAfter = await publicClient.getBalance({ address: signer.address }).catch(() => ethBalance);
    if (balanceAfter < ethBalance) {
      throw new Error(
        `O envio deu erro, mas o saldo de ETH já caiu de ${formatEther(ethBalance)} pra ${formatEther(balanceAfter)} — ` +
          `a transação pode ter saído mesmo assim. NÃO rode "npm run register-schema" de novo antes de conferir no BaseScan/EASScan ` +
          `se já existe um schema recente registrado por ${signer.address}. Erro original: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw new Error(
      `Falha ao enviar a transação — saldo de ETH intacto (${formatEther(ethBalance)}), seguro tentar de novo. ` +
        `Erro original: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`\nTransação enviada: ${transactionHash}`);
  console.log("Aguardando confirmação...");

  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success") {
    throw new Error(`Transação confirmou com status "${receipt.status}" — confira no BaseScan antes de tentar de novo.`);
  }

  const registeredLog = receipt.logs
    .filter((log) => log.address.toLowerCase() === EAS_BASE_MAINNET.schemaRegistry.toLowerCase())
    .map((log) => {
      try {
        return decodeEventLog({ abi: SCHEMA_REGISTRY_ABI, eventName: "Registered", ...log });
      } catch {
        return undefined;
      }
    })
    .find((decoded) => decoded !== undefined);

  if (!registeredLog) {
    throw new Error(
      `Transação confirmou (${transactionHash}) mas não achei o evento "Registered" nos logs — confira manualmente no BaseScan/EASScan antes de configurar EAS_SCHEMA_UID.`,
    );
  }

  const uid = registeredLog.args.uid;
  logger.info({ transactionHash, uid }, "schema EAS registrado");
  console.log(`\nSchema registrado com sucesso.`);
  console.log(`UID: ${uid}`);
  console.log(`Verificar: https://base.easscan.org/schema/view/${uid}`);
  console.log(`\nAdicione ao .env (e nas env vars da Vercel): EAS_SCHEMA_UID=${uid}`);
}

main().catch((err) => {
  logger.error({ err }, "falha registrando schema EAS");
  process.exit(1);
});
