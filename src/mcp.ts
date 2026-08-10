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
import { ASSET_IDS, LENDING_ASSET_IDS } from "./market-data/types.js";
import { computeDurability } from "./signal/durability.js";
import { computeCapacity } from "./signal/capacity.js";
import { computeSensitivity } from "./signal/sensitivity.js";
import { computeExposure } from "./signal/exposure.js";
import { collectExposureFactors } from "./market-data/exposureFactors.js";
import { parsePositions } from "./signal/parsePositions.js";
import { collectBorrowRateCurves } from "./market-data/rateCurve.js";
import { logger } from "./notify/logger.js";
import { logSettledPayment, recordSettlementUsage } from "./notify/paymentLog.js";
import { recordUsage } from "./usage/usageStore.js";
import type { SignerAccount } from "./wallet/signerAccount.js";
import { signPayload, eip712ForTransport } from "./signal/signResponse.js";

const TOOL_DESCRIPTION =
  "Real-time risk-weighted yield signal. USDC/WETH: lending APY on Base (Aave/Compound/Morpho read onchain, Moonwell/Euler/Fluid via DefiLlama). ETH_STAKING: liquid staking APY on Ethereum mainnet (Lido/Rocket Pool/Coinbase Wrapped Staked ETH/Frax Ether/Binance Staked ETH, all via DefiLlama) — a different chain and category from the lending signals, not a Base lending market. Source tagged per reading (never estimated). Result is signed (EIP-712 typed data) by the payment-receiving address, returned as a sibling content block for offline verification. That same address is registered on-chain as an ERC-8004 agent identity (agent-card.json) and periodically publishes EAS attestations of past readings (Base mainnet) — a public track record independent of this server's uptime.";

const DECISION_TOOL_DESCRIPTION =
  "Buyer-side MOVE/HOLD decision (Layer 1 premium — sells the decision, not the raw datapoint). Given your current position, size, move cost and horizon, returns whether moving your capital to the best risk-adjusted protocol pays for itself now — with expected net gain, break-even days and a confidence tier. Deterministic from the underlying signal, which is EIP-712 signed and returned in a sibling content block (re-run the decision locally to reproduce it). Priced above the plain signal tool.";

const DURABILITY_TOOL_DESCRIPTION =
  "How much of the current APY survives if incentives stop. Splits each protocol's yield into base interest vs reward/incentive, reports the post-incentive floor, and says whether the leader changes without incentives. Only protocols whose source itemizes the reward component are decomposed — the rest are listed as undecomposable and NEVER assumed incentive-free, and no ranking claim is made when the current leader is one of them. Also returns bestVerifiableFloor: the highest yield provably independent of incentives. A stress test of readings taken now, not a forecast of when a campaign ends.";

const CAPACITY_TOOL_DESCRIPTION =
  "Exit capacity for a Base lending market: per-protocol utilization and withdrawable liquidity read from the protocol's own books (Aave, Compound), plus — if you pass amountUsd — whether that size can be withdrawn right now and what share of the market it would be. High APY at high utilization means the market pays well and will not let you out; this tool separates the two. Protocols that do not expose borrowed-vs-supplied are marked unmeasured and are never recommended as executable. USDC only for USD figures; WETH returns utilization without USD (no price oracle in the paid path).";

const TOOL_INPUT_SHAPE = {
  asset: z
    .enum(ASSET_IDS)
    .optional()
    .describe("Which yield signal to fetch: USDC/WETH lending APY on Base, or ETH_STAKING liquid staking APY on Ethereum mainnet. Defaults to USDC."),
};

const DURABILITY_INPUT_SHAPE = {
  asset: z
    .enum(LENDING_ASSET_IDS)
    .optional()
    .describe("Which Base lending market to stress-test: USDC or WETH. Defaults to USDC."),
};

const SENSITIVITY_TOOL_DESCRIPTION =
  "How close a Base lending market is to the kink where borrow rates explode. Returns, per protocol, the current utilization, the kink read from the protocol's own interest rate curve, the headroom in bps, and the borrow APY at points around the kink — plus how many times the borrow cost multiplies just past it. Measured on a live reading: Compound USDC sat 0.17 points below its kink, where borrow cost goes from ~4% to ~16%. Aave and Compound only: Morpho's adaptive IRM has no static curve to read and DefiLlama-sourced protocols expose none, so they are marked unmeasured and never assumed stable. Describes the current state of the curve, not a prediction that utilization will move.";

