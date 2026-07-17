import { wrapFetchWithPayment } from "@x402/fetch";
import type { x402Client, x402HTTPClient } from "@x402/fetch";

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

const DEFAULT_BASE_URL = "https://yieldsignal.vercel.app";

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

  return {
    async getSignal(asset: YieldSignalAsset = "USDC"): Promise<YieldSignal> {
      const res = await fetchWithPayment(`${baseUrl}/signal/${asset.toLowerCase()}-base-yield`);
      if (!res.ok) {
        throw new Error(`YieldSignal respondeu ${res.status}: ${await res.text()}`);
      }
      return (await res.json()) as YieldSignal;
    },
  };
}
