import { keccak256, toBytes } from "viem";
import { loadEnv } from "../config/env.js";
import { withdrawNetworkFor } from "../config/networks.js";
import { SIGNAL_SCHEMA_TYPES } from "../attestation/schema.js";
import { logger } from "../notify/logger.js";
import type { SignerAccount } from "../wallet/signerAccount.js";
import type { YieldSignal } from "./computeSignal.js";

const SIGN_TIMEOUT_MS = 5_000;
const DOMAIN_NAME = "YieldSignal";
const DOMAIN_VERSION = "1";

// Mesmos campos "manchete" do schema EAS (attestation/schema.ts) + contentHash
// — simetria deliberada com o que já vai on-chain (mesma fonte de verdade pros
// tipos), mais um campo extra que amarra o struct tipado ao corpo COMPLETO da
// resposta (que inclui `rates[]`, não só os campos manchete que são atestados).
const SIGNED_SIGNAL_TYPES = [
  ...SIGNAL_SCHEMA_TYPES.map(({ name, type }) => ({ name, type })),
  { name: "contentHash", type: "bytes32" },
] as const;

export interface SignedSignalMessage {
  [key: string]: unknown;
  asset: string;
  bestProtocol: string;
  weightedApyBps: bigint;
  gapBps: bigint;
  asOf: bigint;
  contentHash: `0x${string}`;
}

export interface SignalTypedData {
  domain: { name: string; version: string; chainId: number };
  types: { YieldSignal: typeof SIGNED_SIGNAL_TYPES };
  primaryType: "YieldSignal";
  message: SignedSignalMessage;
}

export interface SignedPayload {
  signature: `0x${string}`;
  signer: `0x${string}`;
  eip712: SignalTypedData;
}

/**
 * Monta o struct EIP-712 pro sinal — puro, sem I/O, mesmo espírito de
 * attestation/encodeSignalAttestation.ts (aliás usa os MESMOS tipos de campo).
 * `chainId` no domain não é sobre onde a assinatura seria usada em tx nenhuma
 * (não existe contrato verificador) — é só desambiguação de contexto ("este
 * sinal é sobre a Base"), prática padrão de domain EIP-712.
 */
export function buildSignalTypedData(signal: YieldSignal, raw: string, chainId: number): SignalTypedData {
  const best = signal.rates.find((r) => r.protocol === signal.bestProtocol);
  if (!best) {
    throw new Error(`sinal inconsistente: bestProtocol "${signal.bestProtocol}" não aparece em rates`);
  }
  const asOfSeconds = BigInt(Math.floor(new Date(signal.asOf).getTime() / 1000));
  return {
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId },
    types: { YieldSignal: SIGNED_SIGNAL_TYPES },
    primaryType: "YieldSignal",
    message: {
      asset: signal.asset,
      bestProtocol: signal.bestProtocol,
      weightedApyBps: BigInt(best.weightedApyBps),
      gapBps: BigInt(signal.gapBps),
      asOf: asOfSeconds,
      contentHash: keccak256(toBytes(raw)),
    },
  };
}

/**
 * `eip712.message` carrega bigint (obrigatório pra bater com os tipos
 * uint256/uint64 na hora de assinar/verificar) — `JSON.stringify` direto
 * lançaria ("Do not know how to serialize a BigInt"). Achata pra string
 * decimal só na hora de transportar (header HTTP / bloco MCP); quem verifica
 * (viem.verifyTypedData) precisa converter de volta pra BigInt antes de usar
 * — ver client/src/index.ts#verifySignal pro exemplo de referência.
 */
export function eip712ForTransport(eip712: SignalTypedData): Record<string, unknown> {
  return {
    domain: eip712.domain,
    types: eip712.types,
    primaryType: eip712.primaryType,
    message: {
      ...eip712.message,
      weightedApyBps: eip712.message.weightedApyBps.toString(),
      gapBps: eip712.message.gapBps.toString(),
      asOf: eip712.message.asOf.toString(),
    },
  };
}

/**
 * Assina (EIP-712 typed data) os bytes exatos servidos ao comprador —
 * verificável por qualquer cliente via `viem.verifyTypedData({ address:
 * signer, domain, types, primaryType, message, signature })`, sem precisar
 * confiar no uptime do servidor no momento da checagem. Nunca lança: o
 * comprador já pagou pelo `raw` antes desta função rodar (ver
 * expressApp.ts/mcp.ts), então uma falha OU demora aqui não pode virar erro/
 * timeout 5xx — só degrada pra resposta sem assinatura, registrada como aviso.
 */
export async function signPayload(signer: SignerAccount, raw: string, signal: YieldSignal): Promise<SignedPayload | undefined> {
  try {
    const env = loadEnv();
    const { chain } = withdrawNetworkFor(env.X402_ENVIRONMENT);
    const eip712 = buildSignalTypedData(signal, raw, chain.id);
    const signature = await Promise.race([
      signer.signTypedData(eip712),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`timeout assinando resposta (${SIGN_TIMEOUT_MS}ms)`)), SIGN_TIMEOUT_MS),
      ),
    ]);
    return { signature, signer: signer.address, eip712 };
  } catch (err) {
    logger.warn({ err }, "falha assinando resposta — servindo sem assinatura");
    return undefined;
  }
}
