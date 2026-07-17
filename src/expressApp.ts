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
import type { AssetId } from "./market-data/types.js";
import { createMcpRequestHandler } from "./mcp.js";
import { consumeFreeTrial } from "./freeTrial.js";
import { LANDING_PAGE_HTML } from "./landingPage.js";
import { logger } from "./notify/logger.js";
import { logSettledPayment } from "./notify/paymentLog.js";

// Um path por ativo vendido — cada um é uma rota x402 protegida separada,
// mesmo preço/descrição-base, preço e descrição próprios só pra deixar claro
// no 402 qual sinal está sendo cobrado.
export const RESOURCE_PATHS: Record<AssetId, string> = {
  USDC: "/signal/usdc-base-yield",
  WETH: "/signal/weth-base-yield",
};

// Mantido pra quem ainda referencia o path original diretamente (scripts de
// teste manual) — sempre igual a RESOURCE_PATHS.USDC, nunca diverge.
export const RESOURCE_PATH = RESOURCE_PATHS.USDC;

const ROUTE_DESCRIPTIONS: Record<AssetId, string> = {
  USDC: "Real-time risk-weighted USDC lending APY across Aave, Compound, Morpho, Moonwell, Euler and Fluid on Base — every reading tagged with its data source (onchain/api/defillama) and timestamp.",
  WETH: "Real-time risk-weighted WETH lending APY across Aave, Compound, Morpho, Moonwell, Euler and Fluid on Base — every reading tagged with its data source (onchain/api/defillama) and timestamp.",
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
    routes: {
      [`GET ${RESOURCE_PATHS.USDC}`]: { price: env.PRICE_USD, description: ROUTE_DESCRIPTIONS.USDC },
      [`GET ${RESOURCE_PATHS.WETH}`]: { price: env.PRICE_USD, description: ROUTE_DESCRIPTIONS.WETH },
    },
  });

  // Trava o endereço receptor ANTES de aceitar qualquer request real — lição
  // aplicada de forma proativa (ver wallet/walletLock.ts). payToEvmAddress só
  // é undefined se nenhuma rota EIP-155 foi provisionada, o que não é o caso
  // aqui (redes default incluem eip155:8453/84532 pras duas rotas).
  if (!server.payToEvmAddress) {
    throw new Error("createX402Server não provisionou uma carteira EVM — não é seguro aceitar pagamentos assim.");
  }
  assertWalletAddress(env.X402_ENVIRONMENT, server.payToEvmAddress, env.EXPECTED_WALLET_ADDRESS);

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

  // /mcp fica de fora do middleware de pagamento do endpoint REST (esse
  // agora é escopado só na rota GET abaixo, não é mais `app.use()` global) —
  // já foi `app.use(RESOURCE_PATH, mw)` antes, mas isso quebrou o próprio
  // casamento de rota do middleware (Express remove o prefixo de `req.url`
  // dentro de middleware montado com caminho, e o x402 usa o path original
  // pra achar a rota configurada) — bug real encontrado testando a tool MCP.
  const mcpHandler = await createMcpRequestHandler(server.payToEvmAddress);
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
      res.json(signal);
    } catch (err) {
      logger.error({ err, asset }, "falha gerando sinal");
      res.status(503).json({ error: "falha temporária lendo taxas — tente de novo em instantes" });
    }
  }

  // Fato de uso — cobre TAMBÉM as chamadas grátis, que o hook de settlement
  // (acima) nunca vê. É essa linha, não a de pagamento, que responde "isso
  // está sendo usado?" antes mesmo de dar receita.
  function logUsage(asset: AssetId, freeTrial: boolean): void {
    logger.info({ channel: "rest", asset, freeTrial }, "sinal servido");
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

  return { app, payToEvmAddress: server.payToEvmAddress };
}
