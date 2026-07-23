import express from "express";
// ATENÇÃO: import a confirmar na prática assim que houver credenciais CDP
// reais pra testar (ver plano — item de verificação em runtime). A forma
// exata de `createX402Server`/`paymentMiddlewareFromHTTPServer` vem da
// documentação oficial da CDP (docs.cdp.coinbase.com/x402/quickstart-for-sellers)
// consultada em 2026-07-16; se o pacote instalado expuser uma API um pouco
// diferente, ajustar aqui é o primeiro lugar a olhar.
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { loadEnv } from "./config/env.js";
import { X402_RECEIVER_ACCOUNT_NAME } from "./config/networks.js";
import { assertWalletAddress } from "./wallet/walletLock.js";
import { collectRates } from "./signal/collectRates.js";
import { computeSignal } from "./signal/computeSignal.js";
import { decideMove } from "./signal/decideMove.js";
import { parseDecisionQuery } from "./signal/parseDecisionQuery.js";
import { computeAccuracyScore } from "./attestation/accuracyScore.js";
import { GUARANTEE_TERMS } from "./guarantee/terms.js";
import type { AssetId } from "./market-data/types.js";
import { createMcpRequestHandler } from "./mcp.js";
import { consumeFreeTrial } from "./freeTrial.js";
import { LANDING_PAGE_HTML } from "./landingPage.js";
import { logger } from "./notify/logger.js";
import { logSettledPayment } from "./notify/paymentLog.js";
import { sendTelegramAlert } from "./notify/telegram.js";
import { getSignerAccount } from "./wallet/signerAccount.js";
import { signPayload, eip712ForTransport } from "./signal/signResponse.js";
import { runAutoAttestForAsset } from "./attestation/autoAttest.js";
import { buildTrackRecord } from "./attestation/trackRecord.js";
import { TRACK_RECORD_PAGE_HTML } from "./trackRecordPage.js";
import { AGENT_CARD_JSON } from "./agentCard.js";

// Um path por ativo vendido — cada um é uma rota x402 protegida separada,
// mesmo preço/descrição-base, preço e descrição próprios só pra deixar claro
// no 402 qual sinal está sendo cobrado.
export const RESOURCE_PATHS: Record<AssetId, string> = {
  USDC: "/signal/usdc-base-yield",
  WETH: "/signal/weth-base-yield",
  ETH_STAKING: "/signal/eth-staking-yield",
};

// Mantido pra quem ainda referencia o path original diretamente (scripts de
// teste manual) — sempre igual a RESOURCE_PATHS.USDC, nunca diverge.
export const RESOURCE_PATH = RESOURCE_PATHS.USDC;

// CAMADA 1 (premium): rotas de DECISÃO — pagas e assinadas como os sinais,
// mas vendem a recomendação MOVE/HOLD (com break-even e confiança), não o
// dado bruto. Um path por ativo, separado das rotas de sinal acima.
export const DECISION_PATHS: Record<AssetId, string> = {
  USDC: "/decision/usdc-base-yield",
  WETH: "/decision/weth-base-yield",
  ETH_STAKING: "/decision/eth-staking-yield",
};

const DECISION_DESCRIPTIONS: Record<AssetId, string> = {
  USDC: "Buyer-side MOVE/HOLD decision for USDC lending on Base: given your current position (?position=), size (?amountUsd=), move cost (?moveCostUsd=) and horizon (?horizonDays=), returns whether moving to the best risk-adjusted protocol pays for itself — with expected net gain, break-even days and a confidence tier. Deterministic from the underlying signal (which is EIP-712 signed in the response headers, re-verifiable). Sells the decision, not the raw datapoint.",
  WETH: "Buyer-side MOVE/HOLD decision for WETH lending on Base — same contract as the USDC decision route, for WETH.",
  ETH_STAKING: "Buyer-side MOVE/HOLD decision for ETH liquid staking (Ethereum mainnet) — same contract as the lending decision routes, for ETH staking.",
};

