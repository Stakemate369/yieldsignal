import type { AssetId, ProtocolId } from "../market-data/types.js";

/**
 * EXPOSIÇÃO COMPARTILHADA — "eu estou em N protocolos, mas atrás de quantos
 * riscos distintos?"
 *
 * A tese não é teórica, é o mecanismo de perda mais caro de 2025-2026. No
 * colapso da Stream Finance, US$ 93M de prejuízo viraram US$ 285M de contágio
 * porque APENAS 1 de ~320 vaults MetaMorpho tinha exposição direta ao xUSD — o
 * resto chegou lá por caminho indireto que os depositantes não enxergavam. O
 * evento era público em horas; o que quebrou gente foi não saber que estava a
 * dois ou três saltos dele.
 *
 * O mercado já tem detector de EVENTO de sobra (alerta de depeg, de hack, de
 * liquidação) e quase todo gratuito. O que ninguém entrega é a pergunta
 * anterior: "isso me atinge, e por onde?".
 *
 * Medido em 2026-08-06 na Base: o vault de USDC do Morpho tem 93,7% atrás de
 * cbBTC e o mercado de USDC da Compound tem 43,1% — quem está nos dois comprou
 * duas embalagens do mesmo risco. Nada aqui é estimativa de correlação: é a
 * afirmação estrutural "estas posições dependem da mesma coisa", que é um fato
 * lido, não um coeficiente estimado. Dizer o quanto elas se movem juntas
 * exigiria histórico de preço que este serviço não tem — e seria outra
 * afirmação, mais fraca.
 *
 * DELIBERADAMENTE FORA: detecção de colateral recursivo. Checado ao vivo em
 * 2026-08-06 sobre os 77 mercados vivos do Morpho na Base — zero ciclos e zero
 * ativos que sejam colateral E emprestado ao mesmo tempo. Pior: a recursão da
 * Stream não estava no grafo de empréstimo, estava na EMISSÃO do sintético
 * (xUSD lastreado por posições financiadas com o USDC tomado). Um detector de
 * ciclo teria dito "tudo limpo" durante o colapso inteiro — falsa segurança,
 * que é pior que alarme falso.
 */

export type FactorKind = "collateral" | "curator" | "oracle" | "rate-kink";

/**
 * COMO a atribuição foi obtida — mesma disciplina de `tvlBasis`/`apyBasis`, e
 * aqui ela é ainda mais necessária porque os três protocolos têm TOPOLOGIAS DE
 * RISCO DIFERENTES e "exposição a colateral" não significa a mesma coisa nos
 * três:
 * - `isolated-market`: mercado isolado com um colateral só (Morpho Blue). A
 *   atribuição é exata.
 * - `collateral-basket`: um ativo base contra uma cesta definida, com os pesos
 *   REAIS do que está postado (Compound v3, via `totalsCollateral`). Exata na
 *   composição atual, mas ela muda conforme mutuários entram e saem.
 * - `protocol-parameter`: o fator é um parâmetro do próprio protocolo (ex.: o
 *   joelho da curva de juros), não uma fatia de capital.
 */
export type FactorBasis = "isolated-market" | "collateral-basket" | "protocol-parameter";

export interface ProtocolFactor {
  kind: FactorKind;
  /** Identificador estável do fator: símbolo, endereço ou valor do parâmetro. */
  key: string;
  /** Fatia da posição NAQUELE protocolo atribuída a este fator (0 a 1). */
  share: number;
  basis: FactorBasis;
}

export interface ProtocolExposure {
  protocol: ProtocolId;
  /**
   * COMPOSIÇÃO — atrás de que ativos/oráculos/curador o capital está. `null` =
   * não foi possível atribuir, e `unattributedReason` diz por quê.
   */
  factors: ProtocolFactor[] | null;
  /**
   * PARÂMETROS do protocolo (hoje: o joelho da curva de juros). Separados da
   * composição de propósito, e a razão é uma armadilha de contabilidade real:
   * a Aave não tem composição legível mas TEM joelho legível. Se o joelho
   * entrasse na mesma lista, a posição em Aave contaria como "atribuída",
   * entraria no denominador dos percentuais de colateral e faria a
   * concentração parecer menor — escondendo exatamente o que precisava
   * aparecer, que é "a composição da Aave é desconhecida".
   */
  parameters: ProtocolFactor[];
  unattributedReason: string | null;
}

export interface AggregatedFactor {
  kind: FactorKind;
  key: string;
  usd: number;
  /**
   * Percentual sobre o capital ATRIBUÍDO, não sobre o total. Sobre o total
   * daria um número menor e enganoso numa carteira com muito não-atribuído:
   * pareceria pouca concentração quando na verdade é pouca visibilidade.
   * `coverage` diz quanto do capital entrou nesta conta.
   */
  pctOfAttributed: number;
  /** Por quais protocolos essa exposição chega. */
  via: ProtocolId[];
  /** `true` quando o mesmo fator chega por mais de um protocolo. */
  sharedAcrossVenues: boolean;
  bases: FactorBasis[];
}

