import readline from "node:readline/promises";
import { createPublicClient, decodeEventLog, encodeFunctionData, formatEther, http } from "viem";
import { loadEnv } from "../config/env.js";
import { withdrawNetworkFor } from "../config/networks.js";
import { ERC8004_BASE_MAINNET, IDENTITY_REGISTRY_ABI } from "../attestation/erc8004.js";
import { getSignerAccount } from "../wallet/signerAccount.js";
import { logger } from "../notify/logger.js";

const AGENT_URI = "https://yieldsignal.vercel.app/agent-card.json";

/**
 * Registro ÚNICO de identidade ERC-8004 (mint de um NFT ERC-721 permanente
 * representando este agente no IdentityRegistry da Base mainnet) — roda uma
 * vez, gasta um pouco de gas real, e imprime o `agentId` pra colar em
 * `src/agentCard.ts#registrations`. Mesmo padrão de CONFIRM digitado à mão
 * de cli/registerSchema.ts/cli/attestSignal.ts — nunca automático.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (env.X402_ENVIRONMENT !== "production") {
    throw new Error(
      'Identidade ERC-8004 só faz sentido sobre a conta real — rode com X402_ENVIRONMENT="production" (gasta ETH real de gas na Base).',
    );
  }

  const signer = await getSignerAccount();
  const { chain } = withdrawNetworkFor(env.X402_ENVIRONMENT);
  const publicClient = createPublicClient({ chain, transport: http() });
  const ethBalance = await publicClient.getBalance({ address: signer.address });

  console.log("\nRegistro de identidade ERC-8004 — Base mainnet, transação real, gasta ETH de gas.\n");
  console.log(`IdentityRegistry: ${ERC8004_BASE_MAINNET.identityRegistry}`);
  console.log(`agentURI:         ${AGENT_URI}`);
  console.log(`Conta (owner):    ${signer.address}`);
  console.log(`Saldo ETH:        ${formatEther(ethBalance)} ETH`);
  if (ethBalance === 0n) {
    throw new Error(`${signer.address} não tem ETH pra gas na Base mainnet — mande um pouco antes de rodar de novo.`);
  }
  console.log("\nIsso MINTA um NFT (ERC-721) permanente representando esta identidade de agente — público e transferível.");
  console.log('Digite "CONFIRM" pra prosseguir, ou qualquer outra coisa pra cancelar:');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("> ");
  rl.close();
  if (answer.trim() !== "CONFIRM") {
    console.log("Cancelado — nenhuma transação enviada.");
    return;
  }

  const data = encodeFunctionData({ abi: IDENTITY_REGISTRY_ABI, functionName: "register", args: [AGENT_URI] });

  // Mesmo cuidado de cli/withdraw.ts/attestSignal.ts: um erro aqui pode ter
  // acontecido DEPOIS do envio já ter sido aceito.
  let transactionHash: `0x${string}`;
  try {
    transactionHash = await signer.sendTransaction({ to: ERC8004_BASE_MAINNET.identityRegistry, data });
  } catch (err) {
    const balanceAfter = await publicClient.getBalance({ address: signer.address }).catch(() => ethBalance);
    if (balanceAfter < ethBalance) {
      throw new Error(
        `O envio deu erro, mas o saldo de ETH já caiu de ${formatEther(ethBalance)} pra ${formatEther(balanceAfter)} — ` +
          `a transação pode ter saído mesmo assim. NÃO rode "npm run register-agent" de novo antes de conferir no BaseScan ` +
          `se ${signer.address} já tem um agentId. Erro original: ${err instanceof Error ? err.message : String(err)}`,
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
    .filter((log) => log.address.toLowerCase() === ERC8004_BASE_MAINNET.identityRegistry.toLowerCase())
    .map((log) => {
      try {
        return decodeEventLog({ abi: IDENTITY_REGISTRY_ABI, eventName: "Registered", ...log });
      } catch {
        return undefined;
      }
    })
    .find((decoded) => decoded !== undefined);

  if (!registeredLog) {
    throw new Error(
      `Transação confirmou (${transactionHash}) mas não achei o evento "Registered" nos logs — confira manualmente no BaseScan.`,
    );
  }

  const agentId = registeredLog.args.agentId;
  logger.info({ transactionHash, agentId: agentId.toString() }, "identidade ERC-8004 registrada");
  console.log(`\nIdentidade registrada com sucesso.`);
  console.log(`agentId: ${agentId}`);
  console.log(`Verificar: https://basescan.org/tx/${transactionHash}`);
  console.log(`\nAtualize src/agentCard.ts, campo "registrations":`);
  console.log(`  [{ agentId: ${agentId}, agentRegistry: "eip155:${chain.id}:${ERC8004_BASE_MAINNET.identityRegistry}" }]`);
  console.log("...e faça deploy de novo pra publicar o agent-card.json atualizado.");
}

main().catch((err) => {
  logger.error({ err }, "falha registrando identidade ERC-8004");
  process.exit(1);
});
