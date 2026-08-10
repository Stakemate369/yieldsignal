import type { AssetId, ProtocolId } from "../market-data/types.js";
import type { DecodedSignalAttestation } from "./queryAttestations.js";

/**
 * PERSISTÊNCIA DA LIDERANÇA — quanto tempo a resposta do serviço fica de pé.
 *
 * Por que existe (achado de 2026-08-10): todo o catálogo responde "quem paga
 * melhor AGORA". Nenhuma rota respondia "e isso costuma durar quanto?", que é a
 * pergunta que decide se mover capital compensa — mover custa gas e slippage,
 * e uma vantagem que morre em duas horas não paga travessia nenhuma.
 *
 * A diferença entre os ativos, medida no próprio registro on-chain, é enorme e
 * estava invisível: em 24 dias o líder do WETH nunca mudou, o do ETH_STAKING
 * mudou 10 vezes e o do USDC mudou 167. Os três eram vendidos pelo mesmo preço
 * sem que o comprador tivesse como saber qual era qual.
 *
 * Nada aqui consulta mercado: a entrada são as atestações do EAS, públicas e
 * imutáveis. Qualquer terceiro reproduz este número com as UIDs e mais nada —
 * é isso que separa a métrica de uma alegação de marketing.
 *
 * O que este módulo NÃO afirma: que o passado se repete. Ele mede o que
 * aconteceu na janela observada e devolve o tamanho da amostra junto, pra quem
 * compra decidir o quanto pesar.
 */

/** Período contínuo em que um mesmo protocolo liderou um asset. */
export interface LeadershipSpell {
  asset: AssetId;
  protocol: ProtocolId;
  startedAt: string;
  /** `null` enquanto o spell é o corrente (ainda não houve troca observada). */
  endedAt: string | null;
  hours: number;
  /** Gap (bps) sobre o 2º colocado na atestação que ABRIU o spell. */
  startGapBps: number;
  /** Quantas atestações compõem o spell — 1 = visto uma vez só. */
  observations: number;
  /** Spell fechado (houve troca depois). Só estes entram nas estatísticas de duração. */
  closed: boolean;
}

export interface SurvivalPoint {
  atLeastHours: number;
  /** Fração dos spells FECHADOS que duraram pelo menos isso. `null` sem amostra mínima. */
  rate: number | null;
}

export interface AssetPersistence {
  asset: AssetId;
  attestations: number;
  spells: number;
  closedSpells: number;
  /** Mediana da duração dos spells fechados, em horas. `null` abaixo da amostra mínima. */
  medianLeadHours: number | null;
  meanLeadHours: number | null;
  longestClosedLeadHours: number | null;
  /** Quem lidera na atestação mais recente. */
  currentProtocol: ProtocolId;
  /** Há quanto tempo lidera sem interrupção observada. */
  currentLeadHours: number;
  /**
   * A liderança corrente é mais longa que qualquer uma já encerrada — ou nunca
   * houve troca. A duração real é DESCONHECIDA e maior que a observada
   * (censura à direita): tratar `currentLeadHours` como piso, não como valor.
   */
  currentLeadCensored: boolean;
  survival: SurvivalPoint[];
  /**
   * Duração de liderança que o /decision usa pra limitar o horizonte do ganho.
   * É a mediana quando há amostra; senão, a liderança corrente — que sendo
   * censurada é um PISO, e usá-la como teto do horizonte erra pro lado de
   * prometer menos. `null` só quando não há base nenhuma.
   */
  expectedLeadHours: number | null;
  /** Mediana do intervalo entre atestações — o limite de resolução da medida. */
  observationResolutionHours: number | null;
  /** Gap mediano (bps) do 1º sobre o 2º ao longo de toda a janela. */
  medianGapBps: number | null;
  /**
   * Quanto vale, em dólares por US$ 10 mil posicionados, capturar o gap mediano
   * durante uma liderança inteira. É o teto do que perseguir o líder pode render
   * ANTES de descontar gas — se este número é menor que o custo de mover, seguir
   * o sinal ao pé da letra destrói valor. Onde `currentLeadCensored` é `true`,
   * é piso e não teto: a liderança ainda não acabou. `null` sem base.
   */
  edgeValueUsdPer10k: number | null;
  /** Par de protocolos que mais troca entre si, e que fatia das trocas ele responde. */
  topSwitchPair: string | null;
  roundTripShare: number | null;
  /** Ressalva sobre a amostra, quando houver. `null` = amostra suficiente. */
  sampleWarning: string | null;
}