const ROUTE_DESCRIPTIONS: Record<AssetId, string> = {
  USDC: "Real-time risk-weighted USDC lending APY on Base: Aave/Compound/Morpho read onchain, Moonwell/Euler/Fluid via DefiLlama, source tagged per reading (never estimated). Response signed (EIP-712 typed data) by the payment-receiving address — verify via X-Signal-Signature/X-Signal-Signer/X-Signal-Eip712-Payload headers. Same address holds an ERC-8004 agent identity and periodically attests readings on-chain (EAS, Base mainnet) — see /agent-card.json and /track-record.",
  WETH: "Real-time risk-weighted WETH lending APY on Base: Aave/Compound/Morpho read onchain, Moonwell/Euler/Fluid via DefiLlama, source tagged per reading (never estimated). Response signed (EIP-712 typed data) by the payment-receiving address — verify via X-Signal-Signature/X-Signal-Signer/X-Signal-Eip712-Payload headers. Same address holds an ERC-8004 agent identity and periodically attests readings on-chain (EAS, Base mainnet) — see /agent-card.json and /track-record.",
  ETH_STAKING: "Real-time risk-weighted ETH liquid staking APY on Ethereum mainnet: Lido/Rocket Pool/Coinbase Wrapped Staked ETH/Frax Ether/Binance Staked ETH, all via DefiLlama (source tagged per reading, never estimated). Different chain and category from the USDC/WETH lending signals above — this is staking yield, not a Base lending market. Response signed (EIP-712 typed data) by the payment-receiving address — verify via X-Signal-Signature/X-Signal-Signer/X-Signal-Eip712-Payload headers. Same address holds an ERC-8004 agent identity and periodically attests readings on-chain (EAS, Base mainnet) — see /agent-card.json and /track-record.",
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
        { price: env.PRICE_USD, description: ROUTE_DESCRIPTIONS[asset] },
      ]),
      // Rotas de decisão (Camada 1) — preço PREMIUM (DECISION_PRICE_USD, default
      // $0.05 vs $0.01 do sinal cru): a decisão MOVE/HOLD vale mais que o dado
      // que a DefiLlama dá de graça, e o preço sinaliza isso ao robô-comprador.
      // Mesma fonte de preço usada pela tool MCP get_yield_decision.
      ...(Object.keys(DECISION_PATHS) as AssetId[]).map((asset) => [
        `GET ${DECISION_PATHS[asset]}`,
        { price: env.DECISION_PRICE_USD, description: DECISION_DESCRIPTIONS[asset] },
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
  });

  const app = express();
  // Vercel/qualquer proxy reverso: sem isso, req.ip sempre retorna o IP do
  // proxy, não do chamador real — quebraria a cota gratuita por IP abaixo.
  app.set("trust proxy", true);

  app.get("/", (_req, res) => {
    res.type("html").send(LANDING_PAGE_HTML);
  });

  // Liveness barato pra monitoramento externo (cron-job.org) — sem pagamento
  // e sem consumir cota de free trial do produto real.
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
    if (env.X402_ENVIRONMENT !== "production" || !env.EAS_SCHEMA_UID) {
      res.status(400).json({ error: "auto-attest exige X402_ENVIRONMENT=production e EAS_SCHEMA_UID configurado" });
      return;
    }
    const results = await Promise.all(
      (Object.keys(RESOURCE_PATHS) as AssetId[]).map((asset) =>
        runAutoAttestForAsset(asset, {
          signer,
          schemaUid: env.EAS_SCHEMA_UID as `0x${string}`,
          minGasReserveEth: env.MIN_GAS_RESERVE_ETH,
        }),
      ),
    );
    // Quem me avisa quando quebra? Se algum asset falhou (erro de leitura ou —
    // o caso mais comum e importante — saldo de gas abaixo do piso), dispara
    // alerta pro dono. `void`: não bloqueia a resposta ao cron esperando o
    // Telegram, e sendTelegramAlert nunca lança (no-op se não configurado).
    const failures = results.filter((r) => r.error);
    if (failures.length > 0) {
      const lines = failures.map((f) => `• ${f.asset}: ${f.error}`).join("\n");
      void sendTelegramAlert(`⚠️ YieldSignal — auto-attest falhou em ${failures.length} asset(s)\n\n${lines}`);
    }
    res.json({ results });
  });

  // Dashboard de track record — fonte da verdade é o próprio EAS (attestation/
  // trackRecord.ts), sem pagamento e sem banco novo. EAS_SCHEMA_UID vazio
  // degrada pra lista vazia (nada foi atestado ainda), nunca erro 5xx.
  app.get("/track-record.json", async (_req, res) => {
    if (!env.EAS_SCHEMA_UID) {
      res.json({ schemaUid: null, attester: signer.address, entries: [] });
      return;
    }
    try {
      const entries = await buildTrackRecord({ schemaUid: env.EAS_SCHEMA_UID as `0x${string}`, attester: signer.address });
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
    if (!env.EAS_SCHEMA_UID) {
      res.json({ schemaUid: null, attester: signer.address, score: computeAccuracyScore([]) });
      return;
    }
    try {
      const entries = await buildTrackRecord({ schemaUid: env.EAS_SCHEMA_UID as `0x${string}`, attester: signer.address });
      res.json({ schemaUid: env.EAS_SCHEMA_UID, attester: signer.address, score: computeAccuracyScore(entries) });
    } catch (err) {
      logger.error({ err }, "falha calculando accuracy score");
      res.status(503).json({ error: "falha temporária consultando o histórico — tente de novo em instantes" });
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
      res.type("application/json").send(raw);
    } catch (err) {
      logger.error({ err, asset }, "falha gerando sinal");
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
      res.type("application/json").send(JSON.stringify(decision));
    } catch (err) {
      logger.error({ err, asset }, "falha gerando decisão");
      res.status(503).json({ error: "falha temporária lendo taxas — tente de novo em instantes" });
    }
  }

  // Fato de uso — cobre TAMBÉM as chamadas grátis, que o hook de settlement
  // (acima) nunca vê. É essa linha, não a de pagamento, que responde "isso
  // está sendo usado?" antes mesmo de dar receita.
  function logUsage(asset: AssetId, freeTrial: boolean, channel: "rest" | "rest-decision" = "rest"): void {
    logger.info({ channel, asset, freeTrial }, "sinal servido");
  }

  for (const asset of Object.keys(RESOURCE_PATHS) as AssetId[]) {
    app.get(
      RESOURCE_PATHS[asset],
      // Cota gratuita de degustação, só sob opt-in explícito (?trial=1) — uma
      // sonda de descoberta (x402scan, Bazaar, trust indexes) bate na URL sem
      // esse parâmetro e precisa ver 402 na resposta pra classificar isso como
      // endpoint x402; se o trial fosse concedido automaticamente na primeira
      // request de qualquer IP novo (como era antes), a sonda via 200 e o
      // serviço nunca aparecia em nenhum diretório (bug real, achado testando
      // submissão no x402.fuchss.app — 2026-07-17).
      (req, res, next) => {
        if (req.query.trial !== "1") {
          next();
          return;
        }
        const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
        if (consumeFreeTrial(ip)) {
          res.setHeader("X-Free-Trial", "true");
          logUsage(asset, true);
          void respondWithSignal(res, asset);
          return;
        }
        next();
      },
      paymentMiddlewareFromHTTPServer(server),
      async (_req, res) => {
        logUsage(asset, false);
        await respondWithSignal(res, asset);
      },
    );
  }

  // Rotas de DECISÃO (Camada 1) — mesmo padrão free-trial + pagamento das
  // rotas de sinal, mas servindo a recomendação MOVE/HOLD. Query params
  // (position/amountUsd/moveCostUsd/horizonDays) são lidos DENTRO do handler.
  for (const asset of Object.keys(DECISION_PATHS) as AssetId[]) {
    app.get(
      DECISION_PATHS[asset],
      (req, res, next) => {
        if (req.query.trial !== "1") {
          next();
          return;
        }
        const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
        if (consumeFreeTrial(ip)) {
          res.setHeader("X-Free-Trial", "true");
          logUsage(asset, true, "rest-decision");
          void respondWithDecision(res, asset, req.query as Record<string, unknown>);
          return;
        }
        next();
      },
      paymentMiddlewareFromHTTPServer(server),
      async (req, res) => {
        logUsage(asset, false, "rest-decision");
        await respondWithDecision(res, asset, req.query as Record<string, unknown>);
      },
    );
  }

  // Aliases curtos → caminho canônico. Um comprador (humano ou agente) que
  // adivinha o óbvio `/decision/usdc` em vez de `/decision/usdc-base-yield`
  // recebia um 404 mudo; agora é redirecionado (308 preserva método e query)
  // pra rota canônica, onde o desafio x402 dispara normalmente e o pagamento
  // liquida contra o path certo. São paths distintos dos canônicos, então não
  // há shadow do middleware de pagamento registrado acima.
  const SHORT_ALIASES: Record<string, string> = {
    "/signal/usdc": RESOURCE_PATHS.USDC,
    "/signal/weth": RESOURCE_PATHS.WETH,
    "/signal/eth-staking": RESOURCE_PATHS.ETH_STAKING,
    "/decision/usdc": DECISION_PATHS.USDC,
    "/decision/weth": DECISION_PATHS.WETH,
    "/decision/eth-staking": DECISION_PATHS.ETH_STAKING,
  };
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
  app.use((req, res) => {
    res.status(404).json({
      error: "route not found",
      path: req.path,
      endpoints: {
        signal: Object.values(RESOURCE_PATHS),
        decision: Object.values(DECISION_PATHS),
        free: [
          "/accuracy.json",
          "/track-record.json",
          "/guarantee/terms.json",
          "/agent-card.json",
          "/health",
        ],
        mcp: "/mcp",
        aliases:
          "short forms like /signal/usdc and /decision/usdc redirect (308) to the canonical *-base-yield paths",
      },
    });
  });

  return { app, payToEvmAddress: server.payToEvmAddress };
}
