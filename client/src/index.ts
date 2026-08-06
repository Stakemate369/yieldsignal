import { wrapFetchWithPayment } from "@x402/fetch";
import type { x402Client, x402HTTPClient } from "@x402/fetch";
import { keccak256, toBytes, verifyTypedData } from "viem";

// Lista canônica — integrations/agentkit e integrations/goat importam daqui
// pro schema Zod deles em vez de manter a própria cópia do literal (mesmo
// achado/fix já aplicado do lado do servidor em market-data/types.ts#ASSET_IDS).
export const YIELD_SIGNAL_ASSETS = ["USDC", "WETH", "ETH_STAKING"] as const;
export type YieldSignalAsset = (typeof YIELD_SIGNAL_ASSETS)[number];

// Espelha RESOURCE_PATHS do servidor (src/expressApp.ts) — precisa ser um
// mapa explícito, não uma transformação do nome do asset: ETH_STAKING não
// segue o padrão `${asset.toLowerCase()}-base-yield` que USDC/WETH usam por
// coincidência (a rota real é /signal/eth-staking-yield, categoria diferente
// de "lending na Base").
const RESOURCE_PATHS: Record<YieldSignalAsset, string> = {
  USDC: "usdc-base-yield",
  WETH: "weth-base-yield",
  ETH_STAKING: "eth-staking-yield",
};

export interface SignalRate {
  protocol: "aave" | "morpho" | "compound" | "moonwell" | "euler" | "fluid" | "lido" | "rocket-pool" | "coinbase-wrapped-staked-eth" | "frax-ether" | "binance-staked-eth";
  /** Total supply APY (base interest + incentives) — the number used for the ranking. */
  apyBps: number;
  /** Base-interest component, when the source separates it. `null` = not itemised. */
  apyBaseBps?: number | null;
  /** Incentive component. `0` = knowingly no campaign; `null` = unknown on this reading. */
  apyRewardBps?: number | null;
  /** How the incentive component was obtained. */
  rewardBasis?: "reported" | "inferred" | "included-not-itemized" | "unavailable";
  weightedApyBps: number;
  source: "onchain" | "api" | "defillama";
  asOf: string;
}