export interface GapBand {
  label: string;
  minBps: number;
  /** Exclusivo. `null` = sem teto. */
  maxBps: number | null;
  spells: number;
  medianLeadHours: number | null;
}

export interface GapVsDuration {
  /** Correlação de posto de Spearman entre gap inicial e duração do spell. */
  spearman: number | null;
  n: number;
  bands: GapBand[];
  /**
   * O gap discrimina duração? Falso significa: vantagem grande NÃO dura mais que
   * vantagem pequena, e usar o tamanho do gap como proxy de durabilidade é erro.
   */
  discriminates: boolean | null;
  note: string;
}

export interface PersistenceReport {
  basis: "leadership-spells-from-onchain-attestations";
  observedFrom: string | null;
  observedTo: string | null;
  observedDays: number | null;
  totalAttestations: number;
  perAsset: AssetPersistence[];
  gapVsDuration: GapVsDuration;
  computedAt: string;
}

/**
 * Abaixo disto uma mediana é anedota, não estatística. Não é um número mágico:
 * é o piso em que a mediana para de andar com uma observação só. Amostra menor
 * devolve `null` E a contagem — nunca um número que finge precisão.
 */
export const MIN_CLOSED_SPELLS = 5;

/** Onde a pergunta "vale mover?" costuma cair: uma tarde, um dia, três dias. */
const SURVIVAL_HORIZONS_HOURS = [6, 24, 72];

/**
 * |ρ| abaixo disto é ausência de relação para o uso pretendido (escolher em
 * qual sinal confiar). Não é teste de significância — com a amostra atual um
 * ρ de 0,11 seria "significante" em alguns testes e ainda assim inútil pra
 * decidir alocação. O que importa aqui é tamanho de efeito.
 */
const SPEARMAN_DISCRIMINATION_THRESHOLD = 0.3;

const GAP_BAND_EDGES: { label: string; minBps: number; maxBps: number | null }[] = [
  { label: "0-24bps", minBps: 0, maxBps: 25 },
  { label: "25-99bps", minBps: 25, maxBps: 100 },
  { label: "100-299bps", minBps: 100, maxBps: 300 },
  { label: ">=300bps", minBps: 300, maxBps: null },
];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Quatro casas para as grandezas em que a segunda casa apagaria o sinal:
 * frações (0,0299 vira 0,03) e o ganho por US$ 10 mil, que no USDC vive na
 * ordem de um centavo — arredondar pra 2 casas o zeraria e esconderia
 * justamente a conclusão de que perseguir o líder não paga.
 */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Postos com média nos empates. Empate é a regra aqui, não a exceção — metade
 * das durações do USDC cai em 1h ou 2h por causa da cadência horária —, e
 * desempatar pela ordem do array inventaria uma ordenação que o dado não tem,
 * enviesando a correlação.
 */
function averageRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j += 1;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[indexed[k].i] = shared;
    i = j + 1;
  }
  return ranks;
}

