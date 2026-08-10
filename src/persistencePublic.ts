import type { PersistenceReport, AssetPersistence, GapVsDuration } from "./attestation/persistence.js";

/**
 * RECORTE PÚBLICO da persistência — o artefato gratuito.
 *
 * Mesma divisão que já rege `/accuracy.json`: **a prova é grátis, a ação é
 * paga**. Aqui a linha cai entre PASSADO e AGORA.
 *
 * Grátis (passado, agregado, citável): quanto uma liderança durou, a curva de
 * sobrevivência, quanto do rodízio é vaivém entre o mesmo par, e o achado de
 * que o tamanho da vantagem não prevê a durabilidade dela. É pesquisa — serve
 * pra ser lida, linkada e conferida por terceiro contra o EAS, e é isso que faz
 * alguém descobrir que este serviço existe.
 *
 * Pago (agora): QUEM lidera neste instante e há quanto tempo. Esse é o produto.
 * Publicar `currentProtocol` de graça entregaria a resposta que `/signal` vende
 * por $0.10 — o artefato de divulgação canibalizaria o catálogo que ele existe
 * pra divulgar.
 *
 * `expectedLeadHours` também fica fora: é o número que o `/decision` consome
 * pra encurtar o horizonte, ou seja, a peça acionável. Quem quiser reproduzi-lo
 * consegue — a mediana está aqui e a regra está documentada —, mas reproduzir
 * exige entender, e é essa a fronteira certa entre prova e produto.
 */

export interface PublicAssetPersistence {
  asset: string;
  attestations: number;
  spells: number;
  closedSpells: number;
  medianLeadHours: number | null;
  meanLeadHours: number | null;
  longestClosedLeadHours: number | null;
  survival: { atLeastHours: number; rate: number | null }[];
  observationResolutionHours: number | null;
  medianGapBps: number | null;
  /** Vaivém: fatia das trocas de líder que é o mesmo par indo e voltando. */
  topSwitchPair: string | null;
  roundTripShare: number | null;
  /** A liderança corrente ainda não terminou — as durações acima são piso. */
  leadStillOpen: boolean;
  sampleWarning: string | null;
}

export interface PublicPersistenceReport {
  basis: PersistenceReport["basis"];
  observedFrom: string | null;
  observedTo: string | null;
  observedDays: number | null;
  attestationsInWindow: number;
  perAsset: PublicAssetPersistence[];
  gapVsDuration: GapVsDuration;
  /** Como qualquer terceiro refaz esta conta sem confiar neste servidor. */
  reproduce: {
    source: string;
    schemaUid: string | null;
    attester: string;
    note: string;
  };
  paidDetail: {
    note: string;
    routes: string[];
  };
  computedAt: string;
}

function publicAsset(a: AssetPersistence): PublicAssetPersistence {
  return {
    asset: String(a.asset),
    attestations: a.attestations,
    spells: a.spells,
    closedSpells: a.closedSpells,
    medianLeadHours: a.medianLeadHours,
    meanLeadHours: a.meanLeadHours,
    longestClosedLeadHours: a.longestClosedLeadHours,
    survival: a.survival,
    observationResolutionHours: a.observationResolutionHours,
    medianGapBps: a.medianGapBps,
    topSwitchPair: a.topSwitchPair,
    roundTripShare: a.roundTripShare,
    leadStillOpen: a.currentLeadCensored,
    sampleWarning: a.sampleWarning,
  };
}

