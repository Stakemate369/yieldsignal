import express from "express";
// ATENÇÃO: import a confirmar na prática assim que houver credenciais CDP
// reais pra testar (ver plano — item de verificação em runtime). A forma
// exata de `createX402Server`/`paymentMiddlewareFromHTTPServer` vem da
// documentação oficial da CDP (docs.cdp.coinbase.com/x402/quickstart-for-sellers)
// consultada em 2026-07-16; se o pacote instalado expuser uma API um pouco
// diferente, ajustar aqui é o primeiro lugar a olhar.
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { loadEnv } from "./config/env.js";
import { X402_RECEIVER_ACCOUNT_NAME } from "./config/networks.js";
import { assertWalletAddress } from "./wallet/walletLock.js";
import { collectRates } from "./signal/collectRates.js";
import { computeSignal } from "./signal/computeSignal.js";
import { decideMove } from "./signal/decideMove.js";
import { parseDecisionQuery } from "./signal/parseDecisionQuery.js";
import { computeDurability } from "./signal/durability.js";
import { computeCapacity } from "./signal/capacity.js";
import { computeSensitivity } from "./signal/sensitivity.js";
import { collectBorrowRateCurves } from "./market-data/rateCurve.js";
import { computeExposure } from "./signal/exposure.js";
import { collectExposureFactors } from "./market-data/exposureFactors.js";
import { parsePositions } from "./signal/parsePositions.js";
import { computeAccuracyScore } from "./attestation/accuracyScore.js";
import { computeWindowedAccuracy } from "./attestation/windowedAccuracy.js";
import { fetchSignalAttestations } from "./attestation/queryAttestations.js";
import { GUARANTEE_TERMS } from "./guarantee/terms.js";
import type { AssetId, LendingAssetId } from "./market-data/types.js";
import { FLAGSHIP_ASSET } from "./market-data/types.js";
import { cachedWithTtl } from "./market-data/cache.js";
import { createMcpRequestHandler } from "./mcp.js";
import { renderLandingPage } from "./landingPage.js";
import { logger } from "./notify/logger.js";
import { logSettledPayment, recordSettlementUsage } from "./notify/paymentLog.js";
import { recordUsage, readUsage, probeUsageStore } from "./usage/usageStore.js";
import { usageEntryMiddleware } from "./usage/usageMiddleware.js";
import { notFoundLabel } from "./usage/notFoundLabel.js";
import { sendTelegramAlert } from "./notify/telegram.js";
import { getSignerAccount } from "./wallet/signerAccount.js";
import { signPayload, eip712ForTransport } from "./signal/signResponse.js";
import { runAutoAttestForAsset } from "./attestation/autoAttest.js";
import { readGasRunway } from "./attestation/gasRunway.js";
import { runSensitivityAttestForAsset } from "./attestation/autoAttestSensitivity.js";
import { readDeployDrift } from "./notify/deployDrift.js";
import { buildTrackRecord } from "./attestation/trackRecord.js";
import { TRACK_RECORD_PAGE_HTML } from "./trackRecordPage.js";
import { AGENT_CARD_JSON } from "./agentCard.js";
import { buildOpenApi, buildWellKnownX402, type DiscoveryRoute } from "./discoveryDocument.js";
import { FAVICON_ICO } from "./favicon.js";

// Um path por ativo vendido — cada um é uma rota x402 protegida separada,
// mesmo preço/descrição-base, preço e descrição próprios só pra deixar claro
// no 402 qual sinal está sendo cobrado.
// Ordem = ordem de apresentação (registro das rotas, lista de endpoints do 404,
// iteração do auto-attest). ETH_STAKING primeiro por evidência de acurácia —
// ver FLAGSHIP_ASSET em market-data/types.ts. Nada funcional depende da ordem.
export const RESOURCE_PATHS: Record<AssetId, string> = {
  ETH_STAKING: "/signal/eth-staking-yield",
  USDC: "/signal/usdc-base-yield",
  WETH: "/signal/weth-base-yield",
};

// Mantido pra quem ainda referencia o path original diretamente (scripts de
// teste manual) — sempre igual a RESOURCE_PATHS.USDC, nunca diverge.
export const RESOURCE_PATH = RESOURCE_PATHS.USDC;

// CAMADA 1 (premium): rotas de DECISÃO — pagas e assinadas como os sinais,
// mas vendem a recomendação MOVE/HOLD (com break-even e confiança), não o
// dado bruto. Um path por ativo, separado das rotas de sinal acima.
export const DECISION_PATHS: Record<AssetId, string> = {
  ETH_STAKING: "/decision/eth-staking-yield",
  USDC: "/decision/usdc-base-yield",
  WETH: "/decision/weth-base-yield",
};

// CAMADA 1 (analítica): rotas de DURABILIDADE — "quanto desta APY sobra se o
// incentivo parar?". Ver signal/durability.ts sobre por que NÃO existe previsão
// de data aqui.
//
// Só LendingAssetId, e a razão é medida, não estética: checado ao vivo em
// 2026-08-05, os CINCO protocolos de staking (lido, rocket-pool,
// coinbase-wrapped-staked-eth, frax-ether, binance-staked-eth) vêm da DefiLlama
// com `apyReward: null` — ou seja, 0 de 5 decomponíveis, sempre. A rota de
// ETH_STAKING cobraria pra devolver "não consigo afirmar nada" em toda chamada.
// (Que staking não TENHA incentivo é plausível e até provável, mas `apyReward`
// ausente não prova ausência de incentivo — é a mesma inferência que este
// serviço se recusa a fazer pra fluid/morpho no lending.)
export const DURABILITY_PATHS: Record<LendingAssetId, string> = {
  USDC: "/durability/usdc-base-yield",
  WETH: "/durability/weth-base-yield",
};

// CAMADA 1 (analítica): rotas de CAPACIDADE — "eu consigo sair deste mercado?".
// Só LendingAssetId: utilização e liquidez livre saem dos livros de um mercado
// de EMPRÉSTIMO (Aave/Compound). Staking líquido não tem mercado equivalente —
// a saída lá é resgate/swap, outra pergunta e outra fonte. Vender uma rota de
// capacidade pra ETH_STAKING seria cobrar por uma resposta toda em `null`.
export const CAPACITY_PATHS: Record<LendingAssetId, string> = {
  USDC: "/capacity/usdc-base-yield",
  WETH: "/capacity/weth-base-yield",
};

// CAMADA 1 (analítica): rotas de EXPOSIÇÃO — "estou em N protocolos, mas atrás
// de quantos riscos distintos?". Primeira rota que RECEBE dado do comprador
// (`?positions=`), daí a validação rígida em signal/parsePositions.ts.
export const EXPOSURE_PATHS: Record<LendingAssetId, string> = {
  USDC: "/exposure/usdc-base-yield",
  WETH: "/exposure/weth-base-yield",
};

const EXPOSURE_DESCRIPTIONS: Record<LendingAssetId, string> = {
  USDC: "Shared risk exposure across declared positions: pass ?positions=aave:200000,morpho:150000 and get, per factor, how much capital sits behind the same collateral, oracle or curator, and via which venues. Morpho is attributed per isolated market, Compound by its real posted-collateral basket; Aave is unattributed because a v3 supplier is exposed to the whole pool, never split across assets.",
  WETH: "Shared risk exposure across declared WETH positions — same contract as the USDC exposure route. Pass ?positions=aave:100000,morpho:50000. Protocols whose collateral composition cannot be established are reported unattributed with the reason, never split across assets to imply diversification.",
};

// CAMADA 1 (analítica): rotas de SENSIBILIDADE — "a que distância este mercado
// está do joelho onde a taxa dispara?". Primeira rota que fala com o lado
// TOMADOR, não só com o credor. Só LendingAssetId, e só Aave/Compound têm curva
// legível — ver a nota em market-data/rateCurve.ts sobre Morpho.
export const SENSITIVITY_PATHS: Record<LendingAssetId, string> = {
  USDC: "/sensitivity/usdc-base-yield",
  WETH: "/sensitivity/weth-base-yield",
};

