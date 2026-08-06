import { LENDING_PROTOCOL_IDS } from "../market-data/types.js";
import type { DeclaredPosition } from "./exposure.js";

/**
 * Lê o `?positions=` da rota de exposição: `aave:200000,morpho:150000`.
 *
 * É a PRIMEIRA rota deste serviço que recebe dado do comprador em vez de só
 * entregar, então a validação é rígida de propósito — mesma disciplina de
 * `parseDecisionQuery`. Entrada duvidosa não pode virar relatório de risco:
 * um protocolo digitado errado que passasse em silêncio sairia como "não
 * atribuído" e o comprador pagaria por uma análise que ignorou parte da
 * carteira dele sem avisar. Melhor um 400 que diz exatamente o que está errado.
 */
const MAX_POSITIONS = 20;
const MAX_USD = 1e12;

export type ParsedPositions =
  | { ok: true; positions: DeclaredPosition[] }
  | { ok: false; error: string };

export function parsePositions(raw: unknown): ParsedPositions {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      error: `positions is required, as protocol:usd pairs — e.g. positions=aave:200000,morpho:150000. Known protocols: ${LENDING_PROTOCOL_IDS.join(", ")}`,
    };
  }

  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) return { ok: false, error: "positions is empty" };
  if (parts.length > MAX_POSITIONS) {
    return { ok: false, error: `too many positions (${parts.length}), maximum is ${MAX_POSITIONS}` };
  }

  const known = new Set<string>(LENDING_PROTOCOL_IDS);
  // Somar duplicatas em vez de recusar: `aave:100,aave:50` é uma carteira
  // perfeitamente expressável, e recusá-la seria rigor sem propósito. Mas o
  // mesmo protocolo NÃO pode virar duas entradas, senão `nominalVenues`
  // contaria dois venues onde há um.
  const merged = new Map<string, number>();

  for (const part of parts) {
    const sep = part.indexOf(":");
    if (sep <= 0) {
      return { ok: false, error: `malformed position "${part}" — expected protocol:usd, e.g. aave:200000` };
    }
    const protocol = part.slice(0, sep).trim().toLowerCase();
    const amount = Number(part.slice(sep + 1).trim());

    if (!known.has(protocol)) {
      return { ok: false, error: `unknown protocol "${protocol}" — known: ${LENDING_PROTOCOL_IDS.join(", ")}` };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: `position for "${protocol}" must be a positive number of USD` };
    }
    if (amount > MAX_USD) {
      return { ok: false, error: `position for "${protocol}" exceeds the maximum of ${MAX_USD} USD` };
    }
    merged.set(protocol, (merged.get(protocol) ?? 0) + amount);
  }

  return {
    ok: true,
    positions: [...merged].map(([protocol, usd]) => ({ protocol, usd }) as DeclaredPosition),
  };
}
