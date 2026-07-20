import { collectRates } from "../signal/collectRates.js";
import { computeSignal } from "../signal/computeSignal.js";
import type { YieldSignal } from "../signal/computeSignal.js";
import type { AssetId, ProtocolId } from "../market-data/types.js";
import { fetchSignalAttestations } from "./queryAttestations.js";

export interface TrackRecordEntry {
  uid: `0x${string}`;
  asset: AssetId;
  attestedAt: string;
  bestProtocolAtAttestation: ProtocolId;
  weightedApyBpsAtAttestation: number;
  gapBpsAtAttestation: number;
  /** null só se TODAS as fontes de taxa falharem agora (ver collectRates) — nunca um valor estimado. */
  currentWeightedApyBps: number | null;
  currentBestProtocol: ProtocolId | null;
  /** O protocolo atestado então ainda é o melhor hoje? null se não deu pra ler o mercado agora. */
  stillBest: boolean | null;
  easscanUrl: string;
}

/**
 * Monta o histórico público "o que dissemos então vs. o que é verdade agora"
 * — fonte da verdade é o próprio EAS (não existe banco novo, ver
 * queryAttestations.ts). Não é um backtest de preço histórico exato (não dá
 * pra reconsultar a APY de um protocolo NUM BLOCO passado sem indexação
 * própria) — é honesto sobre isso: compara contra o mercado ATUAL, útil pra
 * checar se o sinal continua direcionalmente certo.
 *
 * Uma leitura de mercado por ASSET distinto (não por atestação — várias
 * atestações do mesmo asset reaproveitam a mesma leitura, `collectRates` já
 * tem cache próprio de qualquer forma).
 */
export async function buildTrackRecord(params: {
  schemaUid: `0x${string}`;
  attester: `0x${string}`;
}): Promise<TrackRecordEntry[]> {
  const attestations = await fetchSignalAttestations({ schemaId: params.schemaUid, attester: params.attester });
  const assets = Array.from(new Set(attestations.map((a) => a.asset)));

  const currentSignals = new Map<AssetId, YieldSignal | null>();
  await Promise.all(
    assets.map(async (asset) => {
      try {
        const readings = await collectRates(asset);
        currentSignals.set(asset, computeSignal(readings));
      } catch {
        currentSignals.set(asset, null);
      }
    }),
  );

  return attestations.map((a) => {
    const current = currentSignals.get(a.asset) ?? null;
    const currentRate = current?.rates.find((r) => r.protocol === a.bestProtocol) ?? null;
    return {
      uid: a.uid,
      asset: a.asset,
      attestedAt: new Date(a.time * 1000).toISOString(),
      bestProtocolAtAttestation: a.bestProtocol,
      weightedApyBpsAtAttestation: a.weightedApyBps,
      gapBpsAtAttestation: a.gapBps,
      currentWeightedApyBps: currentRate?.weightedApyBps ?? null,
      currentBestProtocol: current?.bestProtocol ?? null,
      stillBest: current ? current.bestProtocol === a.bestProtocol : null,
      easscanUrl: `https://base.easscan.org/attestation/view/${a.uid}`,
    };
  });
}