export interface ExposureReport {
  asset: AssetId;
  basis: "declared-positions";
  totalUsd: number;
  /** Quantos protocolos distintos a carteira declara — o número que ILUDE. */
  nominalVenues: number;
  /**
   * Maior fator por capital atribuído. É a manchete: "você está em N venues,
   * mas X% do que dá pra atribuir está atrás disto".
   */
  topFactor: AggregatedFactor | null;
  factors: AggregatedFactor[];
  /**
   * Parâmetros compartilhados entre venues — hoje o joelho da curva. Contados
   * sobre TODAS as posições onde o parâmetro foi legível, independente de a
   * composição ter sido atribuída. É o que revela que uma carteira dividida
   * entre Aave e Compound não está diversificada contra choque de utilização:
   * os dois reprecificam no mesmo 90%.
   */
  sharedParameters: AggregatedFactor[];
  unattributed: { protocol: ProtocolId; usd: number; reason: string }[];
  coverage: { attributedUsd: number; totalUsd: number };
  asOf: string;
}

export interface DeclaredPosition {
  protocol: ProtocolId;
  usd: number;
}

function keyOf(f: { kind: FactorKind; key: string }): string {
  return `${f.kind}:${f.key}`;
}

/**
 * Pura, sem I/O — mesma disciplina dos outros módulos de sinal. Recebe as
 * posições declaradas pelo comprador e os fatores já lidos por protocolo.
 *
 * Posição de protocolo sem fator entra em `unattributed` com o motivo, e o
 * capital dela NÃO entra em nenhum percentual: contar um protocolo cuja
 * composição não foi lida como se fosse um fator próprio inventaria
 * diversificação que ninguém mediu.
 */
export function computeExposure(
  asset: AssetId,
  positions: DeclaredPosition[],
  exposures: Map<ProtocolId, ProtocolExposure>,
  now: Date = new Date(),
): ExposureReport {
  const valid = positions.filter((p) => Number.isFinite(p.usd) && p.usd > 0);
  const totalUsd = valid.reduce((s, p) => s + p.usd, 0);

  const unattributed: ExposureReport["unattributed"] = [];
  const acc = new Map<string, AggregatedFactor>();
  const params = new Map<string, AggregatedFactor>();
  let attributedUsd = 0;
  let parameterUsd = 0;

  function add(into: Map<string, AggregatedFactor>, f: ProtocolFactor, protocol: ProtocolId, usd: number): void {
    const k = keyOf(f);
    const existing = into.get(k);
    if (existing) {
      existing.usd += usd;
      if (!existing.via.includes(protocol)) existing.via.push(protocol);
      if (!existing.bases.includes(f.basis)) existing.bases.push(f.basis);
      return;
    }
    into.set(k, {
      kind: f.kind,
      key: f.key,
      usd,
      pctOfAttributed: 0,
      via: [protocol],
      sharedAcrossVenues: false,
      bases: [f.basis],
    });
  }

  for (const pos of valid) {
    const exposure = exposures.get(pos.protocol);

    // Parâmetros contam mesmo quando a composição não foi atribuída — são
    // legíveis de forma independente e não entram no denominador da composição.
    for (const p of exposure?.parameters ?? []) {
      add(params, p, pos.protocol, pos.usd * p.share);
      parameterUsd += pos.usd * p.share;
    }

    if (!exposure || exposure.factors === null || exposure.factors.length === 0) {
      unattributed.push({
        protocol: pos.protocol,
        usd: pos.usd,
        reason: exposure?.unattributedReason ?? "no factor data read for this protocol",
      });
      continue;
    }
    attributedUsd += pos.usd;
    for (const f of exposure.factors) add(acc, f, pos.protocol, pos.usd * f.share);
  }

  const finish = (m: Map<string, AggregatedFactor>, denominator: number): AggregatedFactor[] =>
    [...m.values()]
      .map((f) => ({
        ...f,
        pctOfAttributed: denominator > 0 ? Math.round((f.usd / denominator) * 1000) / 10 : 0,
        usd: Math.round(f.usd),
        sharedAcrossVenues: f.via.length > 1,
      }))
      .sort((a, b) => b.usd - a.usd);

  const factors = finish(acc, attributedUsd);
  const sharedParameters = finish(params, parameterUsd);

  // A manchete olha só colateral e curador: o joelho é parâmetro compartilhado
  // por desenho (Aave e Compound usam 90% os dois), então liderar com ele seria
  // verdadeiro e inútil como alerta — sai em `sharedParameters`, à parte.
  const headline = factors.find((f) => f.kind === "collateral" || f.kind === "curator") ?? null;

  return {
    asset,
    basis: "declared-positions",
    totalUsd: Math.round(totalUsd),
    nominalVenues: new Set(valid.map((p) => p.protocol)).size,
    topFactor: headline,
    factors,
    sharedParameters,
    unattributed,
    coverage: { attributedUsd: Math.round(attributedUsd), totalUsd: Math.round(totalUsd) },
    asOf: now.toISOString(),
  };
}