/** Spearman = Pearson sobre os postos. `null` sem variação (correlação indefinida). */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  const n = rx.length;
  const mx = rx.reduce((a, c) => a + c, 0) / n;
  const my = ry.reduce((a, c) => a + c, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let k = 0; k < n; k += 1) {
    num += (rx[k] - mx) * (ry[k] - my);
    dx += (rx[k] - mx) ** 2;
    dy += (ry[k] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return round4(num / Math.sqrt(dx * dy));
}

/**
 * Agrupa atestações consecutivas do mesmo líder num spell. Puro, sem I/O.
 *
 * Ordena por `time` (instante de mineração) e não pela ordem de chegada da
 * query — é o que garante que "a seguinte" seja mesmo a seguinte, mesma
 * disciplina de windowedAccuracy.buildWindows.
 */
export function buildSpells(attestations: DecodedSignalAttestation[]): LeadershipSpell[] {
  const byAsset = new Map<AssetId, DecodedSignalAttestation[]>();
  for (const a of attestations) {
    const list = byAsset.get(a.asset) ?? [];
    list.push(a);
    byAsset.set(a.asset, list);
  }

  const spells: LeadershipSpell[] = [];
  for (const [asset, list] of byAsset) {
    const ordered = [...list].sort((a, b) => a.time - b.time);
    if (ordered.length === 0) continue;

    let startIdx = 0;
    for (let i = 1; i <= ordered.length; i += 1) {
      const trocou = i === ordered.length || ordered[i].bestProtocol !== ordered[startIdx].bestProtocol;
      if (!trocou) continue;

      const abre = ordered[startIdx];
      // O spell FECHA no instante da atestação que trouxe outro líder; o
      // corrente é medido até a última observação, não até "agora" — o serviço
      // não sabe o que aconteceu depois da última atestação, e esticar até o
      // relógio inflaria a duração com tempo não observado.
      const fecha = i === ordered.length ? null : ordered[i];
      const fim = fecha ?? ordered[ordered.length - 1];
      spells.push({
        asset,
        protocol: abre.bestProtocol,
        startedAt: new Date(abre.time * 1000).toISOString(),
        endedAt: fecha ? new Date(fecha.time * 1000).toISOString() : null,
        hours: round2((fim.time - abre.time) / 3600),
        startGapBps: abre.gapBps,
        observations: i - startIdx,
        closed: fecha !== null,
      });
      startIdx = i;
    }
  }
  return spells;
}

function persistenceForAsset(
  asset: AssetId,
  attestations: DecodedSignalAttestation[],
  spells: LeadershipSpell[],
): AssetPersistence {
  const ordered = [...attestations].sort((a, b) => a.time - b.time);
  const closed = spells.filter((s) => s.closed);
  const durations = closed.map((s) => s.hours);
  const enoughSample = closed.length >= MIN_CLOSED_SPELLS;

  const cadences: number[] = [];
  for (let i = 1; i < ordered.length; i += 1) cadences.push((ordered[i].time - ordered[i - 1].time) / 3600);
  const resolution = median(cadences);

  const corrente = spells.find((s) => !s.closed) ?? null;
  const maiorFechado = durations.length > 0 ? Math.max(...durations) : null;
  const correnteHoras = corrente?.hours ?? 0;

  const medianLead = enoughSample ? median(durations) : null;
  const gapMediano = median(ordered.map((a) => a.gapBps));
  // Regra única de "quanto tempo esperar que a liderança dure", usada tanto no
  // valor do edge quanto pelo /decision — declarada UMA vez pra as duas contas
  // não poderem divergir com o tempo.
  const expectedLead = medianLead ?? (correnteHoras > 0 ? round2(correnteHoras) : null);

  // Trocas: par de origem->destino em cada mudança de líder, pra separar
  // rotação real de pinga-pinga entre dois protocolos empatados.
  const paresContagem = new Map<string, number>();
  const idaEVoltaContagem = new Map<string, number>();
  let trocas = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].bestProtocol === ordered[i - 1].bestProtocol) continue;
    trocas += 1;
    const par = `${ordered[i - 1].bestProtocol} -> ${ordered[i].bestProtocol}`;
    paresContagem.set(par, (paresContagem.get(par) ?? 0) + 1);
    // Chave não ordenada: A->B e B->A são o MESMO vaivém.
    const naoOrdenado = [ordered[i - 1].bestProtocol, ordered[i].bestProtocol].sort().join(" <-> ");
    idaEVoltaContagem.set(naoOrdenado, (idaEVoltaContagem.get(naoOrdenado) ?? 0) + 1);
  }
  const parMaisFrequente = [...idaEVoltaContagem.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

  const avisos: string[] = [];
  if (!enoughSample) {
    avisos.push(
      closed.length === 0
        ? "no leadership change was observed in this window — the duration is a floor, not a measurement"
        : `only ${closed.length} completed leadership spells (minimum ${MIN_CLOSED_SPELLS} to report a median)`,
    );
  }
  if (resolution !== null && medianLead !== null && medianLead <= resolution * 2) {
    avisos.push(
      `median lead (${round2(medianLead)}h) is within twice the observation interval (${round2(resolution)}h) — shorter leads cannot be distinguished`,
    );
  }

  return {
    asset,
    attestations: ordered.length,
    spells: spells.length,
    closedSpells: closed.length,
    medianLeadHours: medianLead,
    meanLeadHours: enoughSample ? round2(durations.reduce((a, c) => a + c, 0) / durations.length) : null,
    longestClosedLeadHours: maiorFechado,
    currentProtocol: ordered[ordered.length - 1].bestProtocol,
    currentLeadHours: round2(correnteHoras),
    currentLeadCensored: maiorFechado === null || correnteHoras >= maiorFechado,
    survival: SURVIVAL_HORIZONS_HOURS.map((h) => ({
      atLeastHours: h,
      rate: enoughSample ? round4(durations.filter((d) => d >= h).length / durations.length) : null,
    })),
    expectedLeadHours: expectedLead,
    observationResolutionHours: resolution !== null ? round2(resolution) : null,
    medianGapBps: gapMediano,
    // gapBps é anual em bps; horas/8760 converte pro trecho da liderança, e
    // US$ 10 mil * bps/10.000 colapsa no produto abaixo.
    edgeValueUsdPer10k:
      expectedLead !== null && gapMediano !== null ? round4((gapMediano * expectedLead) / 8760) : null,
    topSwitchPair: parMaisFrequente?.[0] ?? null,
    roundTripShare: trocas > 0 && parMaisFrequente ? round4(parMaisFrequente[1] / trocas) : null,
    sampleWarning: avisos.length > 0 ? avisos.join("; ") : null,
  };
}

