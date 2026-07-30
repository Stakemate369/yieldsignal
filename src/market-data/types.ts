// Camada 1: lidos direto on-chain/API oficial do próprio protocolo (mais confiável).
export type DirectProtocolId = "aave" | "morpho" | "compound";

// Camada 2: lidos via DefiLlama yields API (agregador de terceiro) — cobertura
// mais ampla, transparentemente marcada como fonte menos direta que a Camada 1.
// Lista checada contra yields.llama.fi/pools em 2026-07-16, filtrando chain=Base
// e symbol=USDC: Spark (só tem "spark-savings" em USDS, não USDC), Seamless e
// Silo não têm nenhum mercado indexado na Base no momento — por isso não entram
// na lista abaixo. Reconferir a fonte antes de adicionar de volta.
export type DefiLlamaProtocolId = "moonwell" | "euler" | "fluid";

// ETH staking líquido (Ethereum mainnet, via DefiLlama — não existe leitura
// on-chain própria pra isso no repo, mesma categoria de fonte que a Camada 2
// de lending, só que outra chain). Ver market-data/ethStaking.ts. Lista
// verificada ao vivo em 2026-07-20 contra yields.llama.fi/pools (chain=Ethereum):
// os 5 têm APY real distinto (2.19%-2.96%) e TVL alto (>$70M cada) — mesmo
// rigor de "não adivinhar" já aplicado às pools de lending abaixo.
export type StakingProtocolId = "lido" | "rocket-pool" | "coinbase-wrapped-staked-eth" | "frax-ether" | "binance-staked-eth";

export type ProtocolId = DirectProtocolId | DefiLlamaProtocolId | StakingProtocolId;

// Ativo cujo sinal de yield vendido é sobre LENDING na Base — os 3 leitores da
// Camada 1 (aave.ts/compound.ts/morpho.ts) e BASE_ASSETS (config/networks.ts)
// são indexados por este tipo, não por AssetId, porque staking (abaixo) não
// tem mercado de lending equivalente nesses protocolos.
export type LendingAssetId = "USDC" | "WETH";

// Ativo cujo sinal de yield está sendo vendido. USDC é o produto original;
// WETH entrou em 2026-07-17 depois de checar ao vivo contra yields.llama.fi/pools
// que os 6 protocolos têm mercado WETH real na Base com APY distinto entre si
// (0.66%-3.7%) — diferente de cbBTC (único "BTC" que existe de fato na Base,
// não há WBTC canônico lá), cuja APY de supply fica quase sempre 0-0.2% em
// todo protocolo, sinal pouco útil pra vender. cbBTC não entra por isso, não
// por falta de mercado (mesmo tipo de decisão documentada já usada pra
// Spark/Seamless/Silo, ver defillamaPools.ts).
//
// ETH_STAKING entrou em 2026-07-20: categoria DIFERENTE de produto (staking
// líquido em Ethereum mainnet, não lending em Base) — reaproveita toda a
// mecânica já genérica em AssetId (rota x402, free trial, atestação
// automática, dashboard de track record) sem precisar duplicar nenhuma dessa
// infra, mas NÃO entra em BASE_ASSETS/LendingAssetId (ver collectRates.ts).
export type AssetId = LendingAssetId | "ETH_STAKING";

// Única lista canônica dos AssetId vendidos — cli/showSignal.ts, cli/attestSignal.ts
// e o z.enum da tool MCP (mcp.ts) importam daqui em vez de cada um manter a
// própria cópia da lista (achado em revisão: eram 3 literais hand-kept-in-sync,
// exatamente o tipo de coisa que dá pra esquecer de atualizar num asset novo).
export const ASSET_IDS = ["ETH_STAKING", "USDC", "WETH"] as const satisfies readonly AssetId[];

/**
 * Asset "cabeça de vitrine": o que a página inicial lidera, o que os aliases
 * curtos sem asset (`/signal`, `/decision`) resolvem, e o primeiro da lista de
 * endpoints devolvida num 404.
 *
 * É ETH_STAKING por evidência, não por gosto: medido em 2026-07-29 sobre 100
 * atestações EAS reais, o within-tolerance rate por asset era ETH_STAKING 100%
 * / WETH 100% / USDC 37,7% (regret médio 1bps / 0bps / 62bps). O produto
 * original (lending de USDC na Base) é justamente o mais fraco — o mercado gira
 * rápido demais pra chamada durar —, enquanto staking é pegajoso e o sinal se
 * sustenta. Liderar com o asset mais fraco desperdiçava a única prova pública
 * que o serviço tem. O mercado de staking de ETH também é ordens de grandeza
 * maior que lending de USDC na Base.
 *
 * A ORDEM de ASSET_IDS acima segue o mesmo critério (staking primeiro). Nada
 * depende dessa ordem pra funcionar — só a apresentação. E o default da tool
 * MCP continua "USDC" DE PROPÓSITO: mudá-lo alteraria em silêncio o que as
 * integrações já publicadas (plugin elizaOS 0.2.0) recebem sem pedir asset.
 */
