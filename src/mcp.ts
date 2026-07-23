import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { x402ResourceServer } from "@x402/mcp";
import { createPaymentWrapper } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import type { Request, Response } from "express";
import { z } from "zod";
import { loadEnv } from "./config/env.js";
import { collectRates } from "./signal/collectRates.js";
import { computeSignal } from "./signal/computeSignal.js";
import { decideMove } from "./signal/decideMove.js";
import { parseDecisionQuery } from "./signal/parseDecisionQuery.js";
import { ASSET_IDS } from "./market-data/types.js";
import { logger } from "./notify/logger.js";
import { logSettledPayment } from "./notify/paymentLog.js";
import type { SignerAccount } from "./wallet/signerAccount.js";
import { signPayload, eip712ForTransport } from "./signal/signResponse.js";

const TOOL_DESCRIPTION =
  "Real-time risk-weighted yield signal. USDC/WETH: lending APY on Base (Aave/Compound/Morpho read onchain, Moonwell/Euler/Fluid via DefiLlama). ETH_STAKING: liquid staking APY on Ethereum mainnet (Lido/Rocket Pool/Coinbase Wrapped Staked ETH/Frax Ether/Binance Staked ETH, all via DefiLlama) — a different chain and category from the lending signals, not a Base lending market. Source tagged per reading (never estimated). Result is signed (EIP-712 typed data) by the payment-receiving address, returned as a sibling content block for offline verification. That same address is registered on-chain as an ERC-8004 agent identity (agent-card.json) and periodically publishes EAS attestations of past readings (Base mainnet) — a public track record independent of this server's uptime.";

const DECISION_TOOL_DESCRIPTION =
  "Buyer-side MOVE/HOLD decision (Layer 1 premium — sells the decision, not the raw datapoint). Given your current position, size, move cost and horizon, returns whether moving your capital to the best risk-adjusted protocol pays for itself now — with expected net gain, break-even days and a confidence tier. Deterministic from the underlying signal, which is EIP-712 signed and returned in a sibling content block (re-run the decision locally to reproduce it). Priced above the plain signal tool.";

const TOOL_INPUT_SHAPE = {
  asset: z
    .enum(ASSET_IDS)
    .optional()
    .describe("Which yield signal to fetch: USDC/WETH lending APY on Base, or ETH_STAKING liquid staking APY on Ethereum mainnet. Defaults to USDC."),
};

const DECISION_INPUT_SHAPE = {
  asset: z
    .enum(ASSET_IDS)
    .optional()
    .describe("Which market the decision is for: USDC/WETH lending on Base, or ETH_STAKING liquid staking on Ethereum mainnet. Defaults to USDC."),
  position: z
    .string()
    .optional()
    .describe("Protocol where your capital sits now (aave/morpho/compound/moonwell/euler/fluid/lido/rocket-pool/coinbase-wrapped-staked-eth/frax-ether/binance-staked-eth). Omit or use 'idle' if uninvested."),
  amountUsd: z.number().optional().describe("Position size in USD. Scales the absolute gain and break-even. Defaults to 1000."),
  moveCostUsd: z.number().optional().describe("Your estimated cost to move (gas + slippage) in USD. Defaults to 0.5."),
  horizonDays: z.number().optional().describe("How many days you expect to hold before re-evaluating. Gain only counts up to here. Defaults to 30."),
};

