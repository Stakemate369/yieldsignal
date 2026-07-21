import { BASE_MAINNET, BASE_ASSETS } from "../config/networks.js";
import { cachedWithTtl } from "./cache.js";
import type { LendingAssetId, RateReading } from "./types.js";

const MORPHO_API = "https://api.morpho.org/graphql";
const CACHE_TTL_MS = 30_000;

const QUERY = `
  query VaultApy($address: String!, $chainId: Int!) {
    vaultByAddress(address: $address, chainId: $chainId) {
      state {
        netApy
      }
    }
  }
`;

interface MorphoApiResponse {
  data?: {
    vaultByAddress?: {
      state?: {
        // fração decimal (0.05 = 5%), já líquida de taxa de performance —
        // tipado como `| null` porque a API GraphQL pode legitimamente
        // devolver `null` (não ausente) num vault sem dado ainda.
        netApy: number | null;
      };
    };
  };
  errors?: Array<{ message: string }>;
}

/**
 * Fonte primária pra APY do Morpho é a API oficial deles, não leitura on-chain
 * raw — o APY de um vault MetaMorpho é uma média ponderada entre múltiplos
 * mercados isolados alocados, já líquida de taxa de performance e incluindo
 * rewards, e reimplementar esse cálculo por conta própria é onde bug silencioso
 * mais provavelmente entraria.
 */
async function readMorphoVaultApyUncached(asset: LendingAssetId): Promise<RateReading> {
  const vaultAddress = BASE_ASSETS[asset].morphoVault;
  const res = await fetch(MORPHO_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: { address: vaultAddress, chainId: BASE_MAINNET.chainId },
    }),
  });

  if (!res.ok) {
    throw new Error(`Morpho API respondeu ${res.status} — não é seguro responder sem taxa confiável`);
  }

  const json = (await res.json()) as MorphoApiResponse;
  if (json.errors?.length) {
    throw new Error(`Morpho API erro: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  const netApy = json.data?.vaultByAddress?.state?.netApy;
  // `!= null` cobre `undefined` (campo ausente) E `null` (a API devolve isso
  // pra vault sem dado — visto na prática, não é só um caso teórico de tipo).
  if (netApy === undefined || netApy === null || !Number.isFinite(netApy)) {
    throw new Error(
      `Morpho API não retornou netApy válido pro vault ${vaultAddress} na chain ${BASE_MAINNET.chainId} (valor: ${netApy})`,
    );
  }

  return {
    protocol: "morpho",
    asset,
    supplyApyBps: Math.round(netApy * 10_000),
    source: "api",
    readAt: new Date(),
  };
}

// TTL curto (30s) — mesmo motivo do cache em aave.ts/compound.ts. Um cache
// por asset, mesmo raciocínio de isolamento já aplicado lá.
const cachedReaders: Record<LendingAssetId, () => Promise<RateReading>> = {
  USDC: cachedWithTtl(() => readMorphoVaultApyUncached("USDC"), CACHE_TTL_MS),
  WETH: cachedWithTtl(() => readMorphoVaultApyUncached("WETH"), CACHE_TTL_MS),
};

export function readMorphoVaultApy(asset: LendingAssetId): Promise<RateReading> {
  return cachedReaders[asset]();
}
