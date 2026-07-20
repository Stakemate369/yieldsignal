import { createPublicClient, decodeEventLog, http } from "viem";
import { loadEnv } from "../config/env.js";
import { EAS_BASE_MAINNET, withdrawNetworkFor } from "../config/networks.js";
import { EAS_ABI } from "./schema.js";
import { buildAttestCalldata } from "./encodeSignalAttestation.js";
import type { YieldSignal } from "../signal/computeSignal.js";
import type { SignerAccount } from "../wallet/signerAccount.js";

export interface AttestationResult {
  transactionHash: `0x${string}`;
  uid: `0x${string}`;
}

/** Saldo de ETH insuficiente pra cobrir a reserva mínima configurada — nunca deixa o saldo ir a zero silenciosamente. */
export class InsufficientGasError extends Error {}

/**
 * Publica UMA atestação on-chain (EAS, Base mainnet) de um sinal JÁ
 * CALCULADO — extraído de cli/attestSignal.ts pra ser reaproveitado tanto
 * pelo CLI manual (que calcula o sinal, mostra pro usuário, pede "CONFIRM" e
 * SÓ ENTÃO chama isto) quanto pelo gatilho automático
 * (attestation/autoAttest.ts, que decide sozinho quando vale a pena rodar —
 * não há CONFIRM aqui porque não há humano no loop nesse caminho).
 * Recebe o `signal` já pronto (não recalcula) pra quem chama poder decidir/
 * mostrar ANTES de gastar gas, sem duas leituras de rate por chamada.
 */
export async function publishAttestation(params: {
  signal: YieldSignal;
  signer: SignerAccount;
  schemaUid: `0x${string}`;
  /** Reserva mínima de ETH que deve sobrar — abaixo disso, lança InsufficientGasError em vez de gastar o resto do saldo. */
  minGasReserveWei?: bigint;
}): Promise<AttestationResult> {
  const { signal, signer, schemaUid, minGasReserveWei = 0n } = params;
  const env = loadEnv();
  const { chain } = withdrawNetworkFor(env.X402_ENVIRONMENT);
  const publicClient = createPublicClient({ chain, transport: http() });
  const ethBalance = await publicClient.getBalance({ address: signer.address });
  if (ethBalance < minGasReserveWei) {
    throw new InsufficientGasError(
      `saldo de ETH (${ethBalance} wei) abaixo da reserva mínima configurada (${minGasReserveWei} wei) — ` +
        `atestação pulada pra não drenar o saldo, mande ETH pra ${signer.address} na Base mainnet.`,
    );
  }

  const data = buildAttestCalldata(schemaUid, signal);

  // Mesmo cuidado de cli/withdraw.ts: um erro aqui pode ter acontecido DEPOIS
  // do envio já ter sido aceito (RPC lag, timeout da API da CDP) — reenviar
  // às cegas arrisca publicar uma atestação duplicada.
  let transactionHash: `0x${string}`;
  try {
    transactionHash = await signer.sendTransaction({ to: EAS_BASE_MAINNET.eas, data });
  } catch (err) {
    const balanceAfter = await publicClient.getBalance({ address: signer.address }).catch(() => ethBalance);
    if (balanceAfter < ethBalance) {
      throw new Error(
        `O envio deu erro, mas o saldo de ETH já caiu de ${ethBalance} pra ${balanceAfter} wei — ` +
          `a transação pode ter saído mesmo assim. NÃO tente de novo antes de conferir no BaseScan/EASScan se já ` +
          `existe uma atestação recente de ${signer.address}. Erro original: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw new Error(
      `Falha ao enviar a transação — saldo de ETH intacto (${ethBalance} wei), seguro tentar de novo. ` +
        `Erro original: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

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

  return { transactionHash, uid: attestedLog.args.uid };
}
