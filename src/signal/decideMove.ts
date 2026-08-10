import type { ProtocolId, RateReading } from "../market-data/types.js";
import { RISK_WEIGHTS } from "../strategy/riskWeights.js";
import { computeSignal, type YieldSignal, type SignalRate } from "./computeSignal.js";

/**
 * CAMADA 1 do produto premium: vende a DECISÃO, não o dado.
 *
 * `computeSignal` responde "qual protocolo paga o melhor juro ajustado por
 * risco agora" — um dado que a DefiLlama dá de graça. O que um agente que
 * aloca dinheiro real quer comprar é a resposta de "vale a pena eu MOVER meu
 * dinheiro pra lá, AGORA, considerando meu custo de gas e meu horizonte?".
 * Isso é uma decisão, não um número — e é o que esta camada gera.
 *
 * Reaproveita a mesma matemática de break-even já validada em produção no
 * YieldPilot (strategy/breakeven.ts): o ganho esperado no horizonte tem que
 * superar o custo de mover. O YieldSignal não guarda posição do comprador entre
 * chamadas — o comprador informa a posição atual dele a cada chamada.
 *
 * A HISTERESE entra por outro caminho (2026-08-10): não como memória da posição,
 * mas como memória do MERCADO — quanto a liderança do destino costumou durar,
 * medida no registro on-chain. Ver `MoveDecisionInput.expectedLeadHours`.
 */

export type MoveAction = "MOVE" | "HOLD";
export type Confidence = "high" | "medium" | "low";

/**
 * A partir de que fatia do mercado de destino a posição do comprador deixa de
 * ser irrelevante pra taxa que ele está perseguindo. Acima disso, a entrada
 * dele dilui o próprio rendimento (e, num mercado de incentivo, divide a
 * campanha com menos gente por token). 5% é conservador e explícito — o
 * objetivo não é decidir por ele, é não esconder a informação, que era o que
 * acontecia enquanto o TVL era lido e descartado.
 */
export const POSITION_CROWDING_THRESHOLD_PCT = 5;

export interface MoveDecisionInput {
  /** Onde o capital do comprador está agora. `null`/ausente = capital ocioso (rende 0). */
  currentProtocol: ProtocolId | null;
  /** Tamanho da posição em USD — escala o ganho absoluto e o break-even. */
  amountUsd: number;
  /** Custo estimado de mover (gas + eventual slippage), em USD. O comprador conhece o próprio custo melhor que nós. */
  moveCostUsd: number;
  /** Por quantos dias o comprador espera manter a posição antes de reavaliar. Ganho só conta até aqui. */
  horizonDays: number;
  /**
   * HISTERESE — por quantas horas a liderança do destino costumou durar, medida
   * no registro on-chain (attestation/persistence.ts). Quando informada, o ganho
   * para de ser projetado no horizonte inteiro do comprador e passa a ser
   * projetado só enquanto a vantagem historicamente existiu.
   *
   * Por que (medido em 2026-08-10, 439 atestações / 24 dias): a liderança do
   * USDC durou 2h (mediana de 167 trocas, metade delas vaivém entre os mesmos
   * dois protocolos), a do WETH não trocou nenhuma vez em 518h. Projetar
   * "+40bps por 30 dias" sobre uma vantagem que morre em duas horas superestima
   * o ganho em três ordens de grandeza e empurra o comprador pra um MOVE que só
   * paga gas — o erro mais caro que este produto pode cometer.
   *
   * `null`/ausente = sem base histórica: o horizonte do comprador é usado
   * inteiro (comportamento anterior), mas a resposta DECLARA que não houve
   * desconto, em vez de deixar parecer que a durabilidade foi verificada.
   */
  expectedLeadHours?: number | null;
}

