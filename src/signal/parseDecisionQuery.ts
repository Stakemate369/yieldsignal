import type { ProtocolId } from "../market-data/types.js";
import type { MoveDecisionInput } from "./decideMove.js";

// Protocolos válidos como "posição atual" informada pelo comprador — mesma
// lista canônica de ProtocolId (mantida em sincronia via satisfies).
const KNOWN_PROTOCOLS: readonly ProtocolId[] = [
  "aave",
  "morpho",
  "compound",
  "moonwell",
  "euler",
  "fluid",
  "lido",
  "rocket-pool",
  "coinbase-wrapped-staked-eth",
  "frax-ether",
  "binance-staked-eth",
];

// Limites sãos pros parâmetros numéricos — barram valores absurdos/hostis
// (NaN, negativos, ordens de grandeza irreais) que produziriam uma decisão
// sem sentido. Defaults escolhidos pra um caso de uso típico de agente.
const DEFAULTS = { amountUsd: 1000, moveCostUsd: 0.5, horizonDays: 30 };
const BOUNDS = {
  amountUsd: { min: 0, max: 1_000_000_000 },
  moveCostUsd: { min: 0, max: 1_000_000 },
  horizonDays: { min: 0.0001, max: 3650 },
};

export interface ParseResult {
  ok: true;
  input: MoveDecisionInput;
}
export interface ParseError {
  ok: false;
  error: string;
}

function num(raw: unknown, fallback: number, bound: { min: number; max: number }, name: string): number | { error: string } {
  if (raw === undefined || raw === "") return fallback;
  const v = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(v)) return { error: `${name} inválido: "${String(raw)}" não é um número` };
  if (v < bound.min || v > bound.max) return { error: `${name} fora dos limites [${bound.min}, ${bound.max}]: ${v}` };
  return v;
}

/**
 * Traduz os query params da chamada de decisão num `MoveDecisionInput`
 * validado — puro, sem I/O, testável. Query params são sempre não-confiáveis
 * (vêm de qualquer agente na internet), então: números fora de faixa ou
 * `position` desconhecida são rejeitados com mensagem clara, em vez de virar
 * uma decisão silenciosamente errada.
 *
 * - `position`: protocolo onde o capital do comprador está agora. Ausente,
 *   vazio, ou "idle"/"none" => capital ocioso (`currentProtocol: null`).
 * - `amountUsd` / `moveCostUsd` / `horizonDays`: opcionais, com default.
 */
export function parseDecisionQuery(query: Record<string, unknown>): ParseResult | ParseError {
  let currentProtocol: ProtocolId | null;
  const rawPos = query.position;
  if (rawPos === undefined || rawPos === "" || rawPos === "idle" || rawPos === "none") {
    currentProtocol = null;
  } else if (typeof rawPos === "string" && (KNOWN_PROTOCOLS as string[]).includes(rawPos)) {
    currentProtocol = rawPos as ProtocolId;
  } else {
    return { ok: false, error: `position desconhecida: "${String(rawPos)}". Use um protocolo conhecido, "idle", ou omita.` };
  }

  const amountUsd = num(query.amountUsd, DEFAULTS.amountUsd, BOUNDS.amountUsd, "amountUsd");
  if (typeof amountUsd === "object") return { ok: false, error: amountUsd.error };
  const moveCostUsd = num(query.moveCostUsd, DEFAULTS.moveCostUsd, BOUNDS.moveCostUsd, "moveCostUsd");
  if (typeof moveCostUsd === "object") return { ok: false, error: moveCostUsd.error };
  const horizonDays = num(query.horizonDays, DEFAULTS.horizonDays, BOUNDS.horizonDays, "horizonDays");
  if (typeof horizonDays === "object") return { ok: false, error: horizonDays.error };

  return { ok: true, input: { currentProtocol, amountUsd, moveCostUsd, horizonDays } };
}
