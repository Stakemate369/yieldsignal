import { wrapFetchWithPayment } from "@x402/fetch";
import type { x402Client, x402HTTPClient } from "@x402/fetch";
import { keccak256, toBytes, verifyTypedData } from "viem";

export type YieldSignalAsset = "USDC" | "WETH";

export interface SignalRate {
  protocol: "aave" | "morpho" | "compound" | "moonwell" | "euler" | "fluid";
  apyBps: number;
  weightedApyBps: number;
  source: "onchain" | "api" | "defillama";
  asOf: string;
}

export interface YieldSignal {
  asset: YieldSignalAsset;
  bestProtocol: SignalRate["protocol"];
  gapBps: number;
  rates: SignalRate[];
  asOf: string;
}

export interface YieldSignalClientOptions {
  /** Defaults to the live service. Override for local development against `npm run dev`. */
  baseUrl?: string;
}

export interface VerifiedYieldSignal {
  signal: YieldSignal;
  /** True only if a signature was present AND both the EIP-712 signature and its embedded contentHash checked out against the exact response body. */
  verified: boolean;
  signature: `0x${string}` | null;
  signer: `0x${string}` | null;
}

const DEFAULT_BASE_URL = "https://yieldsignal.vercel.app";

/**
 * Verifica um par (corpo bruto, headers de assinatura) contra a resposta
 * servida — duas checagens independentes, ambas precisam passar:
 * 1. `contentHash` embutido no struct EIP-712 bate com `keccak256(raw)` (prova
 *    que o struct assinado realmente se refere A ESTE corpo, não a outro).
 * 2. A assinatura EIP-712 é válida pro endereço anunciado (`viem.verifyTypedData`).
 * Feito contra o texto BRUTO (nunca `JSON.stringify(JSON.parse(raw))`) —
 * reserializar arriscaria produzir bytes diferentes dos que foram assinados.
 */
export async function verifySignalPayload(params: {
  raw: string;
  signature: `0x${string}`;
  signer: `0x${string}`;
  eip712Json: string;
}): Promise<boolean> {
  const { raw, signature, signer, eip712Json } = params;
  const { domain, types, primaryType, message } = JSON.parse(eip712Json) as {
    domain: { name: string; version: string; chainId: number };
    types: { YieldSignal: { name: string; type: string }[] };
    primaryType: "YieldSignal";
    message: { asset: string; bestProtocol: string; weightedApyBps: string; gapBps: string; asOf: string; contentHash: `0x${string}` };
  };

  if (message.contentHash !== keccak256(toBytes(raw))) return false;

  return verifyTypedData({
    address: signer,
    domain,
    types,
    primaryType,
    message: {
      ...message,
      weightedApyBps: BigInt(message.weightedApyBps),
      gapBps: BigInt(message.gapBps),
      asOf: BigInt(message.asOf),
    },
    signature,
  });
}

/**
 * Thin wrapper around `@x402/fetch` for YieldSignal's REST endpoints. Takes
 * an already-configured x402 client/signer (e.g. `CdpX402Client` from
 * `@coinbase/cdp-sdk/x402`, or any other `x402Client`/`x402HTTPClient`
 * implementation with a funded Base wallet) — this package doesn't provision
 * wallets or pick a signer for you, it only wraps the paid HTTP call.
 */
export function createYieldSignalClient(client: x402Client | x402HTTPClient, opts: YieldSignalClientOptions = {}) {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  async function fetchRaw(asset: YieldSignalAsset): Promise<{ raw: string; res: Response }> {
    const res = await fetchWithPayment(`${baseUrl}/signal/${asset.toLowerCase()}-base-yield`);
    if (!res.ok) {
      throw new Error(`YieldSignal respondeu ${res.status}: ${await res.text()}`);
    }
    // `res.text()` primeiro (não `res.json()`) — precisa do texto BRUTO,
    // byte a byte, pra verificação de assinatura funcionar (ver
    // verifySignalPayload); reparsed depois pro objeto tipado.
    const raw = await res.text();
    return { raw, res };
  }

  return {
    async getSignal(asset: YieldSignalAsset = "USDC"): Promise<YieldSignal> {
      const { raw } = await fetchRaw(asset);
      return JSON.parse(raw) as YieldSignal;
    },

    /** Mesma chamada paga que `getSignal`, mas também verifica a assinatura EIP-712 (X-Signal-* headers) antes de devolver. */
    async getSignalVerified(asset: YieldSignalAsset = "USDC"): Promise<VerifiedYieldSignal> {
      const { raw, res } = await fetchRaw(asset);
      const signal = JSON.parse(raw) as YieldSignal;
      const signature = res.headers.get("x-signal-signature") as `0x${string}` | null;
      const signer = res.headers.get("x-signal-signer") as `0x${string}` | null;
      const eip712Json = res.headers.get("x-signal-eip712-payload");
      const verified =
        signature !== null && signer !== null && eip712Json !== null
          ? await verifySignalPayload({ raw, signature, signer, eip712Json })
          : false;
      return { signal, verified, signature, signer };
    },
  };
}
