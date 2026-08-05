import type { LendingAssetId, MarketLiquidity } from "./types.js";

/**
 * Profundidade do mercado, em USD, a partir do saldo que o PRÓPRIO protocolo
 * reporta on-chain.
 *
 * Por que não usar sempre o agregador: medido em 2026-07-30, a DefiLlama
 * reportava US$ 788.850 de TVL pro mercado de USDC da Compound v3 na Base
 * enquanto o `totalSupply()` do Comet dizia US$ 8.446.455 — dez vezes maior.
 * Um número de profundidade errado por uma ordem de grandeza é pior que
 * nenhum: ele dispararia o aviso de "sua posição é grande demais pra este
 * mercado" num mercado que comporta a posição folgadamente.
 *
 * Por que SÓ stablecoin: converter o saldo de um mercado de WETH em dólar
 * exigiria um oráculo de preço dentro do caminho de uma resposta paga — mais
 * uma dependência e mais um modo de falha, pra um dado que é indicativo. Fora
 * da stablecoin a resposta cai no TVL do agregador (ver incentives.ts), e
 * quando nem isso existe o campo vai `null` em vez de um palpite.
 *
 * A conversão 1:1 assume USDC valendo um dólar. Num depeg o número erra na
 * proporção do depeg — irrelevante pra uma medida de ordem de grandeza, e
 * preferível a não ter medida nenhuma.
 */
const USD_STABLE_DECIMALS: Partial<Record<LendingAssetId, number>> = {
  USDC: 6,
};

export function onchainDepthUsd(asset: LendingAssetId, rawBalance: bigint | undefined): number | null {
  const decimals = USD_STABLE_DECIMALS[asset];
  if (decimals === undefined || rawBalance === undefined) return null;
  const value = Number(rawBalance) / 10 ** decimals;
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/**
 * Como `onchainDepthUsd`, mas ZERO é um resultado válido em vez de `null`.
 *
 * A distinção importa exatamente uma vez, e é justamente no caso que mais
 * interessa ao comprador: um mercado 100% utilizado tem zero sacável. Servir
 * `null` ali ("não apurado") num campo de liquidez leria como "sem informação"
 * quando na verdade a informação é a pior possível. `onchainDepthUsd` mantém o
 * corte em `> 0` porque lá o zero significa outra coisa — pool sem profundidade
 * apurável, que é descartado mesmo.
 */
function stableUnits(asset: LendingAssetId, rawBalance: bigint): number | null {
  const decimals = USD_STABLE_DECIMALS[asset];
  if (decimals === undefined) return null;
  const value = Number(rawBalance) / 10 ** decimals;
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * Monta a leitura de liquidez a partir dos saldos brutos que o protocolo já
 * expôs na MESMA chamada que trouxe a taxa. Puro — a aritmética fica testável
 * sem RPC, e os dois leitores (Aave e Compound) compartilham as mesmas guardas
 * em vez de cada um reimplementar as suas.
 *
 * `utilizationBps` não tem unidade, então vale pra WETH também; os campos em USD
 * seguem a restrição de stablecoin de `onchainDepthUsd` acima.
 *
 * Devolve `undefined` (não um objeto com zeros) quando o mercado não tem nada
 * fornecido: `emprestado ÷ 0` não é 0% de utilização, é indefinido — e servir 0
 * ali significaria "totalmente líquido", o oposto do que se sabe.
 */
export function marketLiquidity(
  asset: LendingAssetId,
  suppliedRaw: bigint,
  borrowedRaw: bigint,
): MarketLiquidity | undefined {
  if (suppliedRaw <= 0n || borrowedRaw < 0n) return undefined;
  // Clamp: juro acumulado pode deixar o emprestado marginalmente acima do
  // fornecido por um instante. 100% de utilização e zero sacável é a leitura
  // honesta desse estado — melhor que um "disponível" negativo.
  const borrowed = borrowedRaw > suppliedRaw ? suppliedRaw : borrowedRaw;
  const available = suppliedRaw - borrowed;

  return {
    utilizationBps: Number((borrowed * 10_000n) / suppliedRaw),
    availableLiquidityUsd: stableUnits(asset, available),
    totalSuppliedUsd: stableUnits(asset, suppliedRaw),
  };
}