export interface MoveDecision {
  asset: YieldSignal["asset"];
  action: MoveAction;
  /** Protocolo de origem (posição atual do comprador). `null` se capital ocioso. */
  from: ProtocolId | null;
  /** Protocolo de destino recomendado (o melhor ajustado por risco). */
  to: ProtocolId;
  /** Ganho de APY líquido (ajustado por risco) de sair de `from` e entrar em `to`, em bps. Capital ocioso: é o APY inteiro do destino. */
  netApyGainBps: number;
  /** Ganho absoluto esperado no horizonte EFETIVO, DEPOIS de descontar `moveCostUsd`. Positivo => mover compensa. */
  expectedNetGainUsd: number;
  /**
   * Horizonte de fato usado na conta: o menor entre o que o comprador pediu e
   * quanto a liderança do destino historicamente durou. Igual a `horizonDays`
   * quando não há histórico ou quando a liderança dura mais que o pedido.
   */
  effectiveHorizonDays: number;
  /** O horizonte do comprador foi encurtado pela durabilidade medida? */
  horizonLimitedByPersistence: boolean;
  /**
   * Quantas horas a liderança do destino durou historicamente. `null` = não
   * medido — e então nenhum desconto foi aplicado.
   */
  expectedLeadHours: number | null;
  /** Dias até o ganho pagar o custo de mover. `null` se não há ganho positivo (nunca paga). */
  breakEvenDays: number | null;
  /**
   * A vantagem do destino sobre a origem some se a campanha de incentivo do
   * destino encerrar? `true` = o MOVE só se paga enquanto a campanha durar.
   * `null` = não dá pra apurar (a fonte não separou o incentivo do destino).
   */
  gainDependsOnIncentives: boolean | null;
  /**
   * Quanto da posição do comprador representaria do mercado de destino. Acima
   * de uns poucos por cento, a própria entrada dele derruba a taxa que motivou
   * a mudança — a recomendação segue de pé, mas com essa ressalva explícita.
   * `null` se a profundidade do destino não foi apurável.
   */
  positionShareOfDestinationPct: number | null;
  confidence: Confidence;
  reason: string;
  /** O sinal bruto que embasa a decisão — o comprador pode auditar os números. */
  signal: YieldSignal;
}

/**
 * Confiança na recomendação, derivada de sinais objetivos (não é um número
 * inventado): (1) quão à frente o melhor está do 2º colocado — um gap grande
 * é uma vantagem clara, um gap de 1-2bps é ruído; (2) a fonte do melhor —
 * leitura on-chain direta (Camada 1) é mais confiável que agregador
 * (DefiLlama, Camada 2). O peso de risco do protocolo já entrou no
 * weightedApy, então não é recontado aqui.
 */
export function confidenceFor(rates: SignalRate[]): Confidence {
  const [best, second] = rates;
  if (!best) return "low";
  const gapToSecond = second ? best.weightedApyBps - second.weightedApyBps : best.weightedApyBps;
  const directSource = best.source === "onchain" || best.source === "api";

  // (3) Incentivo desconhecido em algum CONCORRENTE derruba a confiança do teto:
  // a APY dele é base-only, então é um PISO — se houver campanha ativa que a
  // fonte não separou, o ranking pode estar invertido e não dá pra saber por
  // quanto. No líder isso não incomoda (subestimar o líder não tira a liderança
  // dele), por isso a checagem é só nos demais.
  const challengerRewardUnknown = rates.slice(1).some((r) => r.rewardBasis === "unavailable");

  // (4) Liderança que só existe por causa de campanha de incentivo não é uma
  // afirmação forte: campanha termina de uma semana pra outra, juro base não.
  if (gapToSecond >= 50 && directSource && !challengerRewardUnknown && !leadDependsOnIncentives(rates)) return "high";
  if (gapToSecond >= 20) return "medium";
  return "low";
}

/**
 * A liderança do 1º colocado depende do incentivo dele? Isto é, tirando a
 * campanha, ele deixaria de ser o melhor?
 *
 * Existe porque a própria correção que passou a somar incentivo (2026-07-30)
 * mudou o vencedor de WETH: a Euler foi ao topo com 2,91%, dos quais 1,72 ponto
 * era campanha, num pool de US$ 716 mil. O número está certo pela base
 * declarada — é o que o comprador recebe HOJE —, mas uma vantagem que evapora
 * quando a campanha encerra não merece o mesmo grau de confiança que uma
 * vantagem de juro base. O ranking NÃO é alterado (o produto promete APY total,
 * e mudar isso em silêncio seria vender outra coisa); o que muda é o quanto o
 * serviço se compromete com a recomendação.
 *
 * `apyRewardBps` desconhecido no líder é tratado como zero: sem dado, não dá
 * pra afirmar dependência — e inventar dependência rebaixaria a confiança à toa.
 */
export function leadDependsOnIncentives(rates: SignalRate[]): boolean {
  const [best, second] = rates;
  if (!best || !second) return false;
  if (!best.apyRewardBps || best.apyBps <= 0) return false;
  // O peso de risco já está embutido no weightedApyBps; aplico a mesma
  // proporção ao componente de incentivo pra comparar na mesma escala.
  const weightedReward = (best.apyRewardBps / best.apyBps) * best.weightedApyBps;
  return best.weightedApyBps - weightedReward < second.weightedApyBps;
}