/**
 * Todo caminho PAGO do serviço, numa lista só. Existe pra ser testável: sem
 * ela, "existe alias sombreando rota paga?" só dá pra responder lendo o arquivo
 * inteiro — e um alias que colide com um caminho canônico serviria um redirect
 * onde deveria sair um 402, quebrando o pagamento em silêncio, do lado do
 * COMPRADOR (o servidor continuaria parecendo saudável).
 */
export const PAID_PATHS: readonly string[] = [
  ...Object.values(RESOURCE_PATHS),
  ...Object.values(DECISION_PATHS),
  ...Object.values(DURABILITY_PATHS),
  ...Object.values(CAPACITY_PATHS),
  ...Object.values(SENSITIVITY_PATHS),
  ...Object.values(EXPOSURE_PATHS),
];

const SENSITIVITY_DESCRIPTIONS: Record<LendingAssetId, string> = {
  USDC: "How close USDC lending on Base is to the kink where borrow rates explode: per-protocol utilization, the kink read from the protocol's own rate curve, headroom in bps, and borrow APY at points around it. Aave and Compound only — Morpho's adaptive IRM has no static curve and DefiLlama-sourced protocols expose none, so they are marked unmeasured, never assumed stable. Describes state, not a forecast.",
  WETH: "How close WETH lending on Base is to the kink where borrow rates explode — same contract as the USDC sensitivity route. Aave and Compound only; protocols without a readable curve are marked unmeasured, never assumed stable. Describes state, not a forecast.",
};

const DURABILITY_DESCRIPTIONS: Record<LendingAssetId, string> = {
  USDC: "How much of the USDC lending APY on Base survives if incentives stop: per-protocol base-vs-reward split, the post-incentive floor, and whether the leader changes without incentives. Derived only from reported/inferred reward components already read — sources that do not itemize are listed as undecomposable, never assumed incentive-free. A stress test of current readings, not a date forecast.",
  WETH: "How much of the WETH lending APY on Base survives if incentives stop — same contract as the USDC durability route, for WETH. Undecomposable sources are named, never assumed incentive-free. Stress test of current readings, not a date forecast.",
};

const CAPACITY_DESCRIPTIONS: Record<LendingAssetId, string> = {
  USDC: "Exit capacity for USDC lending on Base: per-protocol utilization and withdrawable liquidity read from the protocol's own books (Aave, Compound), plus whether your size (?amountUsd=) can be withdrawn right now and what share of the market it would be. Protocols that do not expose borrowed-vs-supplied are marked unmeasured, never assumed liquid.",
  WETH: "Exit capacity for WETH lending on Base — same contract as the USDC capacity route. Utilization is reported for every measured protocol; USD figures are omitted for WETH (no price oracle in the paid path), so size verdicts need the USDC route. Unmeasured protocols are named, never assumed liquid.",
};

const DECISION_DESCRIPTIONS: Record<AssetId, string> = {
  USDC: "Buyer-side MOVE/HOLD decision for USDC lending on Base: given your position (?position=), size (?amountUsd=), move cost (?moveCostUsd=) and horizon (?horizonDays=), returns whether moving to the best risk-adjusted protocol pays for itself — with expected net gain, break-even days and a confidence tier. Sells the decision, not the raw datapoint.",
  WETH: "Buyer-side MOVE/HOLD decision for WETH lending on Base — same contract as the USDC decision route, for WETH.",
  ETH_STAKING: "Buyer-side MOVE/HOLD decision for ETH liquid staking (Ethereum mainnet) — same contract as the lending decision routes, for ETH staking.",
};

// LIMITE DURO: `resource.description` do desafio 402 não pode passar de 500
// caracteres. O facilitador da CDP recusa o pagamento acima disso com um erro
// que não diz o motivo ("'paymentPayload' is invalid: must match one of
// [x402V2PaymentPayload, x402V1PaymentPayload]") — o servidor continua servindo
// 402 normalmente e só o COMPRADOR falha, então a quebra é invisível de dentro.
// Limite medido por busca binária contra o /verify da CDP em 2026-07-30
// (500 aceita, 501 recusa); não está documentado em lugar nenhum.
//
// Custou caro descobrir: o ACCURACY_POINTER abaixo tinha 248 chars e, ao ser
// somado a TODA descrição em 2026-07-29, estourou o limite em 4 das 6 rotas de
// uma vez — inclusive as 3 de sinal, que ficaram sem conseguir receber
// pagamento sem nenhum sinal de erro. A rota de ETH staking já nascia com 631
// e nunca tinha conseguido receber um pagamento sequer.
//
// `test/routeDescriptionLimit.test.ts` trava isso — não afrouxar o teste.
export const MAX_DESCRIPTION_CHARS = 500;

// Sufixo comum a TODA descrição de rota — é o texto que o comprador-robô lê no
// próprio desafio 402 e nos diretórios (Bazaar, trust indexes). Aponta pro
// score de acurácia POR ASSET em vez de afirmar um número aqui: número escrito
// à mão numa descrição apodrece e não é verificável, que é o oposto do que este
// serviço vende. O consumidor compara os assets por conta própria e escolhe.
// Mantido CURTO de propósito: cada char aqui sai do orçamento das 6 descrições.
const ACCURACY_POINTER =
  " Verified per-asset accuracy is free at /accuracy.json; raw on-chain attestations at /track-record.";

const ROUTE_DESCRIPTIONS: Record<AssetId, string> = {
  USDC: "Real-time risk-weighted USDC lending APY on Base: Aave/Compound/Morpho read onchain, Moonwell/Euler/Fluid via DefiLlama, source tagged per reading (never estimated). EIP-712 signed by the payment-receiving address (see X-Signal-* headers), which also holds an ERC-8004 identity and attests readings on-chain via EAS.",
  WETH: "Real-time risk-weighted WETH lending APY on Base: Aave/Compound/Morpho read onchain, Moonwell/Euler/Fluid via DefiLlama, source tagged per reading (never estimated). EIP-712 signed by the payment-receiving address (see X-Signal-* headers), which also holds an ERC-8004 identity and attests readings on-chain via EAS.",
  ETH_STAKING: "Real-time risk-weighted ETH liquid staking APY on Ethereum mainnet: Lido/Rocket Pool/Coinbase Wrapped Staked ETH/Frax Ether/Binance Staked ETH via DefiLlama, source tagged per reading (never estimated). Staking yield, not a Base lending market. EIP-712 signed by the payment-receiving address (see X-Signal-* headers).",
};

/**
 * Descrição FINAL de cada rota — o texto EXATO que vai no desafio 402.
 * Fonte única: tanto o registro das rotas abaixo quanto
 * `test/routeDescriptionLimit.test.ts` leem daqui, pra que o teste meça o mesmo
 * texto que o comprador recebe em vez de uma cópia que pode divergir.
 */
export const SHORT_ALIASES: Record<string, string> = {
  "/signal/usdc": RESOURCE_PATHS.USDC,
  "/signal/weth": RESOURCE_PATHS.WETH,
  "/signal/eth-staking": RESOURCE_PATHS.ETH_STAKING,
  "/decision/usdc": DECISION_PATHS.USDC,
  "/decision/weth": DECISION_PATHS.WETH,
  "/decision/eth-staking": DECISION_PATHS.ETH_STAKING,
  // Sem asset nenhum: resolve pro asset de vitrine (o de melhor histórico
  // verificado, ver FLAGSHIP_ASSET). Um agente que chuta a raiz do recurso
  // recebia 404; agora cai no produto mais defensável do catálogo.
  "/signal": RESOURCE_PATHS[FLAGSHIP_ASSET],
  "/decision": DECISION_PATHS[FLAGSHIP_ASSET],
  "/durability/usdc": DURABILITY_PATHS.USDC,
  "/durability/weth": DURABILITY_PATHS.WETH,
  // Como `/capacity` abaixo: resolve pra USDC e NÃO pro FLAGSHIP_ASSET,
  // porque ETH_STAKING não tem rota de durabilidade (ver DURABILITY_PATHS).
  "/durability": DURABILITY_PATHS.USDC,
  "/capacity/usdc": CAPACITY_PATHS.USDC,
  "/capacity/weth": CAPACITY_PATHS.WETH,
  // `/capacity` sem asset resolve pra USDC, NÃO pro FLAGSHIP_ASSET como as
  // outras famílias: o asset de vitrine é ETH_STAKING, que de propósito não
  // tem rota de capacidade (staking não é mercado de empréstimo). Apontar pro
  // flagship aqui geraria um 404 justamente no chute mais provável.
  "/capacity": CAPACITY_PATHS.USDC,
  "/sensitivity/usdc": SENSITIVITY_PATHS.USDC,
  "/sensitivity/weth": SENSITIVITY_PATHS.WETH,
  // Mesmo motivo de /capacity e /durability: resolve pra USDC, não pro
  // FLAGSHIP_ASSET, porque staking não tem rota de sensibilidade.
  "/sensitivity": SENSITIVITY_PATHS.USDC,
  "/exposure/usdc": EXPOSURE_PATHS.USDC,
  "/exposure/weth": EXPOSURE_PATHS.WETH,
  "/exposure": EXPOSURE_PATHS.USDC,
};

