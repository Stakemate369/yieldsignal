import { loadEnv } from "../config/env.js";
import { cachedWithTtl } from "../market-data/cache.js";
import { fetchSignalAttestations, type DecodedSignalAttestation } from "./queryAttestations.js";
import { computePersistence, type PersistenceReport } from "./persistence.js";

/**
 * Cache ÚNICO do histórico atestado, compartilhado por todo mundo que o lê:
 * página inicial, /accuracy.json, as rotas /persistence e a tool MCP
 * equivalente. Antes cada consumidor buscava por conta própria — REST e MCP
 * fariam duas consultas ao EASScan pro mesmo dado, na mesma invocação fria.
 *
 * TTL de 10min contra uma cadência de atestação de ~1h: nunca serve nada que
 * valesse a pena atualizar antes disso, e o custo de uma leitura a mais no
 * EASScan (que é gratuito mas tem limite de taxa) some.
 *
 * Módulo-nível de propósito: em serverless a instância é reaproveitada entre
 * requisições, então o cache sobrevive ao request e é justamente aí que ele
 * paga. Uma instância nova simplesmente busca de novo.
 */

/**
 * `take` alto porque o histórico passou de 439 atestações em 24 dias e o
 * default do fetch é 100 — com ele, TODA métrica de histórico ficava calculada
 * em silêncio sobre a última fatia. A persistência, que vive de tamanho de
 * amostra, era a mais prejudicada: 167 dos 177 spells medidos ficariam de fora.
 */
const HISTORY_TAKE = 500;

const TTL_MS = 10 * 60 * 1000;

function schemaConfig(): { attestSchemaUid: `0x${string}`; legacy: `0x${string}`[]; enabled: boolean } | null {
  const env = loadEnv();
  const enabled = Boolean(env.EAS_SCHEMA_UID || env.EAS_SCHEMA_UID_V2);
  if (!enabled) return null;
  return {
    attestSchemaUid: (env.EAS_SCHEMA_UID_V2 || env.EAS_SCHEMA_UID) as `0x${string}`,
    // O v1 entra JUNTO na leitura depois da migração — sem isto, o dia da
    // virada zeraria o histórico público em vez de continuá-lo.
    legacy: (env.EAS_SCHEMA_UID_V2 && env.EAS_SCHEMA_UID ? [env.EAS_SCHEMA_UID] : []) as `0x${string}`[],
    enabled,
  };
}

/**
 * Um cache por endereço de atestador. Na prática há um só, mas indexar por
 * endereço evita que um teste (ou um segundo signer) receba o histórico do
 * outro — silenciosamente, que é o pior jeito de errar aqui.
 */
const porAtestador = new Map<
  string,
  { attestations: () => Promise<DecodedSignalAttestation[] | null>; persistence: () => Promise<PersistenceReport | null> }
>();

function cachesFor(attester: `0x${string}`) {
  const chave = attester.toLowerCase();
  const existente = porAtestador.get(chave);
  if (existente) return existente;

  const attestations = cachedWithTtl(async () => {
    const cfg = schemaConfig();
    if (!cfg) return null;
    return fetchSignalAttestations({
      schemaId: cfg.attestSchemaUid,
      alsoSchemaIds: cfg.legacy,
      attester,
      take: HISTORY_TAKE,
    });
  }, TTL_MS);

  const persistence = cachedWithTtl(async () => {
    const att = await attestations();
    if (!att || att.length === 0) return null;
    return computePersistence(att);
  }, TTL_MS);

  const criado = { attestations, persistence };
  porAtestador.set(chave, criado);
  return criado;
}

/** Histórico cru — usado por quem precisa pontuar atestação por atestação. */
export function loadAttestations(attester: `0x${string}`): Promise<DecodedSignalAttestation[] | null> {
  return cachesFor(attester).attestations();
}

/** Relatório de persistência já agregado. `null` sem schema configurado ou sem histórico. */
export function loadPersistence(attester: `0x${string}`): Promise<PersistenceReport | null> {
  return cachesFor(attester).persistence();
}

/** Só pra teste: zera os caches entre casos. */
export function resetAttestationCaches(): void {
  porAtestador.clear();
}
