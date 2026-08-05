import { BASE_ASSETS } from "../config/networks.js";
import { basePublicClient } from "./client.js";
import { compoundedRateToApyBps } from "./apyMath.js";
import { cachedWithTtl } from "./cache.js";
import { readIncentiveComponent } from "./incentives.js";
import { marketLiquidity, onchainDepthUsd } from "./depth.js";
import type { LendingAssetId, RateReading } from "./types.js";

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
  // Profundidade do mercado direto dos livros do Comet — o saldo total do ativo
  // base fornecido. Existe porque o TVL do agregador estava errado por uma
  // ordem de grandeza justamente aqui (ver market-data/depth.ts).
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

async function readCompoundSupplyApyUncached(asset: LendingAssetId): Promise<RateReading> {
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

  // getSupplyRate retorna a taxa por segundo escalada em 1e18. É SÓ o juro
  // base — o COMP distribuído por baseTrackingSupplySpeed não entra aqui.
  const perSecondFraction = Number(supplyRate) / Number(FACTOR_SCALE);
  const apyBaseBps = compoundedRateToApyBps(perSecondFraction, true);
  const incentive = await readIncentiveComponent("compound", asset, apyBaseBps);

  // Profundidade dos próprios livros. Best-effort de propósito: a taxa é o
  // produto, a profundidade é contexto — uma falha aqui não pode derrubar a
  // resposta paga, só deixa o campo cair no agregador (ou em null).
  const totalSupplyRaw = await basePublicClient
    .readContract({ address: comet, abi: COMET_ABI, functionName: "totalSupply" })
    .catch(() => null);

  const onchainTvlUsd = totalSupplyRaw !== null ? onchainDepthUsd(asset, totalSupplyRaw) : null;
  // O Comet não expõe `totalBorrow` no fragmento que já usamos, mas
  // `getUtilization()` (lido acima pra taxa) É emprestado ÷ fornecido escalado
  // em 1e18 — então o emprestado sai dos dois números que já temos em mãos, sem
  // ABI nova nem chamada extra. Derivado, não estimado.
  const liquidity =
    totalSupplyRaw !== null
      ? marketLiquidity(asset, totalSupplyRaw, (totalSupplyRaw * utilization) / FACTOR_SCALE)
      : undefined;

  return {
    protocol: "compound",
    asset,
    supplyApyBps: apyBaseBps + (incentive.rewardBps ?? 0),
    apyBaseBps,
    apyRewardBps: incentive.rewardBps,
    rewardBasis: incentive.basis,
    // Livros do protocolo primeiro; agregador só onde não dá pra afirmar em USD.
    tvlUsd: onchainTvlUsd ?? incentive.tvlUsd,
    tvlBasis: onchainTvlUsd !== null ? "total-supplied" : incentive.tvlUsd !== null ? "aggregator-reported" : null,
    source: "onchain",
    ...(liquidity ? { liquidity } : {}),
    readAt: new Date(),
  };
}

// TTL curto (30s) — mesmo motivo do cache em aave.ts. Um cache por asset,
// mesmo raciocínio de isolamento já aplicado lá.
const cachedReaders: Record<LendingAssetId, () => Promise<RateReading>> = {
  USDC: cachedWithTtl(() => readCompoundSupplyApyUncached("USDC"), CACHE_TTL_MS),
  WETH: cachedWithTtl(() => readCompoundSupplyApyUncached("WETH"), CACHE_TTL_MS),
};

export function readCompoundSupplyApy(asset: LendingAssetId): Promise<RateReading> {
  return cachedReaders[asset]();
}