/**
 * Metadados de descoberta do Bazaar para as rotas que RECEBEM parâmetro.
 *
 * O SDK da CDP já injeta uma declaração mínima por rota (método + caminho), e é
 * ela que faz o serviço aparecer no Bazaar assim que o facilitador liquida o
 * primeiro pagamento — não existe cadastro. O problema é que o mínimo não
 * descreve query param nenhum: um agente que descobrisse `/exposure/...` no
 * catálogo não teria como saber que `positions` é OBRIGATÓRIO. Ele chamaria,
 * PAGARIA, e receberia 400. Estar listado e ser utilizável são coisas
 * diferentes, e a diferença é este objeto.
 *
 * Declarado só onde há parâmetro: as rotas de sinal, durabilidade e
 * sensibilidade não recebem nada, e a declaração automática já as descreve
 * inteiramente.
 */
function bazaarQuery(input: Record<string, unknown>, properties: Record<string, unknown>, required?: string[]) {
  // `method` NÃO entra: o pacote o deriva da chave da rota, e o tipo o omite de
  // propósito pra as duas fontes não poderem divergir. O retorno já vem no
  // formato `{ bazaar: ... }` que o campo `extensions` da rota espera.
  return declareDiscoveryExtension({
    input,
    inputSchema: { properties, ...(required && required.length > 0 ? { required } : {}) },
  });
}

const BAZAAR_DECISION = bazaarQuery(
  { position: "aave", amountUsd: 25000, horizonDays: 30 },
  {
    position: { type: "string", description: "Protocol where your capital sits now, or 'idle' if uninvested." },
    amountUsd: { type: "number", description: "Position size in USD. Scales the gain and the break-even." },
    moveCostUsd: { type: "number", description: "Your estimated cost to move (gas + slippage), in USD." },
    horizonDays: { type: "number", description: "Days you expect to hold before re-evaluating." },
  },
);

const BAZAAR_CAPACITY = bazaarQuery(
  { amountUsd: 200000 },
  {
    amountUsd: {
      type: "number",
      description: "Position size in USD to test for exit. Omit to get utilization and free liquidity without a verdict.",
    },
  },
);

const BAZAAR_EXPOSURE = bazaarQuery(
  { positions: "aave:200000,morpho:150000" },
  {
    positions: {
      type: "string",
      description:
        "REQUIRED. Your positions as comma-separated protocol:usd pairs. Known protocols: aave, morpho, compound, moonwell, euler, fluid.",
    },
  },
  ["positions"],
);

export const FINAL_DESCRIPTIONS: {
  signal: Record<AssetId, string>;
  decision: Record<AssetId, string>;
  durability: Record<LendingAssetId, string>;
  capacity: Record<LendingAssetId, string>;
  sensitivity: Record<LendingAssetId, string>;
  exposure: Record<LendingAssetId, string>;
} = {
  signal: Object.fromEntries(
    (Object.keys(ROUTE_DESCRIPTIONS) as AssetId[]).map((a) => [a, ROUTE_DESCRIPTIONS[a] + ACCURACY_POINTER]),
  ) as Record<AssetId, string>,
  decision: Object.fromEntries(
    (Object.keys(DECISION_DESCRIPTIONS) as AssetId[]).map((a) => [a, DECISION_DESCRIPTIONS[a] + ACCURACY_POINTER]),
  ) as Record<AssetId, string>,
  durability: Object.fromEntries(
    (Object.keys(DURABILITY_DESCRIPTIONS) as LendingAssetId[]).map((a) => [
      a,
      DURABILITY_DESCRIPTIONS[a] + ACCURACY_POINTER,
    ]),
  ) as Record<LendingAssetId, string>,
  capacity: Object.fromEntries(
    (Object.keys(CAPACITY_DESCRIPTIONS) as LendingAssetId[]).map((a) => [a, CAPACITY_DESCRIPTIONS[a] + ACCURACY_POINTER]),
  ) as Record<LendingAssetId, string>,
  sensitivity: Object.fromEntries(
    (Object.keys(SENSITIVITY_DESCRIPTIONS) as LendingAssetId[]).map((a) => [
      a,
      SENSITIVITY_DESCRIPTIONS[a] + ACCURACY_POINTER,
    ]),
  ) as Record<LendingAssetId, string>,
  exposure: Object.fromEntries(
    (Object.keys(EXPOSURE_DESCRIPTIONS) as LendingAssetId[]).map((a) => [a, EXPOSURE_DESCRIPTIONS[a] + ACCURACY_POINTER]),
  ) as Record<LendingAssetId, string>,
};

/**
 * Constrói o app Express configurado (rota x402 + trava de carteira), sem
 * chamar `.listen()` — reaproveitado tanto pelo entrypoint local
 * (`server.ts`, que dá `.listen()`) quanto pela função serverless da Vercel
 * (`api/index.ts`, onde a própria plataforma cuida do HTTP listener).
 */
