import type { AssetId, ProtocolId } from "../market-data/types.js";

export const EASSCAN_GRAPHQL_URL = "https://base.easscan.org/graphql";

export interface DecodedSignalAttestation {
  uid: `0x${string}`;
  attester: `0x${string}`;
  /** Segundos unix — quando a atestação foi minerada (campo `time` do EASScan, não o `asOf` interno do sinal). */
  time: number;
  asset: AssetId;
  bestProtocol: ProtocolId;
  weightedApyBps: number;
  gapBps: number;
  /** Segundos unix — o `asOf` que estava DENTRO do sinal atestado (campo do nosso schema, ver attestation/schema.ts). */
  asOf: number;
}

// Formato exato devolvido pelo EASScan GraphQL pro campo `decodedDataJson` —
// confirmado ao vivo em 2026-07-17 contra a atestação real já publicada
// (query manual via curl), não adivinhado.
interface DecodedFieldValue {
  name: string;
  type: string;
  value: { name: string; type: string; value: string | boolean | { type: "BigNumber"; hex: string } };
}

export interface RawAttestation {
  id: string;
  attester: string;
  time: number;
  decodedDataJson: string;
}

/**
 * Decodifica UMA atestação bruta do GraphQL do EASScan pros campos do nosso
 * schema (`asset,bestProtocol,weightedApyBps,gapBps,asOf`) — puro, testável
 * com fixture, sem precisar bater na rede. `decodedDataJson` já vem decodificado
 * pelo próprio EASScan (não precisamos reimplementar ABI decode aqui); campos
 * uint256/uint64 chegam como `{ type: "BigNumber", hex }` — convertidos pra
 * `number` (seguro: bps e timestamps unix cabem em Number.MAX_SAFE_INTEGER).
 */
export function decodeSignalAttestation(raw: RawAttestation): DecodedSignalAttestation {
  const fields = JSON.parse(raw.decodedDataJson) as DecodedFieldValue[];
  const byName = new Map(fields.map((f) => [f.name, f.value.value]));

  function str(name: string): string {
    const v = byName.get(name);
    if (typeof v !== "string") throw new Error(`campo "${name}" ausente ou não-string na atestação ${raw.id}`);
    return v;
  }
  function num(name: string): number {
    const v = byName.get(name);
    if (typeof v === "object" && v !== null && "hex" in v) return Number(BigInt(v.hex));
    throw new Error(`campo "${name}" ausente ou não-numérico na atestação ${raw.id}`);
  }

  return {
    uid: raw.id as `0x${string}`,
    attester: raw.attester as `0x${string}`,
    time: raw.time,
    asset: str("asset") as AssetId,
    bestProtocol: str("bestProtocol") as ProtocolId,
    weightedApyBps: num("weightedApyBps"),
    gapBps: num("gapBps"),
    asOf: num("asOf"),
  };
}

/**
 * Busca o histórico de atestações deste schema+attester direto no EASScan —
 * fonte da verdade tanto pro gatilho de auto-attest (attestation/autoAttest.ts,
 * decide comparando contra a ÚLTIMA) quanto pro dashboard de track record
 * (expressApp.ts, GET /track-record) — nenhum banco novo precisa existir só
 * pra isso, o histórico já é público e permanente no próprio EAS.
 */
export async function fetchSignalAttestations(params: {
  schemaId: `0x${string}`;
  attester: `0x${string}`;
  take?: number;
}): Promise<DecodedSignalAttestation[]> {
  const { schemaId, attester, take = 100 } = params;
  const query = `query($where: AttestationWhereInput, $take: Int) {
    attestations(where: $where, take: $take, orderBy: { time: desc }) {
      id
      attester
      time
      decodedDataJson
    }
  }`;
  const res = await fetch(EASSCAN_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { where: { schemaId: { equals: schemaId }, attester: { equals: attester } }, take },
    }),
  });
  if (!res.ok) {
    throw new Error(`EASScan GraphQL respondeu ${res.status}`);
  }
  const json = (await res.json()) as { data?: { attestations: RawAttestation[] }; errors?: unknown };
  if (json.errors || !json.data) {
    throw new Error(`EASScan GraphQL erro: ${JSON.stringify(json.errors)}`);
  }
  return json.data.attestations.map(decodeSignalAttestation);
}
