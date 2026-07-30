import type { AssetId, ProtocolId } from "../market-data/types.js";
import type { DecodedSignalAttestation } from "./queryAttestations.js";

/**
 * ACURÁCIA POR JANELA DE VIGÊNCIA — a métrica que responde o que um comprador
 * máquina de fato pergunta: "enquanto este sinal estava valendo, ele estava
 * certo?".
 *
 * Por que existe (achado de 2026-07-30): o score original (accuracyScore.ts)
 * compara TODA atestação passada contra o mercado de AGORA. Isso mede
 * persistência do mercado, não acerto do sinal — e pune duas vezes o ativo mais
 * volátil: ele gera mais atestações (o gatilho dispara mais) E cada uma delas
 * segue sendo julgada contra um mercado cada vez mais distante. Era exatamente
 * a foto do USDC: 78 atestações contra 11 de WETH, hit-rate 39,7% contra 100%.
 * Uma chamada que ficou 11 horas de pé e foi corretamente substituída aparecia
 * como erro; uma que valeu 20 minutos pesava igual.
 *
 * Aqui cada atestação é julgada na janela DELA: vale da hora em que foi
 * publicada até a atestação seguinte do mesmo asset. Se a seguinte ainda aponta
 * o mesmo protocolo, a chamada se sustentou; se aponta outro, a chamada foi
 * substituída — e a duração entra no peso, que é o que separa "durou 3 dias" de
 * "durou 20 minutos".
 *
 * LIMITE HONESTO, declarado no próprio payload: quem fecha a janela é o gatilho
 * do serviço (autoAttest.ts), não um relógio independente — em tese um serviço
 * mal-intencionado inflaria a métrica atestando de menos. O que impede isso na
 * prática é o teto de frescor do próprio gatilho (atestação forçada a cada 12h,
 * MAX_STALENESS_MS), e a métrica publica `medianWindowHours` justamente pra
 * essa manipulação ficar visível: janelas anormalmente longas denunciariam.
 * A janela em aberto (última atestação de cada asset) NÃO é pontuada.
 */

export interface WindowedEntry {
  uid: `0x${string}`;
  asset: AssetId;
  bestProtocol: ProtocolId;
  attestedAt: string;
  /** Fim da vigência = atestação seguinte do mesmo asset. */
  windowEndsAt: string;
  windowHours: number;
  /** A atestação seguinte ainda apontava o mesmo protocolo? */
  heldToWindowEnd: boolean;
  supersededBy: ProtocolId | null;
}

export interface WindowedAssetBreakdown {
  asset: AssetId;
  /** Janelas fechadas (existe atestação seguinte) — as únicas pontuáveis. */
  closedWindows: number;
  held: number;
  heldRate: number | null;
  /** Horas de vigência que passaram com a chamada de pé / horas totais. Peso por duração, não por contagem. */
  timeWeightedHeldRate: number | null;
  medianWindowHours: number | null;
  totalWindowHours: number;
}

export interface WindowedAccuracy {
  basis: "held-through-own-validity-window";
  closedWindows: number;
  held: number;
  heldRate: number | null;
  timeWeightedHeldRate: number | null;
  medianWindowHours: number | null;
  /** Últimas atestações (uma por asset), ainda em vigor — fora do denominador por construção. */
  openWindows: number;
  perAsset: WindowedAssetBreakdown[];
  computedAt: string;
}

const MS_PER_HOUR = 3_600_000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Monta as janelas a partir das atestações cruas. Puro, sem I/O — a fonte
 * (EAS) já é pública e verificável de forma independente, e o cálculo não
 * consulta mercado nenhum: é isto que torna a métrica reproduzível por terceiro
 * com nada além das UIDs.
 */
export function buildWindows(attestations: DecodedSignalAttestation[]): WindowedEntry[] {
  const byAsset = new Map<AssetId, DecodedSignalAttestation[]>();
  for (const a of attestations) {
    const list = byAsset.get(a.asset) ?? [];
    list.push(a);
    byAsset.set(a.asset, list);
  }

  const windows: WindowedEntry[] = [];
  for (const [asset, list] of byAsset) {
    // `time` é o instante em que a atestação foi minerada — ordenar por ele (e
    // não pela ordem de chegada da query) é o que garante que "a seguinte" seja
    // mesmo a seguinte.
    const ordered = [...list].sort((a, b) => a.time - b.time);
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const current = ordered[i];
      const next = ordered[i + 1];
      const windowHours = (next.time - current.time) / 3600;
      windows.push({
        uid: current.uid,
        asset,
        bestProtocol: current.bestProtocol,
        attestedAt: new Date(current.time * 1000).toISOString(),
        windowEndsAt: new Date(next.time * 1000).toISOString(),
        windowHours: round2(windowHours),
        heldToWindowEnd: next.bestProtocol === current.bestProtocol,
        supersededBy: next.bestProtocol === current.bestProtocol ? null : next.bestProtocol,
      });
    }
  }
  return windows;
}

/** Agrega as janelas no score publicado. `openAssets` = quantos assets têm janela em aberto. */
export function computeWindowedAccuracy(attestations: DecodedSignalAttestation[], now: Date = new Date()): WindowedAccuracy {
  const windows = buildWindows(attestations);
  const assetsWithAttestations = new Set(attestations.map((a) => a.asset));

  const aggregate = (entries: WindowedEntry[]): Omit<WindowedAssetBreakdown, "asset"> => {
    const held = entries.filter((e) => e.heldToWindowEnd);
    const totalHours = entries.reduce((sum, e) => sum + e.windowHours, 0);
    const heldHours = held.reduce((sum, e) => sum + e.windowHours, 0);
    return {
      closedWindows: entries.length,
      held: held.length,
      heldRate: entries.length > 0 ? held.length / entries.length : null,
      // Denominador em horas: janela de duração zero (duas atestações no mesmo
      // segundo) não pode zerar a divisão nem inflar a taxa.
      timeWeightedHeldRate: totalHours > 0 ? heldHours / totalHours : null,
      medianWindowHours: median(entries.map((e) => e.windowHours)),
      totalWindowHours: round2(totalHours),
    };
  };

  const perAsset: WindowedAssetBreakdown[] = Array.from(assetsWithAttestations).map((asset) => ({
    asset,
    ...aggregate(windows.filter((w) => w.asset === asset)),
  }));

  const overall = aggregate(windows);
  return {
    basis: "held-through-own-validity-window",
    closedWindows: overall.closedWindows,
    held: overall.held,
    heldRate: overall.heldRate,
    timeWeightedHeldRate: overall.timeWeightedHeldRate,
    medianWindowHours: overall.medianWindowHours,
    openWindows: assetsWithAttestations.size,
    perAsset,
    computedAt: now.toISOString(),
  };
}