export async function createApp(): Promise<{ app: express.Express; payToEvmAddress: string }> {
  const env = loadEnv();

  const server = await createX402Server({
    environment: env.X402_ENVIRONMENT,
    // Nome explícito (em vez do default implícito do SDK) pra garantir que
    // cli/withdraw.ts, que resolve a MESMA conta por nome de forma
    // independente, sempre bata com o endereço que este servidor usa.
    payToConfig: { type: "eoa", accountName: X402_RECEIVER_ACCOUNT_NAME },
    // Construído a partir de RESOURCE_PATHS/ROUTE_DESCRIPTIONS (mesma fonte
    // que o loop de registro dos handlers GET mais abaixo) em vez de listar
    // cada asset à mão aqui — duas cópias hand-kept-in-sync é exatamente o
    // tipo de coisa que dá pra esquecer de atualizar ao somar um asset novo.
    routes: Object.fromEntries([
      ...(Object.keys(RESOURCE_PATHS) as AssetId[]).map((asset) => [
        `GET ${RESOURCE_PATHS[asset]}`,
        { price: env.PRICE_USD, description: FINAL_DESCRIPTIONS.signal[asset] },
      ]),
      // Rotas de decisão (Camada 1) — preço PREMIUM (DECISION_PRICE_USD, default
      // $0.05 vs $0.01 do sinal cru): a decisão MOVE/HOLD vale mais que o dado
      // que a DefiLlama dá de graça, e o preço sinaliza isso ao robô-comprador.
      // Mesma fonte de preço usada pela tool MCP get_yield_decision.
      ...(Object.keys(DECISION_PATHS) as AssetId[]).map((asset) => [
        `GET ${DECISION_PATHS[asset]}`,
        {
          price: env.DECISION_PRICE_USD,
          description: FINAL_DESCRIPTIONS.decision[asset],
          extensions: BAZAAR_DECISION,
        },
      ]),
      // As 4 analíticas têm preço PRÓPRIO (ANALYTICS_PRICE_USD), entre o sinal
      // cru e a decisão. Nasceram no preço base por não terem track record
      // próprio; a ordem "primeiro o histórico verificável, depois o preço" foi
      // cumprida — a sensibilidade é atestada on-chain desde 2026-08-06 e as
      // quatro derivam de medição que nenhuma outra fonte pública oferece. O
      // sinal cru fica no preço menor porque é o único que compete com dado
      // grátis (DefiLlama); as analíticas não competem com nada.
      ...(Object.keys(DURABILITY_PATHS) as LendingAssetId[]).map((asset) => [
        `GET ${DURABILITY_PATHS[asset]}`,
        { price: env.ANALYTICS_PRICE_USD, description: FINAL_DESCRIPTIONS.durability[asset] },
      ]),
      ...(Object.keys(CAPACITY_PATHS) as LendingAssetId[]).map((asset) => [
        `GET ${CAPACITY_PATHS[asset]}`,
        {
          price: env.ANALYTICS_PRICE_USD,
          description: FINAL_DESCRIPTIONS.capacity[asset],
          extensions: BAZAAR_CAPACITY,
        },
      ]),
      ...(Object.keys(SENSITIVITY_PATHS) as LendingAssetId[]).map((asset) => [
        `GET ${SENSITIVITY_PATHS[asset]}`,
        { price: env.ANALYTICS_PRICE_USD, description: FINAL_DESCRIPTIONS.sensitivity[asset] },
      ]),
      ...(Object.keys(EXPOSURE_PATHS) as LendingAssetId[]).map((asset) => [
        `GET ${EXPOSURE_PATHS[asset]}`,
        {
          price: env.ANALYTICS_PRICE_USD,
          description: FINAL_DESCRIPTIONS.exposure[asset],
          extensions: BAZAAR_EXPOSURE,
        },
      ]),
    ]),
  });

  // Trava o endereço receptor ANTES de aceitar qualquer request real — lição
  // aplicada de forma proativa (ver wallet/walletLock.ts). payToEvmAddress só
  // é undefined se nenhuma rota EIP-155 foi provisionada, o que não é o caso
  // aqui (redes default incluem eip155:8453/84532 pras rotas).
  if (!server.payToEvmAddress) {
    throw new Error("createX402Server não provisionou uma carteira EVM — não é seguro aceitar pagamentos assim.");
  }
  assertWalletAddress(env.X402_ENVIRONMENT, server.payToEvmAddress, env.EXPECTED_WALLET_ADDRESS);

  // Segunda resolução independente da MESMA carteira (mesmo nome de conta,
  // mesmas credenciais), só que com `signMessage` exposto — createX402Server
  // não expõe isso. Comparação abaixo é barata e pega de graça qualquer
  // divergência entre as duas resoluções (nunca deveria acontecer, mas o
  // custo de checar é uma comparação de string).
  const signer = await getSignerAccount();
  if (signer.address.toLowerCase() !== server.payToEvmAddress.toLowerCase()) {
    throw new Error(
      `carteira de assinatura (${signer.address}) diverge da carteira receptora de pagamento (${server.payToEvmAddress}) — não é seguro assinar respostas com um endereço diferente do que está anunciado pro comprador.`,
    );
  }

  // Fato de pagamento (payer/tx/network/valor real) — as duas rotas REST
  // compartilham este único x402ResourceServer, então o registro é um só
  // aqui; ver notify/paymentLog.ts pro porquê de não travar a liquidação se
  // o log falhar, e pro porquê de "channel" ser fixo em "rest" (o canal MCP
  // usa seu PRÓPRIO x402ResourceServer, registrado à parte em mcp.ts).
  server.resourceServer.onAfterSettle(async (context) => {
    logSettledPayment(context, "rest");
    // Aguardado (não solto): em serverless a instância pode congelar assim que a
    // resposta sai, e perder justamente o registro da venda.
    await recordSettlementUsage(context, "rest");
  });

  const app = express();
  // Vercel/qualquer proxy reverso: sem isso, req.ip sempre retorna o IP do
  // proxy, não do chamador real — quebraria a cota gratuita por IP abaixo.
  app.set("trust proxy", true);

  // Página inicial com a tabela de acurácia renderizada do dado REAL a cada
  // carga (nunca número hardcoded, que apodrece e vira propaganda falsa). O
  // score vem do mesmo caminho de /accuracy.json, atrás de um cache de 10min
  // pra não consultar o EAS a cada visita; se a consulta falhar, a página é
  // servida SEM a seção em vez de com dado velho ou com 5xx.

  // Migração de schema resolvida em UM lugar só: `attestSchemaUid` é onde as
  // atestações NOVAS são gravadas e `legacySchemaUids` é o que entra JUNTO na
  // leitura do histórico. Com EAS_SCHEMA_UID_V2 vazio os dois colapsam no v1 e
  // nada muda; com ele preenchido, o histórico anterior continua aparecendo no
  // track record público em vez de zerar no dia da virada.
  const attestSchemaUid = (env.EAS_SCHEMA_UID_V2 || env.EAS_SCHEMA_UID) as `0x${string}`;
  const attestSchemaVersion: 1 | 2 = env.EAS_SCHEMA_UID_V2 ? 2 : 1;
  const legacySchemaUids = (env.EAS_SCHEMA_UID_V2 && env.EAS_SCHEMA_UID ? [env.EAS_SCHEMA_UID] : []) as `0x${string}`[];
  const hasAttestationSchema = Boolean(env.EAS_SCHEMA_UID || env.EAS_SCHEMA_UID_V2);

  const cachedAccuracyScore = cachedWithTtl(async () => {
    if (!hasAttestationSchema) return null;
    // Uma consulta ao EASScan alimenta as duas métricas da página (direcional e
    // por janela) — o track record reaproveita as atestações já buscadas.
    const attestations = await fetchSignalAttestations({
      schemaId: attestSchemaUid,
        alsoSchemaIds: legacySchemaUids,
      attester: signer.address,
    });
    const entries = await buildTrackRecord({
      schemaUid: attestSchemaUid,
      attester: signer.address,
      attestations,
    });
    return { score: computeAccuracyScore(entries), windowed: computeWindowedAccuracy(attestations) };
  }, 10 * 60 * 1000);

  // Handler assíncrono precisa capturar TUDO por dentro: Express 4 não trata
  // rejeição de handler async, e uma unhandled rejection derruba o processo
  // inteiro (não existe processGuards neste repo). Vale pra toda rota async
  // adicionada aqui.
  app.get("/", async (_req, res) => {
    let accuracy: Awaited<ReturnType<typeof cachedAccuracyScore>> = null;
    try {
      accuracy = await cachedAccuracyScore();
    } catch (err) {
      logger.warn({ err }, "não deu pra ler o score de acurácia pra página inicial — servindo sem a seção");
    }
    try {
      res.type("html").send(
        renderLandingPage({
          score: accuracy?.score ?? null,
          windowed: accuracy?.windowed ?? null,
          signalPrice: env.PRICE_USD,
          analyticsPrice: env.ANALYTICS_PRICE_USD,
          decisionPrice: env.DECISION_PRICE_USD,
        }),
      );
    } catch (err) {
      // Score em formato inesperado não pode virar 5xx na página de entrada:
      // degrada pro cartão de visita mínimo, sem a seção de acurácia.
      logger.error({ err }, "falha renderizando a página inicial com score — servindo versão sem score");
      res
        .type("html")
        .send(
          renderLandingPage({
            score: null,
            signalPrice: env.PRICE_USD,
            analyticsPrice: env.ANALYTICS_PRICE_USD,
            decisionPrice: env.DECISION_PRICE_USD,
          }),
        );
    }
  });

  // Liveness barato pra monitoramento externo (cron-job.org) — rota própria,
  // fora do produto pago, pra um monitor de uptime não precisar de carteira.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", asOf: new Date().toISOString() });
  });

  // Gatilho de atestação automática — pensado pra ser chamado por um cron
  // EXTERNO (cron-job.org, mesmo serviço já usado pro /health; Vercel Cron no
  // plano Hobby só dispara 1x/dia, cedo demais pra isso). DIFERENTE do padrão
  // "vazio = endpoint aberto" usado em checks read-only: aqui vazio SEMPRE
  // nega (fail-closed), porque a rota pode gastar ETH de gas real — só roda
  // se CRON_TRIGGER_SECRET estiver configurado E o header bater exatamente.
  // Cada asset é isolado (Promise.allSettled não é nem preciso — o próprio
  // runAutoAttestForAsset nunca lança, sempre devolve um resultado) pra um
  // erro num asset não esconder o resultado do outro.
  app.post("/internal/auto-attest", express.json(), async (req, res) => {
    if (!env.CRON_TRIGGER_SECRET || req.headers.authorization !== `Bearer ${env.CRON_TRIGGER_SECRET}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (env.X402_ENVIRONMENT !== "production" || !hasAttestationSchema) {
      res.status(400).json({ error: "auto-attest exige X402_ENVIRONMENT=production e EAS_SCHEMA_UID configurado" });
      return;
    }
    const results = await Promise.all(
      (Object.keys(RESOURCE_PATHS) as AssetId[]).map((asset) =>
        runAutoAttestForAsset(asset, {
          signer,
          schemaUid: attestSchemaUid,
          minGasReserveEth: env.MIN_GAS_RESERVE_ETH,
        }),
      ),
    );
    // Atestação de SENSIBILIDADE — primeiro dos produtos analíticos a entrar no
    // registro público. Só roda com EAS_SENSITIVITY_SCHEMA_UID preenchido:
    // mesmo interruptor-por-omissão do v2 do sinal, então enquanto o schema não
    // for registrado (transação manual, com CONFIRM) nada aqui acontece e nada
    // muda. Falha nunca derruba o gatilho do sinal, que é o principal.
    const sensitivityResults = env.EAS_SENSITIVITY_SCHEMA_UID
      ? await Promise.all(
          (Object.keys(SENSITIVITY_PATHS) as LendingAssetId[]).map((asset) =>
            runSensitivityAttestForAsset(asset, {
              signer,
              schemaUid: env.EAS_SENSITIVITY_SCHEMA_UID as `0x${string}`,
              minGasReserveEth: env.MIN_GAS_RESERVE_ETH,
            }),
          ),
        )
      : [];

    // Vigia da telemetria, de carona no único gatilho diário que já existe
    // (nenhum cron novo). O modo de falha do store é SILENCIOSO por design — a
    // telemetria é best-effort e o produto segue servindo —, então sem esta
    // sonda uma quebra só apareceria quando alguém fosse olhar o número, meses
    // depois. Mesma lição da primeira venda real, que passou dias sem aviso
    // porque o alerta dependia de variável não configurada.
    const storeHealth = await probeUsageStore();

    // Quem me avisa quando quebra? Se algum asset falhou (erro de leitura ou —
    // o caso mais comum e importante — saldo de gas abaixo do piso), ou se o
    // store de uso parou de responder, dispara alerta pro dono. `void`: não
    // bloqueia a resposta ao cron esperando o Telegram, e sendTelegramAlert
    // nunca lança (no-op se não configurado).
    const failures = results.filter((r) => r.error);
    const problems: string[] = failures.map((f) => `• auto-attest ${f.asset}: ${f.error}`);
    for (const s of sensitivityResults.filter((r) => r.error)) {
      problems.push(`• auto-attest sensibilidade ${s.asset}: ${s.error}`);
    }
    if (!storeHealth.ok) {
      problems.push(`• store de uso (${storeHealth.backend ?? "sem backend"}): ${storeHealth.error ?? "indisponível"}`);
    }

    // Folga de gas ANTES de bloquear. O aviso que já existia vinha embutido no
    // erro de cada asset — ou seja, só chegava DEPOIS de a atestação ter sido
    // pulada. Em 2026-08-05 isso custou 11 horas de buraco no histórico por
    // faltar um centavo, e histórico on-chain não se preenche depois.
    // `blocked` já aparece nas falhas acima; aqui o que interessa é o `low`.
    try {
      const runway = await readGasRunway(signer.address, env.MIN_GAS_RESERVE_ETH);
      if (runway.status === "low" && runway.message) {
        problems.push(`• ${runway.message}`);
      }
    } catch (err) {
      // Nunca deixa a sonda de gas derrubar a checagem — o alerta das falhas de
      // atestação, que é o sinal principal, tem que sair de qualquer jeito.
      logger.warn({ err }, "falha lendo folga de gas — checagem diária segue sem esse item");
    }

    // "O código no ar é o mais recente?" — em 2026-08-05 seis dias de commits
    // ficaram sem publicar sem ninguém notar, e em 2026-08-06 dois deploys
    // seguidos foram cancelados por falta de runner. Nos dois casos nada falha
    // visivelmente: o serviço segue respondendo com código antigo.
    const drift = await readDeployDrift();
    if (drift.status === "stale" && drift.message) {
      problems.push(`• ${drift.message}`);
    }
    if (problems.length > 0) {
      void sendTelegramAlert(
        `⚠️ YieldSignal — ${problems.length} problema(s) na checagem diária\n\n${problems.join("\n")}`,
      );
    }
    res.json({ results, sensitivity: sensitivityResults, usageStore: storeHealth });
  });

  // Dashboard de track record — fonte da verdade é o próprio EAS (attestation/
  // trackRecord.ts), sem pagamento e sem banco novo. EAS_SCHEMA_UID vazio
  // degrada pra lista vazia (nada foi atestado ainda), nunca erro 5xx.
  app.get("/track-record.json", async (_req, res) => {
    if (!hasAttestationSchema) {
      res.json({ schemaUid: null, attester: signer.address, entries: [] });
      return;
    }
    try {
      const entries = await buildTrackRecord({ schemaUid: attestSchemaUid, attester: signer.address });
      res.json({ schemaUid: env.EAS_SCHEMA_UID, attester: signer.address, entries });
    } catch (err) {
      logger.error({ err }, "falha montando track record");
      res.status(503).json({ error: "falha temporária consultando o histórico de atestações — tente de novo em instantes" });
    }
  });

  app.get("/track-record", (_req, res) => {
    res.type("html").send(TRACK_RECORD_PAGE_HTML);
  });

  // CAMADA 2: score de acurácia legível por máquina — GRÁTIS de propósito. É
  // o sinal de confiança que faz um robô decidir pagar pelo produto; quanto
  // mais fácil de consultar, mais adoção. Derivado 1:1 do mesmo track record
  // (fonte = EAS, verificável), então não é auto-declarado. EAS_SCHEMA_UID
  // vazio degrada pra score vazio (nada atestado ainda), nunca 5xx.
  app.get("/accuracy.json", async (_req, res) => {
    if (!hasAttestationSchema) {
      res.json({
        schemaUid: null,
        attester: signer.address,
        score: computeAccuracyScore([]),
        windowedScore: computeWindowedAccuracy([]),
      });
      return;
    }
    try {
      // Uma consulta ao EASScan só: o score por janela precisa das atestações
      // CRUAS (ordem/instante), o score direcional precisa das entradas já
      // cruzadas com o mercado atual. Buscar duas vezes seria a mesma resposta
      // paga duas vezes.
      const attestations = await fetchSignalAttestations({
        schemaId: attestSchemaUid,
        alsoSchemaIds: legacySchemaUids,
        attester: signer.address,
      });
      const entries = await buildTrackRecord({
        schemaUid: attestSchemaUid,
        attester: signer.address,
        attestations,
      });
      res.json({
        schemaUid: env.EAS_SCHEMA_UID,
        attester: signer.address,
        score: computeAccuracyScore(entries),
        // Métrica por janela de vigência — ver windowedAccuracy.ts pro porquê
        // de ela ser mais justa que a direccional-contra-mercado-atual, que
        // penaliza duas vezes o ativo mais volátil.
        windowedScore: computeWindowedAccuracy(attestations),
      });
    } catch (err) {
      logger.error({ err }, "falha calculando accuracy score");
      res.status(503).json({ error: "falha temporária consultando o histórico — tente de novo em instantes" });
    }
  });

  // Funil de uso — INTERNO, não é produto. Protegido com o mesmo padrão
  // fail-closed do auto-attest: sem segredo configurado, nega sempre (nunca
  // "aberto por falta de config"). Aceita um segredo próprio
  // (USAGE_READ_SECRET) e, na falta dele, reaproveita CRON_TRIGGER_SECRET, que
  // já existe em produção — assim a instrumentação começa a ser legível sem
  // depender de configurar variável nova.
  //
  // Não é público de propósito: número de chamadas é informação de negócio, e
  // um número baixo exposto num endpoint aberto trabalha contra a adoção que o
  // resto do serviço tenta construir.
  app.get("/usage.json", async (req, res) => {
    const secret = env.USAGE_READ_SECRET || env.CRON_TRIGGER_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const days = Math.min(Math.max(Number(req.query.days ?? 14) || 14, 1), 90);
      const report = await readUsage(days);
      res.json(report);
    } catch (err) {
      logger.error({ err }, "falha lendo relatório de uso");
      res.status(503).json({ error: "falha temporária lendo o relatório de uso" });
    }
  });

  // CAMADA 3: termos da garantia econômica — GRÁTIS, read-only, e HONESTO
  // sobre o status (motor pronto, escrow ainda não deployado). Nenhuma
  // promessa de payout ativa até o bond ser fundeado (ver src/guarantee/).
  app.get("/guarantee/terms.json", (_req, res) => {
    res.json(GUARANTEE_TERMS);
  });

  // Registration file ERC-8004 (ver attestation/erc8004.ts) — estático até o
  // registro on-chain acontecer (npm run register-agent), quando o agentId
  // real é adicionado ao array `registrations` (ver comentário em agentCard.ts).
  /**
   * Lista de rotas pagas para os documentos de descoberta, montada das MESMAS
   * tabelas que registram as rotas de verdade. Uma lista escrita à mão aqui
   * divergiria no primeiro produto novo e passaria a anunciar rota inexistente
   * — pior que não ter documento. Os parâmetros repetem o que já foi declarado
   * ao Bazaar, pelo mesmo motivo: duas descrições da mesma coisa divergem.
   */
  function discoveryRoutes(): DiscoveryRoute[] {
    const p = (name: string, required: boolean, type: "string" | "number", description: string) => ({ name, required, type, description });
    const decisionParams = [
      p("position", false, "string", "Protocol where your capital sits now, or 'idle' if uninvested."),
      p("amountUsd", false, "number", "Position size in USD. Scales the gain and the break-even."),
      p("moveCostUsd", false, "number", "Your estimated cost to move (gas + slippage), in USD."),
      p("horizonDays", false, "number", "Days you expect to hold before re-evaluating."),
    ];
    return [
      ...(Object.keys(RESOURCE_PATHS) as AssetId[]).map((a) => ({
        path: RESOURCE_PATHS[a], description: FINAL_DESCRIPTIONS.signal[a], priceUsd: env.PRICE_USD, params: [],
      })),
      ...(Object.keys(DECISION_PATHS) as AssetId[]).map((a) => ({
        path: DECISION_PATHS[a], description: FINAL_DESCRIPTIONS.decision[a], priceUsd: env.DECISION_PRICE_USD, params: decisionParams,
      })),
      ...(Object.keys(DURABILITY_PATHS) as LendingAssetId[]).map((a) => ({
        path: DURABILITY_PATHS[a], description: FINAL_DESCRIPTIONS.durability[a], priceUsd: env.PRICE_USD, params: [],
      })),
      ...(Object.keys(CAPACITY_PATHS) as LendingAssetId[]).map((a) => ({
        path: CAPACITY_PATHS[a], description: FINAL_DESCRIPTIONS.capacity[a], priceUsd: env.PRICE_USD,
        params: [p("amountUsd", false, "number", "Position size in USD to test for exit. Omit for utilization and free liquidity without a verdict.")],
      })),
      ...(Object.keys(SENSITIVITY_PATHS) as LendingAssetId[]).map((a) => ({
        path: SENSITIVITY_PATHS[a], description: FINAL_DESCRIPTIONS.sensitivity[a], priceUsd: env.PRICE_USD, params: [],
      })),
      ...(Object.keys(EXPOSURE_PATHS) as LendingAssetId[]).map((a) => ({
        path: EXPOSURE_PATHS[a], description: FINAL_DESCRIPTIONS.exposure[a], priceUsd: env.PRICE_USD,
        params: [p("positions", true, "string", "REQUIRED. Positions as comma-separated protocol:usd pairs, e.g. aave:200000,morpho:150000. Known protocols: aave, morpho, compound, moonwell, euler, fluid.")],
      })),
    ];
  }

  /** Base URL a partir do pedido, pra o documento servir igual em local e produção. */
  function baseUrlOf(req: express.Request): string {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? req.protocol;
    return `${proto}://${req.get("host")}`;
  }

  // Documentos de DESCOBERTA — grátis e sem autenticação de propósito: um
  // indexador que precisasse pagar pra saber o que existe nunca listaria nada.
  // Motivo de existirem: a submissão ao x402scan foi recusada em 2026-08-06 com
  // "No discovery document found" — responder 402 não basta, o catálogo precisa
  // da ENUMERAÇÃO das rotas pra saber que são 14 e não 1.
  // Cache longo: o ícone não muda, e um indexador que o busque a cada varredura
  // não deve custar invocação de função toda vez.
  app.get("/favicon.ico", (_req, res) => {
    res.type("image/x-icon").set("Cache-Control", "public, max-age=604800, immutable").send(FAVICON_ICO);
  });

  app.get("/openapi.json", (req, res) => {
    res.json(buildOpenApi(baseUrlOf(req), discoveryRoutes(), server.payToEvmAddress!));
  });

  app.get("/.well-known/x402", (req, res) => {
    res.json(buildWellKnownX402(baseUrlOf(req), discoveryRoutes(), server.payToEvmAddress!));
  });

  app.get("/agent-card.json", (_req, res) => {
    res.type("application/json").send(AGENT_CARD_JSON);
  });

  // /mcp fica de fora do middleware de pagamento do endpoint REST (esse
  // agora é escopado só na rota GET abaixo, não é mais `app.use()` global) —
  // já foi `app.use(RESOURCE_PATH, mw)` antes, mas isso quebrou o próprio
  // casamento de rota do middleware (Express remove o prefixo de `req.url`
  // dentro de middleware montado com caminho, e o x402 usa o path original
  // pra achar a rota configurada) — bug real encontrado testando a tool MCP.
  const mcpHandler = await createMcpRequestHandler(server.payToEvmAddress, signer);
  app.post("/mcp", express.json(), mcpHandler);
  // Sem GET aqui: em modo stateful, GET /mcp abre um stream SSE de servidor
  // pra cliente que fica aberto indefinidamente — não existe cliente
  // esperando push nesse caso de uso (tool avulsa, sem conversa longa), e
  // numa função serverless isso só fica pendurado até o limite de duração
  // (bug real: 5 minutos de timeout na Vercel, visto nos logs de produção).
  app.delete("/mcp", mcpHandler);

  async function respondWithSignal(res: express.Response, asset: AssetId): Promise<void> {
    try {
      const readings = await collectRates(asset);
      const signal = computeSignal(readings);
      // `res.send(raw)` em vez de `res.json(signal)` — precisa ser o MESMO
      // texto que foi assinado abaixo, byte a byte, senão a assinatura não
      // bate na verificação do lado do cliente (res.json re-serializaria com
      // as opções de formatação do Express, que não são garantidas iguais).
      const raw = JSON.stringify(signal);
      const signed = await signPayload(signer, raw, signal);
      if (signed) {
        res.setHeader("X-Signal-Signature", signed.signature);
        res.setHeader("X-Signal-Signer", signed.signer);
        res.setHeader("X-Signal-Eip712-Payload", JSON.stringify(eip712ForTransport(signed.eip712)));
      }
      // Contado só aqui, DEPOIS de tudo que pode falhar (leitura + assinatura):
      // registrar logo após o collectRates contava "served" mesmo quando a
      // assinatura estourava e o comprador levava 503 — o mesmo pedido entrava
      // como served E failed, inflando o topo do funil.
      await recordUsage({ kind: "served", route: "signal", channel: "rest", asset });
      res.type("application/json").send(raw);
    } catch (err) {
      logger.error({ err, asset }, "falha gerando sinal");
      await recordUsage({ kind: "failed", route: "signal", channel: "rest", asset });
      res.status(503).json({ error: "falha temporária lendo taxas — tente de novo em instantes" });
    }
  }

  // CAMADA 1: responde a DECISÃO MOVE/HOLD. Assina o SINAL embutido (mesmo
  // struct EIP-712 dos endpoints de sinal) — como a decisão é uma função
  // determinística do sinal + os query params, o comprador re-executa
  // decideMove localmente com o sinal assinado e obtém a MESMA decisão; então
  // assinar o sinal já torna a decisão verificável, sem struct novo.
  async function respondWithDecision(res: express.Response, asset: AssetId, query: Record<string, unknown>): Promise<void> {
    const parsed = parseDecisionQuery(query);
    if (!parsed.ok) {
      // Erro de parâmetro do comprador — 400, não 5xx. O pagamento x402 já
      // liquidou nesse ponto; um input inválido é responsabilidade do chamador,
      // mas a mensagem é clara pra ele corrigir e chamar de novo.
      //
      // Contado como `failed:...:bad_request` de propósito: sem isso o funil
      // ficaria com um buraco inexplicável (pagou, liquidou, e nunca apareceu
      // served nem failed) — e um comprador que paga e recebe 400 por não saber
      // montar a query é justamente o problema de adoção que vale detectar.
      try {
        await recordUsage({ kind: "failed", route: "decision", channel: "rest", asset, outcome: "bad_request" });
      } catch {
        /* telemetria nunca altera a resposta */
      }
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const readings = await collectRates(asset);
      const decision = decideMove(readings, parsed.input);
      // Assina o sinal embutido (não o corpo inteiro da decisão) — o corpo
      // servido continua sendo a decisão completa; a assinatura cobre o dado
      // de mercado do qual a decisão deriva deterministicamente.
      const rawSignal = JSON.stringify(decision.signal);
      const signed = await signPayload(signer, rawSignal, decision.signal);
      if (signed) {
        res.setHeader("X-Signal-Signature", signed.signature);
        res.setHeader("X-Signal-Signer", signed.signer);
        res.setHeader("X-Signal-Eip712-Payload", JSON.stringify(eip712ForTransport(signed.eip712)));
      }
      await recordUsage({ kind: "served", route: "decision", channel: "rest", asset });
      res.type("application/json").send(JSON.stringify(decision));
    } catch (err) {
      logger.error({ err, asset }, "falha gerando decisão");
      await recordUsage({ kind: "failed", route: "decision", channel: "rest", asset });
      res.status(503).json({ error: "falha temporária lendo taxas — tente de novo em instantes" });
    }
  }

  /**
   * Serve durabilidade e capacidade. As duas compartilham o mesmo esqueleto —
   * coletar leituras uma vez, derivar o relatório, assinar o SINAL embutido —
   * então o esqueleto vive aqui e cada rota só passa a função que deriva.
   *
   * A assinatura cobre o sinal, não o corpo inteiro, pelo MESMO motivo já
   * documentado nas rotas de decisão: o relatório é função determinística das
   * mesmas leituras, então assinar o sinal (que vai embutido no corpo, em
   * `signal`) já deixa o comprador reexecutar a derivação e conferir. Um struct
   * EIP-712 novo por produto exigiria schema novo e não provaria mais nada.
   */
  async function respondWithDerived<T>(
    res: express.Response,
    asset: AssetId,
    route: "durability" | "capacity" | "sensitivity" | "exposure",
    // Aceita derivação assíncrona porque /sensitivity precisa ler a curva de
    // juros on-chain além das taxas — as outras duas continuam síncronas.
    derive: (readings: Awaited<ReturnType<typeof collectRates>>) => T | Promise<T>,
  ): Promise<void> {
    try {
      const readings = await collectRates(asset);
      const signal = computeSignal(readings);
      const rawSignal = JSON.stringify(signal);
      // `signedSignalText` carrega o texto EXATO que foi assinado. Sem ele o
      // verificador teria que re-serializar `body.signal` pra conferir o
      // contentHash — e re-serializar arrisca bytes diferentes dos assinados
      // (ordem de chave, espaçamento), que é a fragilidade que o canal MCP já
      // evita devolvendo o texto verbatim. Sem isto, um cliente que RECUSA
      // resposta não verificada (como o plugin elizaOS) não conseguiria aceitar
      // nenhuma resposta analítica.
      const body = { ...(await derive(readings)), signal, signedSignalText: rawSignal };
      const signed = await signPayload(signer, rawSignal, signal);
      if (signed) {
        res.setHeader("X-Signal-Signature", signed.signature);
        res.setHeader("X-Signal-Signer", signed.signer);
        res.setHeader("X-Signal-Eip712-Payload", JSON.stringify(eip712ForTransport(signed.eip712)));
      }
      await recordUsage({ kind: "served", route, channel: "rest", asset });
      res.type("application/json").send(JSON.stringify(body));
    } catch (err) {
      logger.error({ err, asset, route }, "falha gerando relatório derivado");
      await recordUsage({ kind: "failed", route, channel: "rest", asset });
      res.status(503).json({ error: "falha temporária lendo taxas — tente de novo em instantes" });
    }
  }

  /**
   * `?amountUsd=` da rota de capacidade. Ausente é VÁLIDO (a rota ainda entrega
   * utilização e liquidez livre por protocolo, só não emite veredito de saída);
   * presente e inválido é 400, mesma disciplina de `parseDecisionQuery` — um
   * número que não dá pra confiar não pode virar veredito de "você consegue
   * sacar", que é literalmente a afirmação que esta rota existe pra sustentar.
   */
  function parseAmountUsd(raw: unknown): { ok: true; amountUsd: number | null } | { ok: false; error: string } {
    if (raw === undefined || raw === "") return { ok: true, amountUsd: null };
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: "amountUsd must be a positive number when provided" };
    }
    return { ok: true, amountUsd: n };
  }

  async function respondWithExposure(
    res: express.Response,
    asset: LendingAssetId,
    query: Record<string, unknown>,
  ): Promise<void> {
    const parsed = parsePositions(query.positions);
    if (!parsed.ok) {
      // Mesma razão do 400 na rota de capacidade: o pagamento já liquidou, e
      // input inválido é responsabilidade do chamador — mas a mensagem tem que
      // deixar ele se autocorrigir. Contado como bad_request pra não abrir
      // buraco no funil (pagou, liquidou, e nunca apareceu served nem failed).
      try {
        await recordUsage({ kind: "failed", route: "exposure", channel: "rest", asset, outcome: "bad_request" });
      } catch {
        /* telemetria nunca altera a resposta */
      }
      res.status(400).json({ error: parsed.error });
      return;
    }
    await respondWithDerived(res, asset, "exposure", async () =>
      computeExposure(
        asset,
        parsed.positions,
        await collectExposureFactors(
          asset,
          parsed.positions.map((p) => p.protocol),
        ),
      ),
    );
  }

  async function respondWithCapacity(
    res: express.Response,
    asset: LendingAssetId,
    query: Record<string, unknown>,
  ): Promise<void> {
    const parsed = parseAmountUsd(query.amountUsd);
    if (!parsed.ok) {
      try {
        await recordUsage({ kind: "failed", route: "capacity", channel: "rest", asset, outcome: "bad_request" });
      } catch {
        /* telemetria nunca altera a resposta */
      }
      res.status(400).json({ error: parsed.error });
      return;
    }
    await respondWithDerived(res, asset, "capacity", (readings) =>
      computeCapacity(asset, readings, parsed.amountUsd),
    );
  }

  /**
   * A curva de juros é lida SÓ na rota que a usa, não em `collectRates` — as
   * outras rotas não pagariam por chamadas RPC que não consomem. Lê a curva de
   * exatamente os protocolos que apareceram nas leituras, não de uma lista
   * fixa: se um protocolo foi omitido por falha, não há por que buscar a curva
   * dele.
   */
  async function deriveSensitivity(
    asset: LendingAssetId,
    readings: Awaited<ReturnType<typeof collectRates>>,
  ) {
    const curves = await collectBorrowRateCurves(
      asset,
      readings.map((r) => r.protocol),
    );
    return computeSensitivity(asset, readings, curves);
  }

  // Fato de uso, registrado na entrega. Toda chamada que chega aqui já pagou —
  // não existe mais caminho gratuito (ver a nota sobre a degustação removida
  // logo abaixo), então esta linha e a de liquidação devem bater.
  function logUsage(
    asset: AssetId,
    channel:
      | "rest"
      | "rest-decision"
      | "rest-durability"
      | "rest-capacity"
      | "rest-sensitivity"
      | "rest-exposure" = "rest",
  ): void {
    logger.info({ channel, asset }, "sinal servido");
  }

  /**
   * DEGUSTAÇÃO GRATUITA REMOVIDA EM 2026-08-10 — não reintroduzir sem resolver
   * os três problemas que a tornaram um vazamento aberto, não uma amostra:
   *
   * 1. O opt-in `?trial=1` era ANUNCIADO no `/openapi.json`, e o público que lê
   *    documento de descoberta é exatamente o varredor automático — o mesmo que
   *    a degustação não pretendia servir.
   * 2. A cota era um `Map` em memória por instância serverless: cada cold start
   *    devolvia 3 chamadas novas pro mesmo IP. Não havia teto de verdade.
   * 3. Medido em 09/08/2026: 12 respostas de produto entregues no dia contra
   *    ZERO pagamento on-chain. Na janela inteira do funil foram 125 entregas
   *    para 26 pagamentos na história toda do serviço.
   *
   * O gate de descoberta que motivou o opt-in continua íntegro: uma sonda sem
   * header de pagamento vê 402 (era esse o requisito do x402.fuchss.app), e
   * agora QUALQUER request sem pagamento vê 402 — inclusive com `?trial=1`, que
   * hoje é um parâmetro desconhecido e simplesmente ignorado.
   */
  for (const asset of Object.keys(RESOURCE_PATHS) as AssetId[]) {
    app.get(
      RESOURCE_PATHS[asset],
      // Etapa do funil ANTES de qualquer decisão de pagamento — é o que revela
      // quantos 402 são servidos (sonda de descoberta incluída) versus quantos
      // realmente tentam pagar. Sem isto o projeto só conseguia auditar receita
      // liquidada on-chain e ficava cego sobre demanda.
      usageEntryMiddleware("signal", asset),
      paymentMiddlewareFromHTTPServer(server),
      async (_req, res) => {
        logUsage(asset);
        await respondWithSignal(res, asset);
      },
    );
  }

  // Rotas de DECISÃO (Camada 1) — mesmo padrão de pagamento das rotas de sinal,
  // mas servindo a recomendação MOVE/HOLD. Query params
  // (position/amountUsd/moveCostUsd/horizonDays) são lidos DENTRO do handler.
  for (const asset of Object.keys(DECISION_PATHS) as AssetId[]) {
    app.get(
      DECISION_PATHS[asset],
      usageEntryMiddleware("decision", asset),
      paymentMiddlewareFromHTTPServer(server),
      async (req, res) => {
        logUsage(asset, "rest-decision");
        await respondWithDecision(res, asset, req.query as Record<string, unknown>);
      },
    );
  }

  // Rotas de DURABILIDADE e CAPACIDADE — mesmo padrão de pagamento das rotas
  // acima. Registradas em loops separados porque CAPACITY_PATHS é indexado por
  // LendingAssetId (não tem ETH_STAKING — ver a nota na constante).
  for (const asset of Object.keys(DURABILITY_PATHS) as LendingAssetId[]) {
    app.get(
      DURABILITY_PATHS[asset],
      usageEntryMiddleware("durability", asset),
      paymentMiddlewareFromHTTPServer(server),
      async (_req, res) => {
        logUsage(asset, "rest-durability");
        await respondWithDerived(res, asset, "durability", (readings) => computeDurability(asset, readings));
      },
    );
  }

  for (const asset of Object.keys(EXPOSURE_PATHS) as LendingAssetId[]) {
    app.get(
      EXPOSURE_PATHS[asset],
      usageEntryMiddleware("exposure", asset),
      paymentMiddlewareFromHTTPServer(server),
      async (req, res) => {
        logUsage(asset, "rest-exposure");
        await respondWithExposure(res, asset, req.query as Record<string, unknown>);
      },
    );
  }

  for (const asset of Object.keys(SENSITIVITY_PATHS) as LendingAssetId[]) {
    app.get(
      SENSITIVITY_PATHS[asset],
      usageEntryMiddleware("sensitivity", asset),
      paymentMiddlewareFromHTTPServer(server),
      async (_req, res) => {
        logUsage(asset, "rest-sensitivity");
        await respondWithDerived(res, asset, "sensitivity", (readings) => deriveSensitivity(asset, readings));
      },
    );
  }

  for (const asset of Object.keys(CAPACITY_PATHS) as LendingAssetId[]) {
    app.get(
      CAPACITY_PATHS[asset],
      usageEntryMiddleware("capacity", asset),
      paymentMiddlewareFromHTTPServer(server),
      async (req, res) => {
        logUsage(asset, "rest-capacity");
        await respondWithCapacity(res, asset, req.query as Record<string, unknown>);
      },
    );
  }

  // Aliases curtos → caminho canônico. Um comprador (humano ou agente) que
  // adivinha o óbvio `/decision/usdc` em vez de `/decision/usdc-base-yield`
  // recebia um 404 mudo; agora é redirecionado (308 preserva método e query)
  // pra rota canônica, onde o desafio x402 dispara normalmente e o pagamento
  // liquida contra o path certo. São paths distintos dos canônicos, então não
  // há shadow do middleware de pagamento registrado acima.
  // Tabela em escopo de módulo (exportada) — ver PAID_PATHS/SHORT_ALIASES no topo.
  for (const [alias, canonical] of Object.entries(SHORT_ALIASES)) {
    app.get(alias, (req, res) => {
      const qIndex = req.originalUrl.indexOf("?");
      const query = qIndex >= 0 ? req.originalUrl.slice(qIndex) : "";
      res.redirect(308, canonical + query);
    });
  }

  // 404 legível por máquina — em vez do "Cannot GET /x" cru do Express, uma
  // rota inexistente devolve JSON com o mapa de endpoints válidos. Fecha o
  // "falso 404" de vez: quem erra o caminho recebe o guia pra se autocorrigir,
  // não um beco sem saída. Registrado por último, depois de todas as rotas
  // reais e dos aliases, pra só pegar o que sobrou.
  app.use(async (req, res) => {
    // Conta caminho errado: se este número for alto perto de `challenged`, o
    // problema de adoção é de descoberta/documentação, não de preço.
    //
    // E conta QUAL caminho. A primeira leitura do funil (30/07) mostrou 395
    // `not_found` contra 456 `challenged` — quase metade do tráfego não achou a
    // porta — e o número era inacionável, porque ninguém registrava o que estava
    // sendo tentado. "Agente errando o path do produto" e "scanner procurando
    // /wp-admin" dão o mesmo contador e pedem reações opostas: a primeira é
    // alias que falta, a segunda é ruído a ignorar.
    try {
      await recordUsage({ kind: "not_found", channel: "rest", asset: notFoundLabel(req.path) });
    } catch {
      // Nunca deixa a telemetria transformar um 404 em processo derrubado.
    }
    res.status(404).json({
      error: "route not found",
      path: req.path,
      endpoints: {
        signal: Object.values(RESOURCE_PATHS),
        decision: Object.values(DECISION_PATHS),
        durability: Object.values(DURABILITY_PATHS),
        capacity: Object.values(CAPACITY_PATHS),
        sensitivity: Object.values(SENSITIVITY_PATHS),
        exposure: Object.values(EXPOSURE_PATHS),
        free: [
          "/accuracy.json",
          "/track-record.json",
          "/guarantee/terms.json",
          "/agent-card.json",
          "/health",
        ],
        mcp: "/mcp",
        aliases:
          `short forms like /signal/usdc and /decision/usdc redirect (308) to the canonical paths; bare /signal and /decision redirect to the ${FLAGSHIP_ASSET} route (the asset with the strongest verified track record — see /accuracy.json)`,
      },
    });
  });

  return { app, payToEvmAddress: server.payToEvmAddress };
}
