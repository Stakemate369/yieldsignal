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
import { createMcpRequestHandler } from "./mcp.js";
import { consumeFreeTrial } from "./freeTrial.js";
import { logger } from "./notify/logger.js";

export const RESOURCE_PATH = "/signal/usdc-base-yield";

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
      [`GET ${RESOURCE_PATH}`]: {
        price: env.PRICE_USD,
        description:
          "Real-time risk-weighted USDC lending APY across Aave, Compound, Morpho, Moonwell, Euler and Fluid on Base — every reading tagged with its data source (onchain/api/defillama) and timestamp.",
      },
    },
  });

  // Trava o endereço receptor ANTES de aceitar qualquer request real — lição
  // aplicada de forma proativa (ver wallet/walletLock.ts). payToEvmAddress só
  // é undefined se nenhuma rota EIP-155 foi provisionada, o que não é o caso
  // aqui (rota única, redes default incluem eip155:8453/84532).
  if (!server.payToEvmAddress) {
    throw new Error("createX402Server não provisionou uma carteira EVM — não é seguro aceitar pagamentos assim.");
  }
  assertWalletAddress(env.X402_ENVIRONMENT, server.payToEvmAddress, env.EXPECTED_WALLET_ADDRESS);

  const app = express();
  // Vercel/qualquer proxy reverso: sem isso, req.ip sempre retorna o IP do
  // proxy, não do chamador real — quebraria a cota gratuita por IP abaixo.
  app.set("trust proxy", true);

  // /mcp fica de fora do middleware de pagamento do endpoint REST (esse
  // agora é escopado só na rota GET abaixo, não é mais `app.use()` global) —
  // já foi `app.use(RESOURCE_PATH, mw)` antes, mas isso quebrou o próprio
  // casamento de rota do middleware (Express remove o prefixo de `req.url`
  // dentro de middleware montado com caminho, e o x402 usa o path original
  // pra achar a rota configurada) — bug real encontrado testando a tool MCP.
  const mcpHandler = await createMcpRequestHandler(server.payToEvmAddress);
  app.post("/mcp", express.json(), mcpHandler);
  app.get("/mcp", mcpHandler);
  app.delete("/mcp", mcpHandler);

  async function respondWithSignal(res: express.Response): Promise<void> {
    try {
      const readings = await collectRates();
      const signal = computeSignal(readings);
      res.json(signal);
    } catch (err) {
      logger.error({ err }, "falha gerando sinal");
      res.status(503).json({ error: "falha temporária lendo taxas — tente de novo em instantes" });
    }
  }

  app.get(
    RESOURCE_PATH,
    // Cota gratuita de degustação: se sobrar cota pra esse IP hoje, responde
    // direto e NUNCA chama next() — o middleware de pagamento a seguir nem
    // vê essa requisição. Esgotada a cota, cai pro fluxo pago normal.
    (req, res, next) => {
      const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
      if (consumeFreeTrial(ip)) {
        res.setHeader("X-Free-Trial", "true");
        void respondWithSignal(res);
        return;
      }
      next();
    },
    paymentMiddlewareFromHTTPServer(server),
    async (_req, res) => {
      await respondWithSignal(res);
    },
  );

  return { app, payToEvmAddress: server.payToEvmAddress };
}
