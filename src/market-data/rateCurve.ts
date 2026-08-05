import { BASE_MAINNET, BASE_ASSETS } from "../config/networks.js";
import { basePublicClient } from "./client.js";
import { compoundedRateToApyBps } from "./apyMath.js";
import { cachedWithTtl } from "./cache.js";
import { logger } from "../notify/logger.js";
import type { DirectProtocolId, LendingAssetId, ProtocolId } from "./types.js";

/**
 * A CURVA DE JUROS DE EMPRÉSTIMO, lida do próprio protocolo.
 *
 * Existe porque a taxa de um mercado de lending não é um número, é uma função
 * da utilização — e a função tem um JOELHO (kink). Abaixo dele a taxa sobe
 * devagar; acima, dispara. Medido em 2026-08-05 na Compound USDC da Base: 4,08%
 * a 90% de utilização contra 15,95% a 93%. Quem só vê a taxa de agora não faz
 * ideia de quão perto está dessa virada.
 *
 * As duas curvas suportadas são PIECEWISE LINEAR NA TAXA NATIVA e, por isso,
 * reduzem à mesma forma: três âncoras (u=0, u=kink, u=100%) mais o kink. A
 * interpolação tem que acontecer na taxa NATIVA, nunca em APY — a conversão pra
 * APY é composta e não-linear, então interpolar depois de converter erraria.
 *
 * Só Aave e Compound. Morpho não entra, e a checagem ao vivo (2026-08-05) diz
 * por quê, em três motivos independentes:
 *   1. O `AdaptiveCurveIRM` não expõe as constantes da curva — `CURVE_STEEPNESS`,
 *      `TARGET_UTILIZATION`, `ADJUSTMENT_SPEED` e `INITIAL_RATE_AT_TARGET` são
 *      todas `internal constant` no fonte. Usá-las seria chumbar número copiado
 *      de repositório, não ler do contrato.
 *   2. Não existe curva estática pra ler: o que dá pra ler é `rateAtTarget(id)`,
 *      que é ESTADO e escorrega com o tempo conforme a utilização fica acima ou
 *      abaixo do alvo. "Taxa a 95%" não tem resposta fixa lá.
 *   3. `market-data/morpho.ts` lê um VAULT (Gauntlet USDC Prime, US$ 429M), não
 *      um mercado: a taxa é mistura ponderada de 5 mercados Blue com colaterais
 *      diferentes, e o curador realoca quando quiser.
 * Moonwell/Euler/Fluid vêm da DefiLlama, sem acesso nenhum à curva.
 */
export interface BorrowRateCurve {
  protocol: DirectProtocolId;
  /** Utilização do joelho, em bps (9000 = 90%). */
  kinkBps: number;
  /** Taxa NATIVA em u=0. Unidade depende de `perSecond`. */
  rateAtZero: number;
  /** Taxa nativa exatamente no kink. */
  rateAtKink: number;
  /** Taxa nativa em u=100%. */
  rateAtFull: number;
  /** `true` = taxa por segundo (Compound); `false` = APR anual linear (Aave). */
  perSecond: boolean;
  /**
   * Como a curva foi obtida — o comprador precisa poder pesar a força da
   * afirmação, mesma disciplina de `rewardBasis`:
   * - `onchain-rate-function`: os parâmetros foram lidos E a fórmula foi
   *   conferida contra a própria função de taxa do contrato.
   * - `onchain-curve-params`: os parâmetros foram lidos e a forma da curva
   *   conferida contra o teto que o próprio contrato reporta.
   */
  basis: "onchain-rate-function" | "onchain-curve-params";
}

/**
 * TTL bem maior que o dos leitores de TAXA (30s) e isso é deliberado: o que se
 * guarda aqui são os PARÂMETROS da curva (joelho, inclinações, teto), que só
 * mudam por governança — não a utilização, que vem das leituras de taxa e
 * continua fresca a cada chamada. Servir um joelho com 5 minutos de idade não
 * muda nenhuma conclusão; gastar 6 chamadas RPC por request e estourar o limite
 * do RPC público, muda — vira relatório vazio, que foi o que aconteceu na
 * primeira medição ao vivo.
 */