/**
 * Expõe o mesmo sinal vendido em `/signal/usdc-base-yield` (e a decisão de
 * `/decision/*`) como tools MCP pagas — a maioria dos frameworks de agente
 * autônomo descobre/integra ferramentas via MCP, não escrevendo cliente x402
 * HTTP do zero. Usa o pacote oficial `@x402/mcp` (mesmo publisher de
 * `@x402/core`/`@x402/express`, sem risco de dual package hazard) em vez de
 * encaixar o middleware Express de rota inteira: aquele cobra por ROTA HTTP,
 * bloqueando até `tools/list`/`initialize`; `createPaymentWrapper` cobra só a
 * chamada da tool específica, deixando o handshake do protocolo livre.
 *
 * Reaproveita o MESMO facilitator CDP e o MESMO endereço receptor
 * (`payToEvmAddress`) que o endpoint REST — uma só carteira, dois jeitos de
 * pagar. Duas tools: `get_yield_signal` (preço base) e `get_yield_decision`
 * (preço premium, DECISION_PRICE_USD).
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

  // Dois requisitos de pagamento distintos (preços diferentes) contra o MESMO
  // resourceServer/carteira: o sinal cru no preço base, a decisão no premium.
  const signalAccepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network,
    payTo: payToEvmAddress,
    price: env.PRICE_USD,
  });
  const decisionAccepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network,
    payTo: payToEvmAddress,
    price: env.DECISION_PRICE_USD,
  });

  const paidSignal = createPaymentWrapper(resourceServer, { accepts: signalAccepts });
  const paidDecision = createPaymentWrapper(resourceServer, { accepts: decisionAccepts });

  // Fato de pagamento — resourceServer daqui é uma instância PRÓPRIA do canal
  // MCP (não a do endpoint REST, ver expressApp.ts), por isso o registro é
  // feito aqui também, com channel fixo em "mcp". Um só onAfterSettle cobre as
  // duas tools (ambas liquidam no mesmo resourceServer).
  resourceServer.onAfterSettle(async (context) => {
    logSettledPayment(context, "mcp");
  });

  // Fábrica de servidor: um McpServer FRESCO por sessão MCP, com as duas tools
  // registradas. Precisa ser por-sessão (não um singleton) — ver o mapa de
  // transports e o bug corrigido no comentário do handler abaixo.
  function buildServer(): McpServer {
    const mcpServer = new McpServer({ name: "yieldsignal", version: "1.0.0" });

    mcpServer.tool(
      "get_yield_signal",
      TOOL_DESCRIPTION,
      TOOL_INPUT_SHAPE,
      paidSignal(async ({ asset = "USDC" }) => {
        try {
          // Toda chamada aqui é paga — `paidSignal()` só passa depois que o
          // pagamento liquidou (o MCP não tem free trial, ao contrário do REST).
          logger.info({ channel: "mcp", asset }, "sinal servido");
          const readings = await collectRates(asset);
          const signal = computeSignal(readings);
          // Bloco de texto original SEM alteração (é o que fica assinado) +
          // bloco irmão com a assinatura — nunca embutir a assinatura DENTRO do
          // mesmo objeto: obrigaria o cliente a re-serializar de volta pro texto
          // exato assinado, frágil (ordem de chave, espaçamento).
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

    mcpServer.tool(
      "get_yield_decision",
      DECISION_TOOL_DESCRIPTION,
      DECISION_INPUT_SHAPE,
      paidDecision(async ({ asset = "USDC", position, amountUsd, moveCostUsd, horizonDays }) => {
        // Reaproveita EXATAMENTE o mesmo validador do REST (parseDecisionQuery)
        // — inputs de robô são não-confiáveis do mesmo jeito, position/números
        // fora de faixa viram erro claro em vez de decisão silenciosamente errada.
        const parsed = parseDecisionQuery({ position, amountUsd, moveCostUsd, horizonDays });
        if (!parsed.ok) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: parsed.error }) }],
            isError: true,
          };
        }
        try {
          logger.info({ channel: "mcp-decision", asset }, "decisão servida");
          const readings = await collectRates(asset);
          const decision = decideMove(readings, parsed.input);
          // Assina o SINAL embutido (mesmo contrato do REST /decision/*): a
          // decisão é função determinística do sinal + query params, então
          // assinar o sinal já torna a decisão verificável. Devolve o texto
          // assinado verbatim (`signedSignalText`) no bloco de assinatura pra o
          // cliente hashear byte a byte, sem re-serializar (evita a fragilidade
          // de ordem de chave/espaçamento).
          const rawSignal = JSON.stringify(decision.signal);
          const signed = await signPayload(signer, rawSignal, decision.signal);
          const content = [{ type: "text" as const, text: JSON.stringify(decision) }];
          if (signed) {
            content.push({
              type: "text" as const,
              text: JSON.stringify({
                verification:
                  "EIP-712 typed data signature over the embedded signal. eip712.message.contentHash is keccak256 of signedSignalText, verbatim. The decision (action/breakEvenDays/expectedNetGainUsd) is a deterministic function of that signal plus your query params — re-run decideMove locally to reproduce it.",
                signature: signed.signature,
                signer: signed.signer,
                eip712: eip712ForTransport(signed.eip712),
                signedSignalText: rawSignal,
              }),
            });
          }
          return { content };
        } catch (err) {
          logger.error({ err, asset }, "falha gerando decisão (MCP)");
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "falha temporária lendo taxas" }) }],
            isError: true,
          };
        }
      }),
    );

    return mcpServer;
  }

  // UMA sessão MCP = um transport + um McpServer, indexados por `mcp-session-id`.
  //
  // BUG CORRIGIDO (era real em produção): antes existia UM único transport no
  // escopo do handler, criado uma vez. Em modo stateful o transport carrega uma
  // sessão; o PRIMEIRO `initialize` a preenchia e QUALQUER `initialize` de um
  // segundo cliente batia em "Server already initialized" — a instância quente
  // da Vercel rejeitava todo cliente novo depois do primeiro. Agora cada
  // `initialize` cria sua própria sessão (transport + McpServer próprios), e
  // sessões concorrentes coexistem na mesma instância quente.
  //
  // Limitação serverless que PERMANECE (aceita, documentada): o mapa vive só na
  // instância quente que criou a sessão. Se um cliente cair numa instância fria
  // entre `initialize` e `tools/call`, a sessão não é encontrada — devolvemos
  // 400 JSON-RPC pedindo pra reinicializar (chamada avulsa, sem conversa longa,
  // reinit é barato). Mesma categoria da limitação do cache de `appPromise`.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  return async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        if (req.method === "POST" && isInitializeRequest(req.body)) {
          const newTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, newTransport);
            },
          });
          newTransport.onclose = () => {
            if (newTransport.sessionId) transports.delete(newTransport.sessionId);
          };
          await buildServer().connect(newTransport);
          transport = newTransport;
        } else {
          // Sem sessão e não é `initialize`: cliente mandou `tools/call`/DELETE
          // pra uma sessão que esta instância não conhece (provável instância
          // fria — ver limitação acima). 400 JSON-RPC pra ele reinicializar.
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "No valid MCP session. Send an initialize request first." },
            id: null,
          });
          return;
        }
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, "falha no handler MCP");
      if (!res.headersSent) {
        res.status(500).json({ error: "falha interna no servidor MCP" });
      }
    }
  };
}
