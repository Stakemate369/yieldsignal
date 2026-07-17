import { BASE_MAINNET } from "../config/networks.js";
import { basePublicClient } from "./client.js";
import { compoundedRateToApyBps } from "./apyMath.js";
import { cachedWithTtl } from "./cache.js";
import type { RateReading } from "./types.js";

const CACHE_TTL_MS = 30_000;

const FACTOR_SCALE = 10n ** 18n;

// Fragmento mínimo da CometMainInterface — confirmado contra o fonte oficial
// (github.com/compound-finance/comet/blob/main/contracts/CometMainInterface.sol).
const COMET_ABI = [
  {
    type: "function",
    name: "getUtilization",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getSupplyRate",
    stateMutability: "view",
    inputs: [{ name: "utilization", type: "uint256" }],
    outputs: [{ name: "", type: "uint64" }],
  },
] as const;

async function readCompoundSupplyApyUncached(): Promise<RateReading> {
  const utilization = await basePublicClient.readContract({
    address: BASE_MAINNET.compound.comet,
    abi: COMET_ABI,
    functionName: "getUtilization",
  });

  const supplyRate = await basePublicClient.readContract({
    address: BASE_MAINNET.compound.comet,
    abi: COMET_ABI,
    functionName: "getSupplyRate",
    args: [utilization],
  });

  // getSupplyRate retorna a taxa por segundo escalada em 1e18.
  const perSecondFraction = Number(supplyRate) / Number(FACTOR_SCALE);

  return {
    protocol: "compound",
    supplyApyBps: compoundedRateToApyBps(perSecondFraction, true),
    source: "onchain",
    readAt: new Date(),
  };
}

// TTL curto (30s) — mesmo motivo do cache em aave.ts.
export const readCompoundSupplyApy = cachedWithTtl(readCompoundSupplyApyUncached, CACHE_TTL_MS);
