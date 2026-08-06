import { BASE_MAINNET, BASE_ASSETS } from "../config/networks.js";
import { basePublicClient } from "./client.js";
import { cachedWithTtl } from "./cache.js";
import { readBorrowRateCurve } from "./rateCurve.js";
import { logger } from "../notify/logger.js";
import type { ProtocolFactor, ProtocolExposure } from "../signal/exposure.js";
import type { LendingAssetId, ProtocolId } from "./types.js";

/**
 * De onde sai cada fator de exposição, por protocolo. Ver `signal/exposure.ts`
 * pra o porquê do produto; aqui é só a leitura.
 *
 * TTL de 5 min, mesmo raciocínio da curva de juros: composição de colateral e
 * curador mudam devagar (mutuários entrando/saindo, curador realocando), e o
 * custo de reler a cada chamada é alto — a leitura da Compound sozinha são
 * ~1 + 5×4 chamadas, ainda que o multicall agrupe.
 */
const CACHE_TTL_MS = 300_000;
const MORPHO_API = "https://api.morpho.org/graphql";
const REQUEST_TIMEOUT_MS = 8_000;

// ------------------------------------------------------------------- Morpho

const VAULT_QUERY = `query($address: String!, $chainId: Int!) {
  vaultByAddress(address: $address, chainId: $chainId) {
    state {
      curator
      allocation {
        supplyAssetsUsd
        market { oracleAddress collateralAsset { symbol } }
      }
    }
  }
}`;

interface VaultResponse {
  data?: {
    vaultByAddress?: {
      state?: {
        curator?: string | null;
        allocation?: {
          supplyAssetsUsd?: number | null;
          market?: { oracleAddress?: string | null; collateralAsset?: { symbol?: string | null } | null } | null;
        }[] | null;
      } | null;
    } | null;
  };
}

/**
 * Morpho é o caso EXATO: cada mercado Blue é isolado e tem um colateral só,
 * então a fatia de capital atrás de cada colateral é aritmética sobre a
 * alocação do vault, não rateio.
 *
 * O curador entra como fator próprio com peso 1: ele controla PARA ONDE todo o
 * capital do vault vai, então a posição inteira depende dele. Foi exatamente
 * esse fator que transformou US$ 93M em US$ 285M no caso Stream — curadores
 * diferentes perseguindo o mesmo rendimento alocaram em mercados que aceitavam
 * o mesmo colateral quebrado.
 *
 * Alocação sem colateral (o buffer ocioso do vault) é ignorada de propósito: é
 * capital parado, sem exposição a colateral nenhum. Incluí-lo como um "fator
 * idle" inflaria artificialmente a diversificação aparente.
 */
async function readMorphoFactorsUncached(asset: LendingAssetId): Promise<ProtocolExposure> {
  const vault = BASE_ASSETS[asset].morphoVault;
  const res = await fetch(MORPHO_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: VAULT_QUERY, variables: { address: vault, chainId: BASE_MAINNET.chainId } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`API do Morpho respondeu ${res.status} pro vault ${vault}`);

  const json = (await res.json()) as VaultResponse;
  const state = json.data?.vaultByAddress?.state;
  const allocation = (state?.allocation ?? []).filter(
    (a) => (a.supplyAssetsUsd ?? 0) > 0 && a.market?.collateralAsset?.symbol,
  );
  const total = allocation.reduce((s, a) => s + (a.supplyAssetsUsd ?? 0), 0);
  if (total <= 0) {
    return { protocol: "morpho", factors: null, parameters: [], unattributedReason: "vault allocation not available" };
  }

  // Um colateral pode aparecer em mais de um mercado (LLTVs diferentes); as
  // fatias somam, senão o mesmo risco entraria fatiado e pareceria menor.
  const byCollateral = new Map<string, number>();
  const byOracle = new Map<string, number>();
  for (const a of allocation) {
    const share = (a.supplyAssetsUsd ?? 0) / total;
    const symbol = a.market!.collateralAsset!.symbol!;
    byCollateral.set(symbol, (byCollateral.get(symbol) ?? 0) + share);
    const oracle = a.market?.oracleAddress;
    if (oracle) byOracle.set(oracle.toLowerCase(), (byOracle.get(oracle.toLowerCase()) ?? 0) + share);
  }

  const factors: ProtocolFactor[] = [
    ...[...byCollateral].map(([key, share]) => ({
      kind: "collateral" as const,
      key,
      share,
      basis: "isolated-market" as const,
    })),
    ...[...byOracle].map(([key, share]) => ({
      kind: "oracle" as const,
      key,
      share,
      basis: "isolated-market" as const,
    })),
  ];
  if (state?.curator) {
    factors.push({ kind: "curator", key: state.curator.toLowerCase(), share: 1, basis: "isolated-market" });
  }
  return { protocol: "morpho", factors, parameters: [], unattributedReason: null };
}