const CACHE_TTL_MS = 300_000;
const RAY = 10n ** 27n;
const WAD = 10n ** 18n;

/**
 * Avalia a curva numa utilização hipotética. PURA — a aritmética é testável sem
 * RPC, e é ela que responde "quanto eu pagaria se a utilização fosse X?".
 *
 * Interpola na taxa nativa e converte pra APY só no fim, pelo motivo dito acima.
 * Utilização fora de 0-100% é grampeada em vez de extrapolar: extrapolar uma
 * curva além do domínio em que ela foi definida é inventar.
 */
export function borrowApyBpsAt(curve: BorrowRateCurve, utilizationBps: number): number {
  const u = Math.max(0, Math.min(10_000, utilizationBps));
  // Kink degenerado (0 ou 100%) deixaria uma das pernas com divisão por zero.
  // Nesse caso a curva vira um segmento só entre as âncoras que sobraram.
  const k = curve.kinkBps;
  let native: number;
  if (k <= 0) {
    native = curve.rateAtKink + (curve.rateAtFull - curve.rateAtKink) * (u / 10_000);
  } else if (k >= 10_000) {
    native = curve.rateAtZero + (curve.rateAtKink - curve.rateAtZero) * (u / 10_000);
  } else if (u <= k) {
    native = curve.rateAtZero + (curve.rateAtKink - curve.rateAtZero) * (u / k);
  } else {
    native = curve.rateAtKink + (curve.rateAtFull - curve.rateAtKink) * ((u - k) / (10_000 - k));
  }
  return compoundedRateToApyBps(native, curve.perSecond);
}

// ---------------------------------------------------------------- Compound

const COMET_CURVE_ABI = [
  { type: "function", name: "borrowKink", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "borrowPerSecondInterestRateBase", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "borrowPerSecondInterestRateSlopeLow", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "borrowPerSecondInterestRateSlopeHigh", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getBorrowRate", stateMutability: "view", inputs: [{ name: "utilization", type: "uint256" }], outputs: [{ name: "", type: "uint64" }] },
] as const;

/**
 * Compound é o caso mais forte: além dos parâmetros, `getBorrowRate(u)` é uma
 * função PURA do contrato, então dá pra conferir a curva reconstruída contra a
 * resposta do próprio protocolo. Feito em 2026-08-05 em 5 utilizações
 * (50/85/90/93/99%) e bateu wei a wei; a checagem ficou no código porque
 * parâmetro pode mudar por governança, e aí a divergência tem que virar
 * "não medido" em vez de número errado servido com confiança.
 */
async function readCompoundCurveUncached(asset: LendingAssetId): Promise<BorrowRateCurve | undefined> {
  const comet = BASE_ASSETS[asset].compoundComet;
  const read = (functionName: "borrowKink" | "borrowPerSecondInterestRateBase" | "borrowPerSecondInterestRateSlopeLow" | "borrowPerSecondInterestRateSlopeHigh") =>
    basePublicClient.readContract({ address: comet, abi: COMET_CURVE_ABI, functionName });

  const [kink, base, slopeLow, slopeHigh] = await Promise.all([
    read("borrowKink"),
    read("borrowPerSecondInterestRateBase"),
    read("borrowPerSecondInterestRateSlopeLow"),
    read("borrowPerSecondInterestRateSlopeHigh"),
  ]);

  if (kink <= 0n) return undefined;

  const curve: BorrowRateCurve = {
    protocol: "compound",
    kinkBps: Number((kink * 10_000n) / WAD),
    rateAtZero: Number(base) / 1e18,
    rateAtKink: Number(base + (slopeLow * kink) / WAD) / 1e18,
    rateAtFull: Number(base + (slopeLow * kink) / WAD + (slopeHigh * (WAD - kink)) / WAD) / 1e18,
    perSecond: true,
    basis: "onchain-rate-function",
  };

  // Prova viva: pergunta ao contrato a taxa logo depois do kink e compara com a
  // curva reconstruída. Tolerância de 1bps absorve arredondamento da conversão
  // pra APY sem deixar passar mudança real de fórmula.
  const probeBps = Math.min(9_900, curve.kinkBps + 300);
  const fromChain = await basePublicClient.readContract({
    address: comet,
    abi: COMET_CURVE_ABI,
    functionName: "getBorrowRate",
    args: [(BigInt(probeBps) * WAD) / 10_000n],
  });
  const expected = compoundedRateToApyBps(Number(fromChain) / 1e18, true);
  const mine = borrowApyBpsAt(curve, probeBps);
  if (Math.abs(expected - mine) > 1) {
    logger.warn(
      { asset, probeBps, expected, mine },
      "curva de juros da Compound divergiu da função de taxa do contrato — omitindo em vez de servir número errado",
    );
    return undefined;
  }
  return curve;
}

// -------------------------------------------------------------------- Aave

const POOL_ABI = [
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "configuration", type: "uint256" },
          { name: "liquidityIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "id", type: "uint16" },
          { name: "aTokenAddress", type: "address" },
          { name: "stableDebtTokenAddress", type: "address" },
          { name: "variableDebtTokenAddress", type: "address" },
          { name: "interestRateStrategyAddress", type: "address" },
          { name: "accruedToTreasury", type: "uint128" },
          { name: "unbacked", type: "uint128" },
          { name: "isolationModeTotalDebt", type: "uint128" },
        ],
      },
    ],
  },
] as const;

