import { BASE_ASSETS } from "../config/networks.js";
import { basePublicClient } from "./client.js";
import { compoundedRateToApyBps } from "./apyMath.js";
import { cachedWithTtl } from "./cache.js";
import type { AssetId, RateReading } from "./types.js";

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

async function readCompoundSupplyApyUncached(asset: AssetId): Promise<RateReading> {
  // Diferente da Aave (um pool só, asset como parâmetro), cada asset no
  // Compound V3 é um Comet PROXY separado — endereço vem de BASE_ASSETS.
  const comet = BASE_ASSETS[asset].compoundComet;

  const utilization = await basePublicClient.readContract({
    address: comet,
    abi: COMET_ABI,
    functionName: "getUtilization",
  });

  const supplyRate = await basePublicClient.readContract({
    address: comet,
    abi: COMET_ABI,
    functionName: "getSupplyRate",
    args: [utilization],
  });

  // getSupplyRate retorna a taxa por segundo escalada em 1e18.
  const perSecondFraction = Number(supplyRate) / Number(FACTOR_SCALE);

  return {
    protocol: "compound",
    asset,
    supplyApyBps: compoundedRateToApyBps(perSecondFraction, true),
    source: "onchain",
    readAt: new Date(),
  };
}

// TTL curto (30s) — mesmo motivo do cache em aave.ts. Um cache por asset,
// mesmo raciocínio de isolamento já aplicado lá.
const cachedReaders: Record<AssetId, () => Promise<RateReading>> = {
  USDC: cachedWithTtl(() => readCompoundSupplyApyUncached("USDC"), CACHE_TTL_MS),
  WETH: cachedWithTtl(() => readCompoundSupplyApyUncached("WETH"), CACHE_TTL_MS),
};

export function readCompoundSupplyApy(asset: AssetId): Promise<RateReading> {
  return cachedReaders[asset]();
}
