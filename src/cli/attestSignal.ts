import readline from "node:readline/promises";
import { createPublicClient, decodeEventLog, formatEther, http } from "viem";
import { loadEnv } from "../config/env.js";
import { EAS_BASE_MAINNET, withdrawNetworkFor } from "../config/networks.js";
import { EAS_ABI } from "../attestation/schema.js";
import { buildAttestCalldata } from "../attestation/encodeSignalAttestation.js";
import { collectRates } from "../signal/collectRates.js";
import { computeSignal } from "../signal/computeSignal.js";
import type { AssetId } from "../market-data/types.js";
import { getSignerAccount } from "../wallet/signerAccount.js";
import { logger } from "../notify/logger.js";

const VALID_ASSETS: AssetId[] = ["USDC", "WETH"];

/**
 * Publica UMA atestação on-chain (EAS, Base mainnet) do sinal calculado
 * agora — registro público permanente de "às HH:MM o protocolo X pagava Y
 * bps, Z à frente do 2º colocado", verificável por qualquer um sem precisar
 * confiar no servidor. Disparo MANUAL de propósito (mesmo padrão de
 * cli/withdraw.ts, CONFIRM digitado à mão): cada chamada gasta um pouco de
 * ETH real de gas, então a frequência é decisão de quem roda, não algo
 * automatizado sem revisão. `npm run attest` (USDC, default) ou
 * `npm run attest -- WETH`.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (env.X402_ENVIRONMENT !== "production") {
    throw new Error('Atestação só faz sentido sobre dado real de mainnet — rode com X402_ENVIRONMENT="production".');
  }
  if (!env.EAS_SCHEMA_UID) {
    throw new Error('EAS_SCHEMA_UID não configurado — rode "npm run register-schema" uma vez antes de atestar.');
  }

  const requested = (process.argv[2] ?? "USDC").toUpperCase();
  if (!VALID_ASSETS.includes(requested as AssetId)) {
    throw new Error(`asset inválido: "${requested}" — use ${VALID_ASSETS.join(" ou ")}`);
  }
  const asset = requested as AssetId;

  const readings = await collectRates(asset);
  const signal = computeSignal(readings);
  const best = signal.rates.find((r) => r.protocol === signal.bestProtocol);

  const signer = await getSignerAccount();
  const { chain } = withdrawNetworkFor(env.X402_ENVIRONMENT);
  const publicClient = createPublicClient({ chain, transport: http() });
  const ethBalance = await publicClient.getBalance({ address: signer.address });

  console.log("\nAtestação EAS — Base mainnet, transação real, gasta ETH de gas.\n");
  console.log(`Asset:            ${signal.asset}`);
  console.log(`Melhor protocolo: ${signal.bestProtocol} (${best?.weightedApyBps} bps ponderado)`);
  console.log(`Vantagem (gap):   ${signal.gapBps} bps sobre o 2º colocado`);
  console.log(`Medido em:        ${signal.asOf}`);
  console.log(`Conta:            ${signer.address}`);
  console.log(`Saldo ETH:        ${formatEther(ethBalance)} ETH`);
  if (ethBalance === 0n) {
    throw new Error(`${signer.address} não tem ETH pra gas na Base mainnet — mande um pouco antes de rodar de novo.`);
  }
  console.log('\nDigite "CONFIRM" pra publicar essa atestação, ou qualquer outra coisa pra cancelar:');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("> ");
  rl.close();
  if (answer.trim() !== "CONFIRM") {
    console.log("Cancelado — nenhuma transação enviada.");
    return;
  }

  const data = buildAttestCalldata(env.EAS_SCHEMA_UID as `0x${string}`, signal);

  // Mesmo cuidado de cli/withdraw.ts: um erro aqui pode ter acontecido DEPOIS
  // do envio já ter sido aceito (RPC lag, timeout da API da CDP) — reenviar
  // às cegas arrisca publicar uma atestação duplicada. Saldo de ETH caindo é
  // o sinal indireto de que a transação pode ter saído mesmo com erro.
  let transactionHash: `0x${string}`;
  try {
    transactionHash = await signer.sendTransaction({ to: EAS_BASE_MAINNET.eas, data });
  } catch (err) {
    const balanceAfter = await publicClient.getBalance({ address: signer.address }).catch(() => ethBalance);
    if (balanceAfter < ethBalance) {
      throw new Error(
        `O envio deu erro, mas o saldo de ETH já caiu de ${formatEther(ethBalance)} pra ${formatEther(balanceAfter)} — ` +
          `a transação pode ter saído mesmo assim. NÃO rode "npm run attest" de novo antes de conferir no BaseScan/EASScan ` +
          `se já existe uma atestação recente de ${signer.address}. Erro original: ${err instanceof Error ? err.message : String(err)}`,
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

  const attestedLog = receipt.logs
    .filter((log) => log.address.toLowerCase() === EAS_BASE_MAINNET.eas.toLowerCase())
    .map((log) => {
      try {
        return decodeEventLog({ abi: EAS_ABI, eventName: "Attested", ...log });
      } catch {
        return undefined;
      }
    })
    .find((decoded) => decoded !== undefined);

  if (!attestedLog) {
    throw new Error(
      `Transação confirmou (${transactionHash}) mas não achei o evento "Attested" nos logs — confira manualmente no BaseScan.`,
    );
  }

  const uid = attestedLog.args.uid;
  logger.info({ transactionHash, uid, asset: signal.asset, bestProtocol: signal.bestProtocol }, "sinal atestado on-chain");
  console.log(`\nAtestação publicada com sucesso.`);
  console.log(`UID: ${uid}`);
  console.log(`Verificar: https://base.easscan.org/attestation/view/${uid}`);
}

main().catch((err) => {
  logger.error({ err }, "falha publicando atestação EAS");
  process.exit(1);
});