const EXPOSURE_TOOL_DESCRIPTION =
  "Shared risk exposure across a declared portfolio. Give it your positions (protocol:usd pairs) and it returns, per factor, how much of your capital sits behind the same collateral, price oracle or vault curator — and through which venues it gets there. This is the question the market does not answer: depeg and hack alerts tell you an event happened, not whether you are two hops from it. In the Stream Finance collapse only 1 of ~320 MetaMorpho vaults held the broken asset directly, yet $93M of loss became $285M of contagion. Measured live: a Morpho USDC vault sits 93.7% behind cbBTC while Compound's USDC market is 43.1% — holding both is one risk in two wrappers. Morpho is attributed per isolated market and Compound by its real posted-collateral basket; Aave is reported unattributed, because a v3 supplier is exposed to the entire pool and splitting that across assets would imply diversification that does not exist. Structural shared exposure, not a correlation estimate.";

const EXPOSURE_INPUT_SHAPE = {
  asset: z
    .enum(LENDING_ASSET_IDS)
    .optional()
    .describe("Which Base lending market the positions are in: USDC or WETH. Defaults to USDC."),
  positions: z
    .string()
    .describe("Your positions as comma-separated protocol:usd pairs, e.g. \"aave:200000,morpho:150000\". Known protocols: aave, morpho, compound, moonwell, euler, fluid."),
};

