/**
 * DOCUMENTOS DE DESCOBERTA — como um diretório aprende o que este serviço vende.
 *
 * Existe porque a submissão ao x402scan foi RECUSADA em 2026-08-06 com "No
 * discovery document found". Descobriu-se ali que responder 402 não basta: o
 * indexador precisa de um documento que ENUMERE as rotas pagas, senão ele não
 * tem como saber que existem 14 e não 1. Sem isto o serviço fica listado (ou
 * nem isso) pela porta de entrada e o catálogo inteiro permanece invisível.
 *
 * Dois formatos, conforme a spec do x402scan (docs/DISCOVERY.md):
 * - `/openapi.json` — TEM PRECEDÊNCIA. Descreve também os parâmetros, então um
 *   agente aprende que `positions` é obrigatório em vez de descobrir pagando.
 * - `/.well-known/x402` — fallback de compatibilidade, só a lista de rotas.
 *
 * Ambos são GERADOS das mesmas tabelas que registram as rotas de verdade. Uma
 * lista escrita à mão aqui divergiria no primeiro produto novo e passaria a
 * anunciar rota que não existe — pior que não ter documento nenhum.
 */

/** Parâmetros de query por família de rota. Fonte única com o que vai pro Bazaar. */
export interface RouteParam {
  name: string;
  required: boolean;
  type: "string" | "number";
  description: string;
}

export interface DiscoveryRoute {
  path: string;
  description: string;
  priceUsd: string;
  params: RouteParam[];
}

export const DISCOVERY_VERSION = 1;

/**
 * `{ version, resources }` é o mínimo que a spec exige; `ownershipProofs` leva
 * o endereço que RECEBE os pagamentos e ASSINA as respostas — a mesma chave nos
 * dois papéis, que é o que torna "quem foi pago" e "quem assinou" provadamente
 * o mesmo ator.
 */
export function buildWellKnownX402(baseUrl: string, routes: DiscoveryRoute[], payTo: string): Record<string, unknown> {
  return {
    version: DISCOVERY_VERSION,
    resources: routes.map((r) => `${baseUrl}${r.path}`),
    ownershipProofs: [payTo],
    instructions:
      "Every route answers with HTTP 402 and an x402 challenge until paid. Responses are EIP-712 signed by the payTo address above, which also holds the ERC-8004 identity and publishes EAS attestations on Base. Verified accuracy is free at /accuracy.json.",
  };
}

/**
 * OpenAPI 3.1 mínimo mas HONESTO: cada rota traz seu preço, seus parâmetros e a
 * mesma descrição que o comprador vê no desafio 402 — nunca uma versão
 * embelezada para o catálogo. Todas as respostas declaram 402, porque é isso
 * que uma chamada sem pagamento recebe, e esconder isso faria o agente tratar a
 * cobrança como erro.
 */
export function buildOpenApi(baseUrl: string, routes: DiscoveryRoute[], payTo: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const route of routes) {
    paths[route.path] = {
      get: {
        summary: route.description.split(".")[0],
        description: route.description,
        operationId: route.path.replace(/[^a-zA-Z0-9]/g, "_").replace(/^_/, ""),
        parameters: [
          ...route.params.map((p) => ({
            name: p.name,
            in: "query",
            required: p.required,
            schema: { type: p.type },
            description: p.description,
          })),
          {
            name: "trial",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["1"] },
            description: "Opt in to one of 3 free calls per IP per day instead of paying. A bare request always challenges with 402.",
          },
        ],
        responses: {
          "200": {
            description:
              "Paid (or free-trial) response. Signed as EIP-712 typed data by the payTo address; see the X-Signal-Signature, X-Signal-Signer and X-Signal-Eip712-Payload headers.",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "402": {
            description: `Payment required — ${route.priceUsd} USDC on Base (eip155:8453) via x402. Any x402-compatible client settles it automatically.`,
          },
          "400": { description: "Invalid query parameter. The message names the parameter and the accepted format." },
          "503": { description: "Temporary failure reading market data." },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "YieldSignal",
      version: "1.0.0",
      description:
        "Risk-weighted yield and risk intelligence for autonomous agents, paid per call via x402 — no API key, no signup. Six products: the raw signal (what pays best), the decision (is moving worth the cost), durability (how much of the yield survives if incentives stop), capacity (can you actually withdraw), sensitivity (how close the market is to the kink where borrow rates explode), and exposure (how much of a portfolio sits behind the same risk). Every report names what it could NOT establish rather than filling the gap with a guess.",
      license: { name: "MIT", url: "https://github.com/Stakemate369/yieldsignal/blob/main/LICENSE" },
      /**
       * `contact.email` é o que o x402scan usa pra VERIFICAR posse do domínio —
       * sem ele a listagem entra como não verificada. Também é a única via de
       * contato de um comprador que não abre issue no GitHub.
       */
      contact: {
        email: "evanoaltar@gmail.com",
        url: "https://github.com/Stakemate369/yieldsignal/issues",
      },
    },
    servers: [{ url: baseUrl }],
    externalDocs: { description: "Source and verifiable-trust write-up", url: "https://github.com/Stakemate369/yieldsignal" },
    "x-x402": {
      version: DISCOVERY_VERSION,
      network: "eip155:8453",
      asset: "USDC",
      payTo,
      accuracy: `${baseUrl}/accuracy.json`,
      trackRecord: `${baseUrl}/track-record.json`,
      agentCard: `${baseUrl}/agent-card.json`,
      mcp: `${baseUrl}/mcp`,
    },
    paths,
  };
}