export function toPublicPersistence(
  report: PersistenceReport,
  meta: { schemaUid: string | null; attester: string; paidRoutes: string[] },
): PublicPersistenceReport {
  return {
    basis: report.basis,
    observedFrom: report.observedFrom,
    observedTo: report.observedTo,
    observedDays: report.observedDays,
    attestationsInWindow: report.totalAttestations,
    perAsset: report.perAsset.map(publicAsset),
    gapVsDuration: report.gapVsDuration,
    reproduce: {
      source: "https://base.easscan.org/graphql",
      schemaUid: meta.schemaUid,
      attester: meta.attester,
      note: "Query this schema and attester, group consecutive attestations by bestProtocol per asset, and every figure above follows. Nothing here depends on trusting this server.",
    },
    paidDetail: {
      note: "Which protocol leads right now, how long it has already led, and the lead duration applied to MOVE/HOLD decisions are the paid part.",
      routes: meta.paidRoutes,
    },
    computedAt: report.computedAt,
  };
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ASSET_LABELS: Record<string, string> = {
  ETH_STAKING: "ETH liquid staking (Ethereum)",
  USDC: "USDC lending (Base)",
  WETH: "WETH lending (Base)",
};

function h(value: number | null): string {
  if (value === null) return "—";
  return `${value % 1 === 0 ? value : value.toFixed(1)}h`;
}

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/**
 * Página HUMANA do relatório, renderizada do dado real a cada carga — nunca
 * número escrito à mão, mesma disciplina da página inicial e do track record.
 *
 * Marcada como `Dataset` em JSON-LD de propósito: isto é uma série de medições
 * reprodutíveis com fonte pública, e é assim que buscadores de dado (e
 * rastreadores de LLM) sabem tratá-la. É o único formato de divulgação que este
 * projeto pode emitir sem depender da boa vontade de plataforma de terceiro.
 */
export function renderPersistencePage(report: PublicPersistenceReport | null): string {
  const linhas = (report?.perAsset ?? [])
    .slice()
    .sort((a, b) => (b.medianLeadHours ?? Number.POSITIVE_INFINITY) - (a.medianLeadHours ?? Number.POSITIVE_INFINITY))
    .map((a) => {
      const rotulo = esc(ASSET_LABELS[a.asset] ?? a.asset);
      const duracao = a.medianLeadHours === null && a.leadStillOpen ? "never changed" : h(a.medianLeadHours);
      const s24 = a.survival.find((s) => s.atLeastHours === 24)?.rate ?? null;
      return `<tr><td><code>${esc(a.asset)}</code> — ${rotulo}</td><td>${a.closedSpells === 0 ? "0" : a.closedSpells}</td><td>${duracao}</td><td>${pct(s24)}</td><td>${pct(a.roundTripShare)}</td><td>${a.attestations}</td></tr>`;
    })
    .join("\n    ");

  const g = report?.gapVsDuration;
  const bandas = (g?.bands ?? [])
    .map((b) => `<tr><td><code>${esc(b.label)}</code></td><td>${b.spells}</td><td>${h(b.medianLeadHours)}</td></tr>`)
    .join("\n    ");

  const corpo = report
    ? `<p class="lede">How long does a “best yield” answer actually stay true? This page measures it on ${report.attestationsInWindow} timestamped attestations published to Base mainnet over ${report.observedDays ?? "—"} days — the service's own past calls, scored against what happened next.</p>

<table>
  <thead><tr><th>Market</th><th>Leadership changes</th><th>Median time on top</th><th>Lasted ≥24h</th><th>Round-trip share</th><th>Attestations</th></tr></thead>
  <tbody>
    ${linhas}
  </tbody>
</table>
<p class="note"><strong>Round-trip share</strong> is how much of the rotation is the same two protocols trading places — churn rather than genuine change. A market where the leader flips every couple of hours, half the time back to where it came from, is not offering an edge worth paying gas for.</p>

<h2>Does a bigger lead last longer?</h2>
<p><strong>${g?.discriminates === false ? "No." : g?.discriminates === true ? "Yes, in this window." : "Not enough data yet."}</strong> ${esc(g?.note ?? "")} Measured across ${g?.n ?? 0} completed leadership spells${g?.spearman !== null && g?.spearman !== undefined ? ` (Spearman ${g.spearman})` : ""}.</p>
<table>
  <thead><tr><th>Lead at the start of the spell</th><th>Spells</th><th>Median duration</th></tr></thead>
  <tbody>
    ${bandas}
  </tbody>
</table>
<p class="note">This one is published because it is <em>inconvenient</em>: a wide gap reads like a confident signal, and the data says it is not more durable than a narrow one. Anyone using gap size as a proxy for reliability — including anyone using this service — is using a proxy that does not hold.</p>

<h2>Check it yourself</h2>
<p>Every input is a public attestation on Base mainnet. Query <a href="${esc(report.reproduce.source)}">${esc(report.reproduce.source)}</a> for attester <code>${esc(report.reproduce.attester)}</code>${report.reproduce.schemaUid ? ` and schema <code>${esc(report.reproduce.schemaUid)}</code>` : ""}, group consecutive attestations by leader per asset, and you get these numbers. ${esc(report.reproduce.note)} Machine-readable at <a href="/persistence.json"><code>/persistence.json</code></a>.</p>
<p class="note">Honest limits, stated here rather than buried: the observation interval is ${h(report.perAsset[0]?.observationResolutionHours ?? null)}, so leads shorter than that cannot be distinguished; a market whose leader has not changed reports a floor, never a median; and every figure carries its sample size, with “—” wherever the sample is too small to support a number.</p>

<h2>What is paid</h2>
<p>${esc(report.paidDetail.note)} ${report.paidDetail.routes.map((r) => `<code>${esc(r)}</code>`).join(", ")} — priced in the <code>402</code> challenge, payable per call over <a href="https://x402.org">x402</a> with no account. The history above stays free: it is the evidence, and evidence behind a paywall proves nothing.</p>`
    : `<p class="lede">The attested history could not be read on this request. Nothing is shown rather than something stale — <a href="/persistence.json"><code>/persistence.json</code></a> carries the machine-readable version when it recovers.</p>`;

  const dataset = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Leadership persistence in Base lending and ETH liquid staking",
    description:
      "How long a best-yield call stays true, measured from timestamped on-chain attestations (EAS, Base mainnet): median leadership duration, survival curves, round-trip churn share, and whether the size of a yield lead predicts its durability.",
    url: "https://yieldsignal.vercel.app/persistence",
    license: "https://opensource.org/licenses/MIT",
    creator: { "@type": "Organization", name: "YieldSignal", url: "https://yieldsignal.vercel.app" },
    isAccessibleForFree: true,
    ...(report?.observedTo ? { dateModified: report.observedTo } : {}),
    ...(report?.observedFrom && report?.observedTo
      ? { temporalCoverage: `${report.observedFrom}/${report.observedTo}` }
      : {}),
    keywords: ["DeFi", "yield", "Base", "lending", "attestation", "EAS", "x402", "signal durability"],
    distribution: [
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: "https://yieldsignal.vercel.app/persistence.json",
      },
    ],
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>How long does a yield signal stay true? — measured on-chain | YieldSignal</title>
<meta name="description" content="Measured from timestamped on-chain attestations: how long a best-yield call actually holds in Base lending and ETH liquid staking, how much leader rotation is pure churn, and whether a bigger lead lasts longer (it does not).">
<link rel="canonical" href="https://yieldsignal.vercel.app/persistence">
<meta property="og:type" content="article">
<meta property="og:title" content="How long does a yield signal stay true?">
<meta property="og:description" content="Measured on timestamped on-chain attestations, not asserted: median leadership duration per market, churn share, and the finding that a wider yield lead is not more durable than a narrow one.">
<meta property="og:url" content="https://yieldsignal.vercel.app/persistence">
<script type="application/ld+json">${JSON.stringify(dataset)}</script>
<style>
:root{color-scheme:light dark}
body{font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;max-width:52rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
h1{font-size:1.75rem;line-height:1.25;margin:0 0 .5rem}
h2{font-size:1.15rem;margin:2.25rem 0 .5rem}
.lede{font-size:1.05rem}
table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.925rem;display:block;overflow-x:auto}
th,td{text-align:left;padding:.5rem .65rem;border-bottom:1px solid rgba(128,128,128,.25);white-space:nowrap}
th{font-weight:600}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
.note{font-size:.9rem;opacity:.8}
nav{font-size:.9rem;margin-bottom:1.5rem}
footer{margin-top:3rem;font-size:.85rem;opacity:.75}
</style>
</head>
<body>
<nav><a href="/">YieldSignal</a> · <a href="/track-record">track record</a> · <a href="/accuracy.json">accuracy.json</a></nav>
<h1>How long does a yield signal stay true?</h1>
${corpo}
<footer>Recomputed from the public on-chain record on every load — no figure on this page is hand-written. ${report ? `Last attestation ${esc(report.observedTo ?? "—")}.` : ""}</footer>
</body>
</html>`;
}