/**
 * Núcleo determinístico — sem I/O, testável com fixtures. Recebe as leituras
 * já coletadas (mesmo padrão de computeSignal) mais o contexto do comprador,
 * e devolve MOVE ou HOLD com a conta explícita por trás.
 */
export function decideMove(readings: RateReading[], input: MoveDecisionInput): MoveDecision {
  const signal = computeSignal(readings);
  const best = signal.rates[0];

  // Dois casos distintos de "sem taxa de referência":
  //  - currentProtocol === null: comprador está OCIOSO (não tem posição) —
  //    a referência é 0 e faz sentido recomendar deployar o capital.
  //  - currentProtocol setado mas NÃO lido nesta chamada (fonte falhou agora):
  //    não dá pra comparar honestamente. Tratar como 0 inflaria o ganho e
  //    empurraria um MOVE às cegas — o certo é HOLD com aviso (ver branch
  //    "positionUnreadable" abaixo). Bug corrigido em auto-revisão 2026-07-21.
  const positionUnreadable =
    input.currentProtocol !== null &&
    signal.rates.find((r) => r.protocol === input.currentProtocol) === undefined;

  const currentRate = input.currentProtocol === null
    ? 0
    : signal.rates.find((r) => r.protocol === input.currentProtocol)?.weightedApyBps ?? 0;

  // netApyGain: quanto o destino rende a mais que a origem, já ajustado por
  // risco. (No caso ilegível o valor é irrelevante — o branch abaixo força HOLD.)
  const netApyGainBps = best.weightedApyBps - currentRate;

  const annualGainUsd = (input.amountUsd * netApyGainBps) / 10_000;

  // HISTERESE. O desconto vale pro ganho que é uma VANTAGEM SOBRE OUTRA
  // POSIÇÃO — essa vantagem é que evapora quando a liderança gira. Capital
  // OCIOSO é caso diferente: quem sai de 0% e entra num protocolo passa a
  // receber a taxa do mercado e continua recebendo depois de o ranking mudar,
  // então encurtar o horizonte ali subestimaria o ganho real e faria o serviço
  // recomendar deixar dinheiro parado. Desconto só quando há posição de origem.
  const leadHours =
    input.expectedLeadHours !== null &&
    input.expectedLeadHours !== undefined &&
    Number.isFinite(input.expectedLeadHours) &&
    input.expectedLeadHours > 0
      ? input.expectedLeadHours
      : null;
  const persistenceApplies = leadHours !== null && input.currentProtocol !== null;
  const leadDays = persistenceApplies ? (leadHours as number) / 24 : null;
  const effectiveHorizonDays = leadDays !== null ? Math.min(input.horizonDays, leadDays) : input.horizonDays;
  const horizonLimitedByPersistence = effectiveHorizonDays < input.horizonDays;

  const gainInHorizonUsd = annualGainUsd * (effectiveHorizonDays / 365);
  const expectedNetGainUsd = gainInHorizonUsd - input.moveCostUsd;

  // break-even em dias: custo / ganho-diário. Só definido se há ganho positivo.
  const dailyGainUsd = annualGainUsd / 365;
  const breakEvenDays = dailyGainUsd > 0 ? input.moveCostUsd / dailyGainUsd : null;

  // Dependência de campanha: mede o ganho SOBRE A ORIGEM (não a liderança em
  // si) — é essa a conta que o comprador faz ao decidir mover. Se o ganho só
  // existe por causa do incentivo do destino, mover é uma aposta no calendário
  // da campanha, não na taxa.
  const gainDependsOnIncentives =
    positionUnreadable || best.apyRewardBps === null || best.apyBps <= 0
      ? null
      : netApyGainBps > 0 && netApyGainBps <= (best.apyRewardBps / best.apyBps) * best.weightedApyBps;

  const positionShareOfDestinationPct =
    best.tvlUsd !== null && best.tvlUsd > 0 ? Math.round(((input.amountUsd / best.tvlUsd) * 100 + Number.EPSILON) * 100) / 100 : null;
  const crowdsDestination =
    positionShareOfDestinationPct !== null && positionShareOfDestinationPct >= POSITION_CROWDING_THRESHOLD_PCT;

  // A confiança nunca SOBE por causa destes fatores, só desce: os dois são
  // motivos pra desconfiar de uma recomendação, nunca pra reforçá-la.
  const baseConfidence = positionUnreadable ? "low" : confidenceFor(signal.rates);
  const confidence: Confidence = crowdsDestination && baseConfidence === "high" ? "medium" : baseConfidence;
  const alreadyThere = input.currentProtocol !== null && input.currentProtocol === best.protocol;

  let action: MoveAction;
  let reason: string;

  // Horizonte de 2h vira "0.08 days", que não se lê. Abaixo de um dia a frase
  // sai em horas — é a mesma grandeza, escrita de um jeito que o comprador
  // (humano ou LLM) consegue conferir.
  const prazo = (dias: number): string =>
    dias < 1 ? `${(dias * 24).toFixed(1)}h` : `${dias.toFixed(dias < 10 ? 1 : 0)} days`;

  // As duas faces da histerese: quando encurtou, dizer por quê; quando não
  // havia base pra encurtar, dizer que não havia — calar sobre isso deixaria
  // parecer que a durabilidade foi verificada e deu longa.
  const persistenceNote = horizonLimitedByPersistence
    ? ` Gain is projected over ${prazo(effectiveHorizonDays)}, not the ${input.horizonDays} days you asked for: ${best.protocol}'s lead in this market has historically lasted about ${(leadHours as number).toFixed(1)}h (measured from on-chain attestations, see /persistence), and the edge is not assumed to outlive it.`
    : "";
  const noPersistenceNote =
    leadHours === null && input.currentProtocol !== null
      ? ` Note: no measured leadership durability was available for this asset, so the gain is projected over your full horizon with no persistence discount — treat it as an upper bound.`
      : "";

  // `reason` é vendido ao robô-comprador (superfície internacional) — em
  // inglês pra bater com o resto do produto (descrições de rota, sinal,
  // README, plugins). Comentários seguem em pt pro dono/mantenedor.
  if (positionUnreadable) {
    action = "HOLD";
    reason = `Could not read your current position (${input.currentProtocol}) on this call — without a reliable comparison it is not safe to recommend moving. HOLD (retry shortly).`;
  } else if (alreadyThere) {
    action = "HOLD";
    reason = `Already in the best risk-adjusted protocol (${best.protocol}). Nothing to move.`;
  } else if (netApyGainBps <= 0) {
    action = "HOLD";
    reason = `Your current position already yields the same or more than the best alternative on a risk-adjusted basis (gain of ${netApyGainBps}bps). Moving would only cost gas. HOLD.`;
  } else if (expectedNetGainUsd <= 0) {
    action = "HOLD";
    const beStr =
      breakEvenDays !== null
        ? ` (break-even in ~${prazo(breakEvenDays)}, past the ${prazo(effectiveHorizonDays)} the edge is expected to last)`
        : "";
    reason = `The ${netApyGainBps}bps gain does not cover the move cost ($${input.moveCostUsd.toFixed(4)}) over ${prazo(effectiveHorizonDays)}${beStr}. HOLD.${persistenceNote}`;
  } else {
    action = "MOVE";
    // As ressalvas entram na FRASE, não só no objeto: quem consome via LLM lê o
    // `reason`, e uma recomendação de mover para um mercado raso ou para uma
    // taxa que depende de campanha precisa vir com isso colado nela.
    const incentiveCaveat = gainDependsOnIncentives
      ? ` Note: the entire gain rests on ${best.protocol}'s incentive campaign (${best.apyRewardBps}bps of its ${best.apyBps}bps) — it disappears if the campaign ends.`
      : "";
    const depthCaveat = crowdsDestination
      ? ` Note: your $${input.amountUsd.toLocaleString("en-US")} would be ${positionShareOfDestinationPct}% of ${best.protocol}'s $${Math.round(best.tvlUsd as number).toLocaleString("en-US")} market — large enough that entering dilutes the rate you are moving for.`
      : "";
    reason = `Moving ${input.currentProtocol ?? "idle capital"} → ${best.protocol} yields +${netApyGainBps}bps risk-adjusted; estimated net gain of $${expectedNetGainUsd.toFixed(4)} over ${prazo(effectiveHorizonDays)} after the move cost${breakEvenDays !== null ? ` (break-even in ~${prazo(breakEvenDays)})` : ""}.${persistenceNote}${noPersistenceNote}${incentiveCaveat}${depthCaveat}`;
  }

  return {
    asset: signal.asset,
    action,
    from: input.currentProtocol,
    to: best.protocol,
    netApyGainBps,
    expectedNetGainUsd,
    effectiveHorizonDays,
    horizonLimitedByPersistence,
    expectedLeadHours: leadHours,
    breakEvenDays,
    gainDependsOnIncentives,
    positionShareOfDestinationPct,
    confidence,
    reason,
    signal,
  };
}

// Reexporta pra quem consome só o tipo do peso sem importar riskWeights direto.
export { RISK_WEIGHTS };