// ----------------------------------------------------------------- Compound

const COMET_ABI = [
  { type: "function", name: "numAssets", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  {
    type: "function",
    name: "getAssetInfo",
    stateMutability: "view",
    inputs: [{ name: "i", type: "uint8" }],
    outputs: [
      { name: "offset", type: "uint8" },
      { name: "asset", type: "address" },
      { name: "priceFeed", type: "address" },
      { name: "scale", type: "uint64" },
      { name: "borrowCollateralFactor", type: "uint64" },
      { name: "liquidateCollateralFactor", type: "uint64" },
      { name: "liquidationFactor", type: "uint64" },
      { name: "supplyCap", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "totalsCollateral",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "totalSupplyAsset", type: "uint128" },
      { name: "_reserved", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "getPrice",
    stateMutability: "view",
    inputs: [{ name: "priceFeed", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const;

/** `getPrice` do Comet devolve 8 casas — padrão do feed que ele consome. */
const COMET_PRICE_SCALE = 1e8;

/**
 * Compound v3 é um ativo base contra uma CESTA definida de colaterais, e os
 * pesos reais do que está postado saem de `totalsCollateral(asset)` × preço do
 * feed que o próprio Comet usa. Medido em 2026-08-06 no mercado de USDC da
 * Base: cbBTC 43,1%, WETH 37,4%, tBTC 7,8%, cbETH 6,9%, wstETH 4,8%.
 *
 * Diferente do Morpho, aqui a atribuição é da CESTA, não do seu dinheiro
 * especificamente: não dá pra saber qual mutuário postou o quê sem indexar
 * posição por posição. O `basis` diz isso, e a fatia é a composição do mercado
 * — que é a exposição real de quem fornece o ativo base.
 */
async function readCompoundFactorsUncached(asset: LendingAssetId): Promise<ProtocolExposure> {
  const comet = BASE_ASSETS[asset].compoundComet;
  const count = await basePublicClient.readContract({ address: comet, abi: COMET_ABI, functionName: "numAssets" });
  if (count === 0) return { protocol: "compound", factors: null, parameters: [], unattributedReason: "comet reports no collateral assets" };

  const infos = await Promise.all(
    Array.from({ length: Number(count) }, (_, i) =>
      basePublicClient.readContract({ address: comet, abi: COMET_ABI, functionName: "getAssetInfo", args: [i] }),
    ),
  );

  const rows = await Promise.all(
    infos.map(async (info) => {
      const [, token, priceFeed] = info;
      const [symbol, decimals, totals, price] = await Promise.all([
        basePublicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => null),
        basePublicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => null),
        basePublicClient.readContract({ address: comet, abi: COMET_ABI, functionName: "totalsCollateral", args: [token] }).catch(() => null),
        basePublicClient.readContract({ address: comet, abi: COMET_ABI, functionName: "getPrice", args: [priceFeed] }).catch(() => null),
      ]);
      // `failed` distingue LEITURA QUE FALHOU de saldo genuinamente zero. Sem
      // essa distinção uma falha de RPC virava "cesta vazia" e o protocolo
      // sumia do relatório com um motivo plausível e errado — bug real, achado
      // testando contra o RPC público sob limite de taxa.
      if (symbol === null || decimals === null || totals === null || price === null) {
        return { failed: true as const };
      }
      const qty = Number(totals[0]) / 10 ** Number(decimals);
      const usd = qty * (Number(price) / COMET_PRICE_SCALE);
      if (!Number.isFinite(usd)) return { failed: true as const };
      return { failed: false as const, symbol, usd, priceFeed: priceFeed.toLowerCase() };
    }),
  );

  // Basta UMA perna faltando pra recusar a atribuição inteira: com a cesta
  // incompleta, os colaterais que sobraram apareceriam com fatia maior do que
  // têm de verdade — falsa precisão, exatamente o que este serviço não vende.
  const failures = rows.filter((r) => r.failed).length;
  if (failures > 0) {
    return {
      protocol: "compound",
      factors: null,
      parameters: [],
      unattributedReason: `collateral basket incomplete: ${failures} of ${rows.length} assets could not be read this request — refusing to attribute shares from a partial basket`,
    };
  }

  const good = rows.filter((r): r is Extract<typeof r, { failed: false }> => !r.failed && r.usd > 0);
  const total = good.reduce((s, r) => s + r.usd, 0);
  // Cesta vazia é um estado real (mercado sem colateral postado), mas não
  // sustenta atribuição nenhuma — e ratear sobre zero inventaria.
  if (total <= 0 || good.length === 0) {
    return { protocol: "compound", factors: null, parameters: [], unattributedReason: "no collateral posted in this market" };
  }

  const factors: ProtocolFactor[] = good.flatMap((r) => [
    { kind: "collateral" as const, key: r.symbol, share: r.usd / total, basis: "collateral-basket" as const },
    { kind: "oracle" as const, key: r.priceFeed, share: r.usd / total, basis: "collateral-basket" as const },
  ]);
  return { protocol: "compound", factors, parameters: [], unattributedReason: null };
}

// --------------------------------------------------------------------- Aave

/**
 * Aave v3 é um POOL COMPARTILHADO: quem deposita USDC está exposto a todo o
 * colateral do pool, não a um ativo específico. Atribuir a exposição a um
 * colateral seria falso, e ratear entre todos seria pior — sugeriria
 * diversificação onde na verdade há um único bloco de risco.
 *
 * Então a resposta honesta é "não atribuído, e este é o motivo". Não é
 * limitação de implementação: é a topologia do protocolo.
 */
function aaveExposure(): ProtocolExposure {
  return {
    protocol: "aave",
    factors: null,
    parameters: [],
    unattributedReason:
      "pooled-collateral: an Aave v3 supplier is exposed to the entire pool's collateral set, not to an identifiable asset — attributing it to one collateral would be false, and splitting it across all of them would imply diversification that does not exist",
  };
}

// ----------------------------------------------------------------- coletor

const morphoReaders: Record<LendingAssetId, () => Promise<ProtocolExposure>> = {
  USDC: cachedWithTtl(() => readMorphoFactorsUncached("USDC"), CACHE_TTL_MS),
  WETH: cachedWithTtl(() => readMorphoFactorsUncached("WETH"), CACHE_TTL_MS),
};

const compoundReaders: Record<LendingAssetId, () => Promise<ProtocolExposure>> = {
  USDC: cachedWithTtl(() => readCompoundFactorsUncached("USDC"), CACHE_TTL_MS),
  WETH: cachedWithTtl(() => readCompoundFactorsUncached("WETH"), CACHE_TTL_MS),
};

function failed(protocol: ProtocolId, err: unknown): ProtocolExposure {
  logger.warn({ protocol, err }, "falha lendo fatores de exposição — protocolo entra como não atribuído");
  return { protocol, factors: null, parameters: [], unattributedReason: "factor read failed for this request" };
}

/**
 * Lê os fatores dos protocolos pedidos, em paralelo. O joelho da curva entra
 * como fator de PARÂMETRO (peso 1) onde há curva legível: é o que revela que
 * duas posições em protocolos diferentes reprecificam no mesmo limiar — Aave e
 * Compound usam 90% os dois, então uma carteira dividida entre os dois não está
 * diversificada contra um choque de utilização.
 */
export async function collectExposureFactors(
  asset: LendingAssetId,
  protocols: readonly ProtocolId[],
): Promise<Map<ProtocolId, ProtocolExposure>> {
  const unique = [...new Set(protocols)];
  const entries = await Promise.all(
    unique.map(async (protocol): Promise<readonly [ProtocolId, ProtocolExposure]> => {
      try {
        let exposure: ProtocolExposure;
        if (protocol === "morpho") exposure = await morphoReaders[asset]();
        else if (protocol === "compound") exposure = await compoundReaders[asset]();
        else if (protocol === "aave") exposure = aaveExposure();
        else {
          return [
            protocol,
            {
              protocol,
              factors: null,
              parameters: [],
              unattributedReason:
                "read via DefiLlama: this service has no position-level view of this market, so its collateral composition cannot be established",
            },
          ] as const;
        }

        // O joelho vai em `parameters`, NUNCA em `factors` — inclusive (e
        // principalmente) na Aave, que não tem composição legível mas tem
        // joelho. Ver a nota em `ProtocolExposure.parameters`: misturar os dois
        // faria a posição em Aave contar como atribuída e diluiria os
        // percentuais de colateral, escondendo que a composição é desconhecida.
        if (protocol === "aave" || protocol === "compound") {
          const curve = await readBorrowRateCurve(protocol, asset);
          if (curve) {
            exposure = {
              ...exposure,
              parameters: [
                ...exposure.parameters,
                { kind: "rate-kink", key: String(curve.kinkBps), share: 1, basis: "protocol-parameter" },
              ],
            };
          }
        }
        return [protocol, exposure] as const;
      } catch (err) {
        return [protocol, failed(protocol, err)] as const;
      }
    }),
  );
  return new Map(entries);
}