/**
 * Testa se o tamanho da vantagem prevê a duração dela — pergunta empírica, com
 * resposta publicada mesmo quando é NÃO.
 *
 * Medido em 2026-08-10 sobre 167 spells de USDC: ρ = 0,11, e as medianas das
 * quatro faixas ficaram em 1h/2h/2h/2h. Isto é, um gap de 300bps não durou mais
 * que um de 10bps. É informação útil e contraintuitiva: quem usa "gap grande"
 * como atalho pra "sinal confiável" está usando um proxy que os dados negam.
 *
 * Agregado entre assets DE PROPÓSITO: a pergunta é sobre o gap como preditor em
 * geral. O recorte por asset já está em `perAsset`, e separar aqui deixaria
 * WETH e ETH_STAKING com amostra pequena demais pra qualquer correlação.
 */
export function computeGapVsDuration(spells: LeadershipSpell[]): GapVsDuration {
  const closed = spells.filter((s) => s.closed);
  const rho = spearman(
    closed.map((s) => s.startGapBps),
    closed.map((s) => s.hours),
  );

  const bands: GapBand[] = GAP_BAND_EDGES.map((b) => {
    const sel = closed.filter((s) => s.startGapBps >= b.minBps && (b.maxBps === null || s.startGapBps < b.maxBps));
    return {
      label: b.label,
      minBps: b.minBps,
      maxBps: b.maxBps,
      spells: sel.length,
      medianLeadHours: sel.length >= MIN_CLOSED_SPELLS ? median(sel.map((s) => s.hours)) : null,
    };
  });

  const discriminates = rho === null ? null : Math.abs(rho) >= SPEARMAN_DISCRIMINATION_THRESHOLD;
  return {
    spearman: rho,
    n: closed.length,
    bands,
    discriminates,
    note:
      discriminates === null
        ? "not enough completed spells to test whether the size of the lead predicts how long it lasts"
        : discriminates
          ? "the size of the lead does predict how long it lasts in this window — larger gaps held longer"
          : "the size of the lead does NOT predict how long it lasts: a wide gap was no more durable than a narrow one. Do not use gap size as a proxy for reliability.",
  };
}

/** Relatório completo. Puro: mesma entrada, mesma saída (fora `computedAt`). */
export function computePersistence(
  attestations: DecodedSignalAttestation[],
  now: Date = new Date(),
): PersistenceReport {
  const spells = buildSpells(attestations);
  const assets = Array.from(new Set(attestations.map((a) => a.asset)));
  const times = attestations.map((a) => a.time);

  return {
    basis: "leadership-spells-from-onchain-attestations",
    observedFrom: times.length > 0 ? new Date(Math.min(...times) * 1000).toISOString() : null,
    observedTo: times.length > 0 ? new Date(Math.max(...times) * 1000).toISOString() : null,
    observedDays: times.length > 0 ? round2((Math.max(...times) - Math.min(...times)) / 86400) : null,
    totalAttestations: attestations.length,
    perAsset: assets.map((asset) =>
      persistenceForAsset(
        asset,
        attestations.filter((a) => a.asset === asset),
        spells.filter((s) => s.asset === asset),
      ),
    ),
    gapVsDuration: computeGapVsDuration(spells),
    computedAt: now.toISOString(),
  };
}

/**
 * Duração de liderança que o /decision usa pra limitar o horizonte do ganho.
 * Atalho de leitura sobre o relatório — a REGRA mora em `persistenceForAsset`
 * (campo `expectedLeadHours`), pra o número vendido na rota e o número usado na
 * decisão serem necessariamente o mesmo.
 *
 * `null` quando não há base: aí o /decision não desconta nada, mas declara que
 * não descontou, em vez de projetar durabilidade que ninguém mediu.
 */
export function leadHoursForDecision(report: PersistenceReport | null, asset: AssetId): number | null {
  return report?.perAsset.find((a) => a.asset === asset)?.expectedLeadHours ?? null;
}
