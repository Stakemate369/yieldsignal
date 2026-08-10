import { describe, expect, it } from "vitest";
import { buildOpenApi, buildWellKnownX402, DISCOVERY_VERSION, type DiscoveryRoute } from "../src/discoveryDocument.js";

const PAY_TO = "0x561143BFE9E2D975D92e915B8EfFEAa54119472a";
const BASE = "https://yieldsignal.vercel.app";

const routes: DiscoveryRoute[] = [
  { path: "/signal/usdc-base-yield", description: "Real-time risk-weighted USDC lending APY on Base.", priceUsd: "$0.01", params: [] },
  {
    path: "/exposure/usdc-base-yield",
    description: "Shared risk exposure across declared positions.",
    priceUsd: "$0.01",
    params: [{ name: "positions", required: true, type: "string", description: "REQUIRED. protocol:usd pairs." }],
  },
];

/**
 * Motivo de existir: a submissão ao x402scan foi RECUSADA em 2026-08-06 com
 * "No discovery document found". Responder 402 não basta — o indexador precisa
 * da enumeração das rotas pra saber que são 14 e não 1.
 */
describe("buildWellKnownX402", () => {
  it("tem os campos que a spec exige", () => {
    const d = buildWellKnownX402(BASE, routes, PAY_TO);
    expect(d.version).toBe(DISCOVERY_VERSION);
    expect(d.resources).toEqual([
      `${BASE}/signal/usdc-base-yield`,
      `${BASE}/exposure/usdc-base-yield`,
    ]);
  });

  // Mesma chave recebe o pagamento E assina as respostas — é isso que torna
  // "quem foi pago" e "quem assinou" provadamente o mesmo ator.
  it("declara o endereço pagador como prova de posse", () => {
    expect(buildWellKnownX402(BASE, routes, PAY_TO).ownershipProofs).toEqual([PAY_TO]);
  });

  it("URLs são absolutas — o indexador não adivinha o host", () => {
    for (const r of buildWellKnownX402(BASE, routes, PAY_TO).resources as string[]) {
      expect(r.startsWith("https://")).toBe(true);
    }
  });
});

describe("buildOpenApi", () => {
  it("descreve uma operação GET por rota paga", () => {
    const doc = buildOpenApi(BASE, routes, PAY_TO) as { paths: Record<string, { get: unknown }> };
    expect(Object.keys(doc.paths).sort()).toEqual(["/exposure/usdc-base-yield", "/signal/usdc-base-yield"]);
    expect(doc.paths["/signal/usdc-base-yield"]!.get).toBeDefined();
  });

  /**
   * O ponto do OpenAPI ter precedência sobre o `.well-known`: um agente aprende
   * que `positions` é obrigatório ANTES de pagar, em vez de descobrir levando
   * 400 depois de a cobrança ter liquidado.
   */
  it("marca parâmetro obrigatório como obrigatório", () => {
    const doc = buildOpenApi(BASE, routes, PAY_TO) as any;
    const params = doc.paths["/exposure/usdc-base-yield"].get.parameters as { name: string; required: boolean }[];
    const positions = params.find((p) => p.name === "positions")!;
    expect(positions.required).toBe(true);
  });

  // Regressão da degustação removida em 2026-08-10: anunciar um atalho grátis
  // aqui o entrega ao varredor automático, que é justamente quem lê este
  // documento — e foi assim que 125 respostas saíram para 26 pagamentos.
  it("não anuncia nenhum parâmetro de acesso gratuito", () => {
    const doc = buildOpenApi(BASE, routes, PAY_TO) as any;
    for (const path of Object.keys(doc.paths)) {
      const nomes = (doc.paths[path].get.parameters as { name: string }[]).map((p) => p.name);
      expect(nomes).not.toContain("trial");
    }
  });

  // Esconder o 402 faria o agente tratar a cobrança como erro.
  it("declara 402 como resposta esperada, não como falha", () => {
    const doc = buildOpenApi(BASE, routes, PAY_TO) as any;
    const r = doc.paths["/signal/usdc-base-yield"].get.responses;
    expect(r["402"]).toBeDefined();
    expect(String(r["402"].description)).toContain("USDC");
    expect(r["200"]).toBeDefined();
  });

  // Sem contato, o x402scan lista o serviço como NÃO verificado.
  it("declara contato, que é o que verifica posse do domínio", () => {
    const doc = buildOpenApi(BASE, routes, PAY_TO) as any;
    expect(doc.info.contact.email).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    expect(doc.info.contact.url).toContain("github.com");
  });

  it("carrega os metadados de pagamento x402", () => {
    const doc = buildOpenApi(BASE, routes, PAY_TO) as any;
    expect(doc["x-x402"].payTo).toBe(PAY_TO);
    expect(doc["x-x402"].network).toBe("eip155:8453");
    expect(doc["x-x402"].accuracy).toBe(`${BASE}/accuracy.json`);
  });

  it("usa a MESMA descrição do desafio 402, sem versão embelezada", () => {
    const doc = buildOpenApi(BASE, routes, PAY_TO) as any;
    expect(doc.paths["/signal/usdc-base-yield"].get.description).toBe(routes[0]!.description);
  });

  it("gera operationId único e válido por rota", () => {
    const doc = buildOpenApi(BASE, routes, PAY_TO) as any;
    const ids = Object.values(doc.paths).map((p: any) => p.get.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(String(id)).toMatch(/^[a-zA-Z0-9_]+$/);
  });
});