const CAPACITY_INPUT_SHAPE = {
  // Enum restrito a LENDING_ASSET_IDS de propósito: pedir capacidade de
  // ETH_STAKING é uma pergunta sem resposta (staking não tem mercado de
  // empréstimo), e é melhor o schema recusar do que a tool cobrar e devolver
  // tudo `null`.
  asset: z
    .enum(LENDING_ASSET_IDS)
    .optional()
    .describe("Which Base lending market to measure: USDC (full USD figures) or WETH (utilization only). Defaults to USDC."),
  amountUsd: z
    .number()
    .optional()
    .describe("Position size in USD to test for exit. Omit to get utilization and free liquidity without an exit verdict."),
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

  // Três requisitos de pagamento distintos (preços diferentes) contra o MESMO
  // resourceServer/carteira: o sinal cru no preço base, as 4 analíticas no
  // intermediário, a decisão no premium. Os mesmos três preços das rotas REST
  // (ver expressApp.ts) — canal diferente não pode cobrar valor diferente pelo
  // mesmo produto, senão o comprador escolhe o canal pelo preço, não pelo uso.
  const signalAccepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network,
    payTo: payToEvmAddress,
    price: env.PRICE_USD,
  });
  const analyticsAccepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network,
    payTo: payToEvmAddress,
    price: env.ANALYTICS_PRICE_USD,
  });
  const decisionAccepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network,
    payTo: payToEvmAddress,
    price: env.DECISION_PRICE_USD,
  });

  const paidSignal = createPaymentWrapper(resourceServer, { accepts: signalAccepts });
  const paidAnalytics = createPaymentWrapper(resourceServer, { accepts: analyticsAccepts });
  const paidDecision = createPaymentWrapper(resourceServer, { accepts: decisionAccepts });

  // Fato de pagamento — resourceServer daqui é uma instância PRÓPRIA do canal
  // MCP (não a do endpoint REST, ver expressApp.ts), por isso o registro é
  // feito aqui também, com channel fixo em "mcp". Um só onAfterSettle cobre as
  // duas tools (ambas liquidam no mesmo resourceServer).
  resourceServer.onAfterSettle(async (context) => {
    logSettledPayment(context, "mcp");
    await recordSettlementUsage(context, "mcp");
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
          // pagamento liquidou.
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
          // Contado só aqui, DEPOIS de tudo que pode falhar (leitura +
          // assinatura) — mesma correção já aplicada no REST (ver
          // expressApp.ts#respondWithSignal): registrar antes fazia o MESMO
          // pedido entrar como served E failed quando a leitura estourava,
          // inflando o topo do funil.
          logger.info({ channel: "mcp", asset }, "sinal servido");
          await recordUsage({ kind: "served", route: "signal", channel: "mcp", asset });
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
          // Contado depois de tudo que pode falhar — ver a nota em get_yield_signal.
          logger.info({ channel: "mcp-decision", asset }, "decisão servida");
          await recordUsage({ kind: "served", route: "decision", channel: "mcp", asset });
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

    /**
     * Tools analíticas (2026-08-05). Preço PRÓPRIO (`paidAnalytics`), entre o
     * sinal cru e o premium da decisão — nasceram no preço base por não terem
     * track record, e a ordem "primeiro o histórico verificável, depois o
     * preço" foi cumprida (sensibilidade atestada on-chain desde 2026-08-06).
     *
     * As duas assinam o SINAL derivado das mesmas leituras, mesmo contrato já
     * usado por `get_yield_decision`: o relatório é função determinística do
     * sinal, então assinar o sinal (devolvido verbatim em `signedSignalText`)
     * deixa o comprador reproduzir a derivação e conferir sem struct novo.
     */
    async function derivedToolResult<T>(
      asset: (typeof ASSET_IDS)[number],
      route: "durability" | "capacity" | "sensitivity" | "exposure",
      // Assíncrona porque a sensibilidade lê a curva de juros on-chain além das
      // taxas; as outras duas continuam derivando de forma síncrona.
      derive: (readings: Awaited<ReturnType<typeof collectRates>>) => T | Promise<T>,
    ) {
      try {
        const readings = await collectRates(asset);
        const signal = computeSignal(readings);
        const rawSignal = JSON.stringify(signal);
        const signed = await signPayload(signer, rawSignal, signal);
        const content = [{ type: "text" as const, text: JSON.stringify(await derive(readings)) }];
        if (signed) {
          content.push({
            type: "text" as const,
            text: JSON.stringify({
              verification:
                "EIP-712 typed data signature over the underlying signal. eip712.message.contentHash is keccak256 of signedSignalText, verbatim. The report in the previous block is a deterministic function of the same readings — recompute it locally to reproduce.",
              signature: signed.signature,
              signer: signed.signer,
              eip712: eip712ForTransport(signed.eip712),
              signedSignalText: rawSignal,
            }),
          });
        }
        // Contado depois de tudo que pode falhar — ver a nota em get_yield_signal.
        logger.info({ channel: `mcp-${route}`, asset }, "relatório derivado servido");
        await recordUsage({ kind: "served", route, channel: "mcp", asset });
        return { content };
      } catch (err) {
        logger.error({ err, asset, route }, "falha gerando relatório derivado (MCP)");
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "falha temporária lendo taxas" }) }],
          isError: true,
        };
      }
    }

    mcpServer.tool(
      "get_yield_durability",
      DURABILITY_TOOL_DESCRIPTION,
      // Enum restrito a lending pelo mesmo motivo da tool de capacidade: os 5
      // protocolos de staking vêm da DefiLlama sem componente de incentivo
      // itemizado, então ETH_STAKING seria 0 de 5 decomponíveis em toda chamada.
      DURABILITY_INPUT_SHAPE,
      paidAnalytics(async ({ asset = "USDC" }) =>
        derivedToolResult(asset, "durability", (readings) => computeDurability(asset, readings)),
      ),
    );

    mcpServer.tool(
      "get_exit_capacity",
      CAPACITY_TOOL_DESCRIPTION,
      CAPACITY_INPUT_SHAPE,
      paidAnalytics(async ({ asset = "USDC", amountUsd }) => {
        // `amountUsd` inválido (negativo/NaN) vira "sem veredito" em vez de erro:
        // diferente da decisão, aqui o parâmetro é OPCIONAL — a resposta sem ele
        // continua sendo útil (utilização e liquidez livre), então recusar a
        // chamada inteira depois de o comprador já ter pago seria pior.
        const amount = typeof amountUsd === "number" && Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : null;
        return derivedToolResult(asset, "capacity", (readings) => computeCapacity(asset, readings, amount));
      }),
    );

    mcpServer.tool(
      "get_rate_sensitivity",
      SENSITIVITY_TOOL_DESCRIPTION,
      // Mesmo enum restrito das outras duas analíticas: só mercado de empréstimo
      // tem curva de utilização.
      DURABILITY_INPUT_SHAPE,
      paidAnalytics(async ({ asset = "USDC" }) =>
        derivedToolResult(asset, "sensitivity", async (readings) =>
          computeSensitivity(
            asset,
            readings,
            await collectBorrowRateCurves(
              asset,
              readings.map((r) => r.protocol),
            ),
          ),
        ),
      ),
    );

    mcpServer.tool(
      "get_shared_exposure",
      EXPOSURE_TOOL_DESCRIPTION,
      EXPOSURE_INPUT_SHAPE,
      paidAnalytics(async ({ asset = "USDC", positions }) => {
        // Mesmo validador do REST — input de robô é não-confiável do mesmo
        // jeito, e um protocolo escrito errado que passasse em silêncio faria o
        // relatório ignorar parte da carteira sem dizer que ignorou.
        const parsed = parsePositions(positions);
        if (!parsed.ok) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: parsed.error }) }],
            isError: true,
          };
        }
        return derivedToolResult(asset, "exposure", async () =>
          computeExposure(
            asset,
            parsed.positions,
            await collectExposureFactors(
              asset,
              parsed.positions.map((p) => p.protocol),
            ),
          ),
        );
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