export const FLAGSHIP_ASSET: AssetId = "ETH_STAKING";

/**
 * Definição ÚNICA de APY que o serviço compara entre protocolos: juro base MAIS
 * incentivo (reward token), líquido de taxa do próprio protocolo quando a fonte
 * já entrega assim.
 *
 * Existe porque a comparação estava misturando definições — achado real em
 * 2026-07-30 e a causa mais provável da acurácia baixa em USDC: Aave e Compound
 * eram lidos on-chain (`liquidityRate`/`getSupplyRate` = SÓ juro base, sem
 * incentivo), enquanto Morpho (`netApy` da API oficial) e a Camada 2 (campo
 * `apy` da DefiLlama = base + reward) já vinham COM incentivo embutido. Num
 * mercado onde o incentivo é parte relevante do retorno (Moonwell paga WELL,
 * Euler paga rEUL — na leitura de 2026-07-30 o reward era 1,73 de 2,92 pontos
 * da APY de WETH na Euler), isso é comparar coisas diferentes e ranquear errado.
 */
export const APY_BASIS = "supply-apy-total-incl-rewards" as const;

export interface RateReading {
  protocol: ProtocolId;
  asset: AssetId;
  /** APY de supply TOTAL em basis points (1% = 100 bps) — ver APY_BASIS. É o número usado no ranking. */
  supplyApyBps: number;
  /** Componente de juro base (bps). `null` = a fonte não separa os componentes (não significa zero). */
  apyBaseBps: number | null;
  /**
   * Componente de incentivo (bps). Distinção que importa pro consumidor máquina:
   * `0` = sabidamente sem incentivo agora; `null` = desconhecido nesta leitura
   * (a fonte não expõe, ou a consulta do componente falhou) — nesse caso
   * `supplyApyBps` pode estar SUBESTIMADO e o comprador precisa saber.
   */
  apyRewardBps: number | null;
  /**
   * De onde saiu o componente de incentivo — o comprador máquina precisa poder
   * pesar a força da afirmação, não só o número:
   * - `reported`: a fonte informou o componente separadamente.
   * - `inferred`: o agregado da fonte ficou materialmente acima do juro base
   *   lido on-chain e a diferença foi atribuída a incentivo.
   * - `included-not-itemized`: a fonte já entrega tudo somado e não separa
   *   (caso do `netApy` do Morpho).
   * - `unavailable`: nenhum dado de incentivo — `supplyApyBps` é base-only e
   *   PODE ESTAR SUBESTIMADO se houver campanha ativa.
   */
  rewardBasis: "reported" | "inferred" | "included-not-itemized" | "unavailable";
  /**
   * Profundidade do mercado em USD. `null` = não apurável nesta leitura.
   *
   * O serviço já lia este número e o usava só pra descartar pool morto, jogando
   * fora em seguida — o comprador recebia "melhor protocolo" sem saber se o
   * vencedor tem US$ 9 milhões ou US$ 700 mil de fundo. Para um agente com
   * capital de verdade essa é a diferença entre recomendação executável e
   * impossível: a APY do topo de um pool raso não sobrevive à própria entrada
   * dele. Mesmo erro de família já visto em outro projeto (ordenar por retorno
   * bruto faz a rota inviável ganhar da viável).
   */
  tvlUsd: number | null;
  /**
   * O que `tvlUsd` mede — porque as fontes NÃO medem a mesma coisa, e a lição
   * de APY_BASIS vale igual aqui: número comparado sem base declarada engana.
   *
   * - `total-supplied`: tudo que foi depositado no mercado, lido dos livros do
   *   próprio protocolo (Aave `totalAToken`, Comet `totalSupply`, Morpho
   *   `totalAssetsUsd`). É a base certa pra perguntar "minha entrada dilui a
   *   taxa?", que depende da fatia do total.
   * - `aggregator-reported`: o `tvlUsd` da DefiLlama. Pra mercado de lending
   *   ela costuma reportar LIQUIDEZ DISPONÍVEL (depositado menos emprestado),
   *   número menor e com outra pergunta por trás. Medido em 2026-07-30: USDC na
   *   Aave da Base tinha US$ 176M depositados on-chain contra US$ 21,7M
   *   reportados pela DefiLlama.
   * - `null` quando `tvlUsd` é `null`.
   */
  tvlBasis: "total-supplied" | "aggregator-reported" | null;
  source: "onchain" | "api" | "defillama";
  readAt: Date;
}