export interface YieldSignal {
  asset: YieldSignalAsset;
  bestProtocol: SignalRate["protocol"];
  gapBps: number;
  rates: SignalRate[];
  /**
   * Protocols the service tries to read for this asset but that are absent from
   * this response (source failed, or the pool reads mute). Non-empty means
   * `bestProtocol` is the best of what answered — treat it as a weaker claim.
   */
  omittedProtocols?: SignalRate["protocol"][];
  coverage?: { read: number; expected: number };
  /** Protocols whose incentive component is unknown — their APY is a floor, not a verdict. */
  incompleteRewardData?: SignalRate["protocol"][];
  /** The single basis every APY in `rates` is expressed on. */
  apyBasis?: "supply-apy-total-incl-rewards";
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
 * Os quatro produtos analíticos só existem pra mercado de EMPRÉSTIMO. Staking
 * líquido não tem utilização, não tem curva de juros e a DefiLlama não itemiza
 * incentivo pros cinco protocolos — as rotas nem existem pra ele, então o tipo
 * recusa em tempo de compilação em vez de deixar o agente pagar por um 404.
 */
export const LENDING_ASSETS = ["USDC", "WETH"] as const;
export type LendingAsset = (typeof LENDING_ASSETS)[number];

export interface DecisionInput {
  position?: string;
  amountUsd?: number;
  moveCostUsd?: number;
  horizonDays?: number;
}

/**
 * Os relatórios são declarados pelos campos-manchete, não campo a campo: o
 * corpo real traz mais (cada entrada por protocolo, a curva, os `basis`), e
 * duplicar as interfaces inteiras aqui criaria duas fontes de verdade que
 * saem de sincronia no primeiro campo novo. `signal` vem embutido em todos —
 * é o objeto EIP-712 assinado, o mesmo de `getSignal`.
 */
export interface DecisionReport {
  action: string;
  signal: YieldSignal;
  [field: string]: unknown;
}

export interface DurabilityReport {
  asset: string;
  basis: "incentive-stress-test";
  bestProtocolNow: string | null;
  bestProtocolPostIncentive: string | null;
  /** `null` quando o líder atual não é decomponível — nunca `false` por omissão. */
  rankingChangesWithoutIncentives: boolean | null;
  bestVerifiableFloor: { protocol: string; apyBps: number } | null;
  coverage: { decomposable: number; total: number };
  signal: YieldSignal;
  [field: string]: unknown;
}

export interface CapacityReport {
  asset: string;
  basis: "onchain-protocol-books";
  bestProtocolNow: string | null;
  bestProtocolExecutable: string | null;
  unmeasured: string[];
  coverage: { measured: number; total: number };
  signal: YieldSignal;
  [field: string]: unknown;
}

export interface SensitivityReport {
  asset: string;
  basis: "onchain-interest-rate-curve";
  tightestToKink: { protocol: string; headroomBps: number } | null;
  pastKink: string[];
  unmeasured: string[];
  coverage: { measured: number; total: number };
  signal: YieldSignal;
  [field: string]: unknown;
}

export interface ExposureReport {
  asset: string;
  basis: "declared-positions";
  totalUsd: number;
  nominalVenues: number;
  topFactor: { kind: string; key: string; pctOfAttributed: number; via: string[] } | null;
  /** Percentuais são sobre o capital ATRIBUÍDO; `coverage` diz quanto entrou na conta. */
  coverage: { attributedUsd: number; totalUsd: number };
  unattributed: { protocol: string; usd: number; reason: string }[];
  signal: YieldSignal;
  [field: string]: unknown;
}

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
    const res = await fetchWithPayment(`${baseUrl}/signal/${RESOURCE_PATHS[asset]}`);
    if (!res.ok) {
      throw new Error(`YieldSignal respondeu ${res.status}: ${await res.text()}`);
    }
    // `res.text()` primeiro (não `res.json()`) — precisa do texto BRUTO,
    // byte a byte, pra verificação de assinatura funcionar (ver
    // verifySignalPayload); reparsed depois pro objeto tipado.
    const raw = await res.text();
    return { raw, res };
  }

  /**
   * Chamada paga a qualquer rota do catálogo. Genérica de propósito: os quatro
   * produtos analíticos têm formatos distintos e cada um declara o próprio
   * `basis`, então tipar o retorno aqui duplicaria interfaces grandes que já
   * vivem no servidor e apodreceriam fora de sincronia. O consumidor recebe o
   * corpo íntegro, que é o mesmo texto assinado.
   */
  async function fetchProduct<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const qs = params
      ? Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    const res = await fetchWithPayment(`${baseUrl}${path}${qs ? `?${qs}` : ""}`);
    if (!res.ok) {
      throw new Error(`YieldSignal respondeu ${res.status}: ${await res.text()}`);
    }
    return JSON.parse(await res.text()) as T;
  }

  return {
    async getSignal(asset: YieldSignalAsset = "USDC"): Promise<YieldSignal> {
      const { raw } = await fetchRaw(asset);
      return JSON.parse(raw) as YieldSignal;
    },

    /** MOVE/HOLD dado onde seu capital já está, com ganho líquido e break-even. Preço premium. */
    async getDecision(asset: YieldSignalAsset = "USDC", input: DecisionInput = {}): Promise<DecisionReport> {
      return fetchProduct<DecisionReport>(`/decision/${RESOURCE_PATHS[asset]}`, { ...input });
    },

    /** Quanto da APY sobra se o incentivo parar. Só mercado de empréstimo. */
    async getDurability(asset: LendingAsset = "USDC"): Promise<DurabilityReport> {
      return fetchProduct<DurabilityReport>(`/durability/${RESOURCE_PATHS[asset]}`);
    },

    /** Utilização e liquidez sacável; com `amountUsd`, se a sua saída cabe agora. */
    async getCapacity(asset: LendingAsset = "USDC", amountUsd?: number): Promise<CapacityReport> {
      return fetchProduct<CapacityReport>(`/capacity/${RESOURCE_PATHS[asset]}`, { amountUsd });
    },

    /** A que distância o mercado está do joelho onde a taxa de empréstimo dispara. */
    async getSensitivity(asset: LendingAsset = "USDC"): Promise<SensitivityReport> {
      return fetchProduct<SensitivityReport>(`/sensitivity/${RESOURCE_PATHS[asset]}`);
    },

    /**
     * Quanto da sua carteira está atrás do mesmo risco. `positions` aceita o
     * mapa `{ aave: 200000 }` ou a string `"aave:200000,morpho:150000"` — o
     * mapa evita que o chamador monte o formato à mão e erre a separação.
     */
    async getExposure(
      asset: LendingAsset = "USDC",
      positions: Record<string, number> | string,
    ): Promise<ExposureReport> {
      const encoded =
        typeof positions === "string"
          ? positions
          : Object.entries(positions)
              .map(([protocol, usd]) => `${protocol}:${usd}`)
              .join(",");
      return fetchProduct<ExposureReport>(`/exposure/${RESOURCE_PATHS[asset]}`, { positions: encoded });
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
