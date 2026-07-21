import { BASE_MAINNET, BASE_ASSETS } from "../config/networks.js";
import { basePublicClient } from "./client.js";
import { compoundedRateToApyBps } from "./apyMath.js";
import { cachedWithTtl } from "./cache.js";
import type { LendingAssetId, RateReading } from "./types.js";

const CACHE_TTL_MS = 30_000;

const RAY = 10n ** 27n;

// Fragmento mínimo do IPoolDataProvider — só o que precisamos.
const POOL_DATA_PROVIDER_ABI = [
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "unbacked", type: "uint256" },
      { name: "accruedToTreasuryScaled", type: "uint256" },
      { name: "totalAToken", type: "uint256" },
      { name: "totalStableDebt", type: "uint256" },
      { name: "totalVariableDebt", type: "uint256" },
      { name: "liquidityRate", type: "uint256" },
      { name: "variableBorrowRate", type: "uint256" },
      { name: "stableBorrowRate", type: "uint256" },
      { name: "averageStableBorrowRate", type: "uint256" },
      { name: "liquidityIndex", type: "uint256" },
      { name: "variableBorrowIndex", type: "uint256" },
      { name: "lastUpdateTimestamp", type: "uint40" },
    ],
  },
] as const;

async function readAaveSupplyApyUncached(asset: LendingAssetId): Promise<RateReading> {
  const data = await basePublicClient.readContract({
    address: BASE_MAINNET.aave.poolDataProvider,
    abi: POOL_DATA_PROVIDER_ABI,
    functionName: "getReserveData",
    args: [BASE_ASSETS[asset].token],
  });

  const liquidityRate = data[5]; // liquidityRate é o 6º valor do tuple
  // liquidityRate vem em ray (1e27), como APR linear anualizado.
  const aprFraction = Number(liquidityRate) / Number(RAY);

  return {
    protocol: "aave",
    asset,
    supplyApyBps: compoundedRateToApyBps(aprFraction, false),
    source: "onchain",
    readAt: new Date(),
  };
}

// TTL curto (30s) — protege contra rajada de chamadas pagas simultâneas
// batendo no RPC público a cada uma; `readAt` no resultado continua
// refletindo a hora real da leitura, não quando foi servido do cache.
// Um cache por asset (não um cache só) — senão uma leitura de WETH serviria
// do cache de USDC (ou vice-versa) até o TTL expirar.
const cachedReaders: Record<LendingAssetId, () => Promise<RateReading>> = {
  USDC: cachedWithTtl(() => readAaveSupplyApyUncached("USDC"), CACHE_TTL_MS),
  WETH: cachedWithTtl(() => readAaveSupplyApyUncached("WETH"), CACHE_TTL_MS),
};

export function readAaveSupplyApy(asset: LendingAssetId): Promise<RateReading> {
  return cachedReaders[asset]();
}