// Variante v3.2 (`DefaultReserveInterestRateStrategyV2`): os getters recebem o
// endereço da reserva, porque uma só estratégia atende várias reservas.
// Confirmado ao vivo em 2026-08-05 contra a estratégia do USDC na Base.
const STRATEGY_ABI = [
  { type: "function", name: "getOptimalUsageRatio", stateMutability: "view", inputs: [{ name: "reserve", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getBaseVariableBorrowRate", stateMutability: "view", inputs: [{ name: "reserve", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getVariableRateSlope1", stateMutability: "view", inputs: [{ name: "reserve", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getVariableRateSlope2", stateMutability: "view", inputs: [{ name: "reserve", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getMaxVariableBorrowRate", stateMutability: "view", inputs: [{ name: "reserve", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

/**
 * Aave não tem uma função pura de taxa pra conferir contra, mas tem algo quase
 * tão bom: o próprio contrato reporta o TETO (`getMaxVariableBorrowRate`), que
 * por definição é `base + slope1 + slope2`. Se a identidade não fechar, a forma
 * da curva não é a que este código assume — e a resposta certa é omitir, não
 * servir um número derivado de uma fórmula que mudou.
 *
 * O endereço da estratégia é lido POR CHAMADA (via `getReserveData`), nunca
 * fixado em config: a governança da Aave troca a estratégia de uma reserva sem
 * avisar ninguém, e um endereço chumbado continuaria devolvendo a curva antiga
 * com toda a cara de estar certa.
 */
async function readAaveCurveUncached(asset: LendingAssetId): Promise<BorrowRateCurve | undefined> {
  const token = BASE_ASSETS[asset].token;
  const reserve = await basePublicClient.readContract({
    address: BASE_MAINNET.aave.pool,
    abi: POOL_ABI,
    functionName: "getReserveData",
    args: [token],
  });
  const strategy = reserve.interestRateStrategyAddress;
  if (!strategy || /^0x0+$/.test(strategy)) return undefined;

  const read = (functionName: "getOptimalUsageRatio" | "getBaseVariableBorrowRate" | "getVariableRateSlope1" | "getVariableRateSlope2" | "getMaxVariableBorrowRate") =>
    basePublicClient.readContract({ address: strategy, abi: STRATEGY_ABI, functionName, args: [token] });

  const [optimal, base, slope1, slope2, max] = await Promise.all([
    read("getOptimalUsageRatio"),
    read("getBaseVariableBorrowRate"),
    read("getVariableRateSlope1"),
    read("getVariableRateSlope2"),
    read("getMaxVariableBorrowRate"),
  ]);

  if (optimal <= 0n) return undefined;

  const full = base + slope1 + slope2;
  // Identidade da forma da curva. Tolerância de 1e20 em ray (=1e-7 em fração)
  // só pra absorver arredondamento de configuração, não mudança de fórmula.
  if (full > max + 10n ** 20n || full + 10n ** 20n < max) {
    logger.warn(
      { asset, strategy, full: full.toString(), max: max.toString() },
      "base+slope1+slope2 não bate com o teto reportado pela Aave — forma da curva mudou, omitindo",
    );
    return undefined;
  }

  return {
    protocol: "aave",
    kinkBps: Number((optimal * 10_000n) / RAY),
    rateAtZero: Number(base) / Number(RAY),
    rateAtKink: Number(base + slope1) / Number(RAY),
    rateAtFull: Number(full) / Number(RAY),
    perSecond: false,
    basis: "onchain-curve-params",
  };
}

/**
 * Nunca lança: a curva é CONTEXTO sobre a taxa, não o produto principal — uma
 * falha de RPC aqui não pode derrubar a resposta paga, só deixar o protocolo
 * marcado como não medido. Mesmo espírito de `collectRates`.
 *
 * TTL curto e um cache POR (protocolo, asset), mesmo isolamento já aplicado nos
 * leitores de taxa. Curto de propósito mesmo os parâmetros mudando raramente:
 * quando a governança troca a curva, servir a antiga por muito tempo é
 * exatamente o alarme falso que esta rota existe pra não dar.
 */
const readers: Record<DirectProtocolId, Record<LendingAssetId, (() => Promise<BorrowRateCurve | undefined>) | null>> = {
  compound: {
    USDC: cachedWithTtl(() => readCompoundCurveUncached("USDC"), CACHE_TTL_MS),
    WETH: cachedWithTtl(() => readCompoundCurveUncached("WETH"), CACHE_TTL_MS),
  },
  aave: {
    USDC: cachedWithTtl(() => readAaveCurveUncached("USDC"), CACHE_TTL_MS),
    WETH: cachedWithTtl(() => readAaveCurveUncached("WETH"), CACHE_TTL_MS),
  },
  // Morpho é lido como VAULT e usa um IRM adaptativo sem curva estática — ver a
  // nota no topo deste arquivo. `null` aqui é a afirmação explícita de que não
  // existe curva pra ler, não um "ainda não implementado".
  morpho: { USDC: null, WETH: null },
};

export async function readBorrowRateCurve(
  protocol: DirectProtocolId,
  asset: LendingAssetId,
): Promise<BorrowRateCurve | undefined> {
  const reader = readers[protocol][asset];
  if (!reader) return undefined;
  try {
    return await reader();
  } catch (err) {
    logger.warn({ protocol, asset, err }, "falha lendo curva de juros — protocolo entra como não medido");
    return undefined;
  }
}

/** Fonte única de quem é Camada 1 em runtime — `DirectProtocolId` só existe em tipo. */
const DIRECT_PROTOCOLS = ["aave", "morpho", "compound"] as const satisfies readonly DirectProtocolId[];

function isDirect(protocol: ProtocolId): protocol is DirectProtocolId {
  return (DIRECT_PROTOCOLS as readonly string[]).includes(protocol);
}

/**
 * Lê a curva de todos os protocolos pedidos, em paralelo. Quem não é Camada 1
 * entra no mapa como `undefined` explicitamente — a chave PRESENTE com valor
 * indefinido diz "perguntei e não há", diferente de uma chave ausente, que
 * diria "nem perguntei".
 */
export async function collectBorrowRateCurves(
  asset: LendingAssetId,
  protocols: readonly ProtocolId[],
): Promise<Map<ProtocolId, BorrowRateCurve | undefined>> {
  const entries = await Promise.all(
    protocols.map(async (protocol) => {
      const curve = isDirect(protocol) ? await readBorrowRateCurve(protocol, asset) : undefined;
      return [protocol, curve] as const;
    }),
  );
  return new Map(entries);
}
