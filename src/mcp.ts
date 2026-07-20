import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { x402ResourceServer } from "@x402/mcp";
import { createPaymentWrapper } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import type { Request, Response } from "express";
import { z } from "zod";
import { loadEnv } from "./config/env.js";
import { collectRates } from "./signal/collectRates.js";
import { computeSignal } from "./signal/computeSignal.js";
import { logger } from "./notify/logger.js";
import { logSettledPayment } from "./notify/paymentLog.js";
import type { SignerAccount } from "./wallet/signerAccount.js";
import { signPayload, eip712ForTransport } from "./signal/signResponse.js";

const TOOL_DESCRIPTION =
  "Real-time risk-weighted USDC or WETH lending APY on Base: Aave/Compound/Morpho read onchain, Moonwell/Euler/Fluid via DefiLlama, source tagged per reading (never estimated). Result is signed (EIP-712 typed data) by the payment-receiving address, returned as a sibling content block for offline verification. That same address is registered on-chain as an ERC-8004 agent identity (agent-card.json) and periodically publishes EAS attestations of past readings (Base mainnet) — a public track record independent of this server's uptime.";

const TOOL_INPUT_SHAPE = {
  asset: z.enum(["USDC", "WETH"]).optional().describe("Which asset's lending yield to compare. Defaults to USDC."),
};

/**
 * Expõe o mesmo sinal vendido em `/signal/usdc-base-yield` como uma tool MCP
 * paga — a maioria dos frameworks de agente autônomo descobre/integra
 * ferramentas via MCP, não escrevendo cliente x402 HTTP do zero. Usa o
 * pacote oficial `@x402/mcp` (mesmo publisher de `@x402/core`/`@x402/express`,
 * mesma versão 2.18.0 — sem risco de dual package hazard) em vez de tentar
 * encaixar o middleware Express de rota inteira (`paymentMiddlewareFromHTTPServer`)
 * aqui: esse middleware paga por ROTA HTTP inteira, o que bloquearia até
 * `tools/list`/`initialize` do protocolo MCP — `createPaymentWrapper` cobra
 * só a chamada da tool específica, deixando o handshake do protocolo livre.
 *
 * Reaproveita o MESMO facilitator CDP (`createCdpFacilitatorClient`) e o
 * MESMO endereço receptor (`payToEvmAddress`, resolvido uma vez em
 * `createApp()`) que o endpoint REST — uma só carteira, dois jeitos de pagar.
 */
export async function createMcpRequestHandler(
  payToEvmAddress: string,
  signer: SignerAccount,
): Promise<(req: Request, res: Response) => Promise<void>> {
  const env = loadEnv();
  const network = env.X402_ENVIRONMENT === "production" ? "eip155:8453" : "eip155:84532";

  const facilitatorClient = createCdpFacilitatorClient({
    apiKeyId: env.CDP_API_KEY_ID,
    apiKeySecret: env.CDP_API_KEY_SECRET,
  });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(network, new ExactEvmScheme());
  await resourceServer.initialize();

  const accepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network,
    payTo: payToEvmAddress,
    price: env.PRICE_USD,
  });

  const paid = createPaymentWrapper(resourceServer, { accepts });

  // Fato de pagamento — resourceServer daqui é uma instância PRÓPRIA do
  // canal MCP (não a do endpoint REST, ver expressApp.ts), por isso o
  // registro é feito aqui também, com channel fixo em "mcp".
  resourceServer.onAfterSettle(async (context) => {
    logSettledPayment(context, "mcp");
  });

  const mcpServer = new McpServer({ name: "yieldsignal", version: "1.0.0" });

  mcpServer.tool(
    "get_yield_signal",
    TOOL_DESCRIPTION,
    TOOL_INPUT_SHAPE,
    paid(async ({ asset = "USDC" }) => {
      try {
        // Fato de uso — a tool paga só é chamada depois que `paid()` já
        // aprovou o pagamento, então toda chamada aqui é paga (ao contrário
        // do REST, o MCP não tem free trial).
        logger.info({ channel: "mcp", asset }, "sinal servido");
        const readings = await collectRates(asset);
        const signal = computeSignal(readings);
        // Bloco de texto original SEM alteração (é o que fica assinado) +
        // bloco irmão com a assinatura — nunca embutir a assinatura DENTRO do
        // mesmo objeto: obrigaria o cliente a re-serializar de volta pro
        // texto exato assinado, frágil (ordem de chave, espaçamento).
        const raw = JSON.stringify(signal);
        const signed = await signPayload(signer, raw, signal);
        const content = [{ type: "text" as const, text: raw }];
        if (signed) {
          content.push({
            type: "text" as const,
            text: JSON.stringify({
              verification:
                "EIP-712 typed data signature (see eip712.domain/types/message) — eip712.message.contentHash is keccak256 of the previous content block's text, verbatim",
              signature: signed.signature,
              signer: signed.signer,
              eip712: eip712ForTransport(signed.eip712),
            }),
          });
        }
        return { content };
      } catch (err) {
        logger.error({ err, asset }, "falha gerando sinal (MCP)");
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "falha temporária lendo taxas" }) }],
          isError: true,
        };
      }
    }),
  );

  // Modo stateful (com sessionIdGenerator) — modo "stateless" (undefined)
  // testado primeiro e descartado: o SDK responde 500 pra notificação
  // `notifications/initialized` (enviada automaticamente pelo cliente logo
  // após `initialize`) quando não há sessão, bug real reproduzido isolando
  // camada por camada. Efeito colateral aceito em produção serverless: a
  // sessão fica em memória só na instância "quente" que a criou — mesma
  // categoria de limitação que já aceitamos pro cache de `appPromise` em
  // api/index.ts. Se um cliente real cair numa instância fria entre
  // `initialize` e `tools/call`, a sessão não é encontrada (404) e ele
  // precisa reconectar. Não crítico pro caso de uso (chamada avulsa, sem
  // conversa longa), mas documentado aqui pra não ser surpresa depois.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcpServer.connect(transport);

  return async (req: Request, res: Response) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, "falha no handler MCP");
      if (!res.headersSent) {
        res.status(500).json({ error: "falha interna no servidor MCP" });
      }
    }
  };
}
