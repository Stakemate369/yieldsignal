import type { AccuracyScore, AccuracyBreakdown } from "./attestation/accuracyScore.js";
import type { WindowedAccuracy } from "./attestation/windowedAccuracy.js";
import type { AssetId } from "./market-data/types.js";
import { FLAGSHIP_ASSET } from "./market-data/types.js";

/**
 * Página em GET / — sem isso, alguém clicando no link público via humano
 * (não um agente) caía num 404/500 sem explicação nenhuma. Serve como o
 * "cartão de visita" do serviço; a API de verdade continua nas rotas
 * /signal/* , /decision/* e /mcp.
 *
 * A tabela de acurácia é RENDERIZADA A PARTIR DO DADO REAL (o mesmo
 * computeAccuracyScore que alimenta /accuracy.json, derivado do track record
 * EAS), nunca de número escrito à mão. Motivo: qualquer porcentagem hardcoded
 * aqui apodrece silenciosamente e vira propaganda falsa — e o argumento de
 * venda inteiro deste produto é "verificável, não prometido". Se o score não
 * puder ser lido, a seção some em vez de mostrar número velho.
 */

export interface LandingPageParams {
  /** null quando o score não pôde ser lido nesta requisição — a seção é omitida. */
  score: AccuracyScore | null;
  /**
   * Acurácia por janela de vigência. Opcional de propósito: a página continua
   * completa sem ela (a coluna some), então uma falha nova nunca derruba a
   * entrada do serviço.
   */
  windowed?: WindowedAccuracy | null;
  signalPrice: string;
  decisionPrice: string;
}

const ASSET_LABELS: Record<AssetId, string> = {
  ETH_STAKING: "ETH liquid staking (Ethereum)",
  USDC: "USDC lending (Base)",
  WETH: "WETH lending (Base)",
};

const ASSET_ROUTES: Record<AssetId, string> = {
  ETH_STAKING: "/signal/eth-staking-yield",
  USDC: "/signal/usdc-base-yield",
  WETH: "/signal/weth-base-yield",
};

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/**
 * Escapa texto antes de interpolar no HTML. Necessário porque o `asset` de cada
 * linha vem de `TrackRecordEntry`, que é DECODIFICADO de atestação on-chain — é
 * tipado como AssetId, mas a garantia real é só a query filtrar pelo nosso
 * próprio attester. Defesa em profundidade: se um dia a query passar a aceitar
 * outro attester (ou o decoder deixar passar um valor inesperado), um rótulo
 * fora do mapa não pode virar HTML executável na página de entrada.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Ordena os assets pela métrica JUSTA (within-tolerance), do mais forte pro
 * mais fraco, e só considera quem tem amostra apurável. Assim a página lidera
 * com o que o histórico de fato sustenta, em vez de com o produto mais antigo.
 */
export function rankAssetsByAccuracy(score: AccuracyScore): AccuracyBreakdown[] {
  return [...score.perAsset]
    .filter((a) => a.regretScored > 0 || a.scored > 0)
    .sort((a, b) => {
      const rateA = a.withinToleranceRate ?? a.hitRate ?? -1;
      const rateB = b.withinToleranceRate ?? b.hitRate ?? -1;
      if (rateB !== rateA) return rateB - rateA;
      // Empate: mais amostra primeiro (afirmação mais sustentada).
      return b.regretScored - a.regretScored;
    });
}

/** "13" -> "13h", "1" -> "1h", null -> "—". Meia hora vira "0.5h" (não arredonda pra zero). */
function hours(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value % 1 === 0 ? value : value.toFixed(1)}h`;
}

function accuracySection(score: AccuracyScore | null, windowed?: WindowedAccuracy | null): string {
  if (!score || score.perAsset.length === 0) {
    return `<p><strong>Proven, not promised.</strong> Machine-readable accuracy at <a href="/accuracy.json"><code>/accuracy.json</code></a>, computed 1:1 from the public on-chain EAS track record — a paying agent can check the record before deciding to trust the signal.</p>`;
  }

  const ranked = rankAssetsByAccuracy(score);
  const windowByAsset = new Map((windowed?.perAsset ?? []).map((w) => [w.asset, w]));
  const showWindow = windowByAsset.size > 0;
  const rows = ranked
    .map((a) => {
      const assetId = escapeHtml(String(a.asset));
      const label = escapeHtml(ASSET_LABELS[a.asset] ?? String(a.asset));
      const route = ASSET_ROUTES[a.asset];
      const name = route
        ? `<a href="${route}"><code>${assetId}</code></a> — ${label}`
        : `<code>${assetId}</code> — ${label}`;
      const window = windowByAsset.get(a.asset);
      const windowCell = showWindow ? `<td>${hours(window?.medianWindowHours ?? null)}</td>` : "";
      return `<tr><td>${name}</td><td>${pct(a.withinToleranceRate)}</td><td>${a.avgRegretBps ?? "—"} bps</td>${windowCell}<td>${a.regretScored || a.scored}</td></tr>`;
    })
    .join("\n  ");

  const strongest = ranked[0];
  const headline =
    strongest && (strongest.withinToleranceRate ?? strongest.hitRate) !== null
      ? `Strongest verified record right now: <strong>${escapeHtml(
          ASSET_LABELS[strongest.asset] ?? String(strongest.asset),
        )}</strong> at ${pct(
          strongest.withinToleranceRate ?? strongest.hitRate,
        )} within tolerance across ${strongest.regretScored || strongest.scored} on-chain attestations.`
      : "";

  return `<h2>Proven, not promised</h2>
<p>${headline} Every number below is recomputed from the public <a href="/track-record">EAS track record</a> on each page load — nothing here is a hand-written claim. Machine-readable at <a href="/accuracy.json"><code>/accuracy.json</code></a>.</p>
<table>
  <thead><tr><th>Asset</th><th>Within ${score.toleranceBps}bps of the leader</th><th>Avg regret</th>${showWindow ? "<th>Median time on top</th>" : ""}<th>Attestations scored</th></tr></thead>
  <tbody>
  ${rows}
  </tbody>
</table>
<p class="note">“Within tolerance” asks: when we flagged a protocol, was it still the leader — or at most ${score.toleranceBps}bps behind it — when scored against the current market? Regret is how many bps behind the current leader the flagged protocol sits, on average. Both are directional (<code>basis: ${score.basis}</code>), not a historical backtest, and the endpoint says so.</p>${
    showWindow
      ? `
<p class="note"><strong>Median time on top</strong> is how long a call actually stayed the leader before the next attestation replaced it — measured over each signal's own validity window, so a fast-rotating market is not judged against a market weeks later. It is also the practical answer to “how often should I re-check?”: ${hours(
          windowByAsset.get("USDC")?.medianWindowHours ?? null,
        )} for USDC lending against ${hours(
          windowByAsset.get(FLAGSHIP_ASSET)?.medianWindowHours ?? null,
        )} for ${escapeHtml(ASSET_LABELS[FLAGSHIP_ASSET])}. Machine-readable under <code>windowedScore</code> in <a href="/accuracy.json"><code>/accuracy.json</code></a>.</p>`
      : ""
  }`;
}

export function renderLandingPage(params: LandingPageParams): string {
  const { score, windowed, signalPrice, decisionPrice } = params;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YieldSignal — verifiable ETH staking &amp; lending yield signals via x402</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.6; color: #1a1a1a; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #111; } code, pre { background: #222 !important; color: #e8e8e8; } a { color: #8ab4ff; } th, td { border-color: #333 !important; } }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .sub { color: #666; margin-top: 0; }
  code { background: #f2f2f2; padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
  pre { background: #f2f2f2; padding: 1rem; border-radius: 8px; overflow-x: auto; }
  .badge { display: inline-block; background: #eef; color: #33f; border-radius: 6px; padding: 0.1em 0.6em; font-size: 0.8rem; margin-right: 0.4em; }
  table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
  th, td { border-bottom: 1px solid #ddd; padding: 0.45rem 0.5rem; text-align: left; }
  th { font-weight: 600; }
  .note { font-size: 0.85rem; color: #777; }
  footer { margin-top: 3rem; font-size: 0.85rem; color: #888; }
  a { color: #06c; }
</style>
</head>
<body>
<h1>YieldSignal</h1>
<p class="sub">Risk-weighted yield signals for autonomous agents, paid per call via <a href="https://x402.org">x402</a> — no API key, no account. ETH liquid staking on Ethereum mainnet (Lido, Rocket Pool, Coinbase Wrapped Staked ETH, Frax Ether, Binance Staked ETH) plus USDC and WETH lending on Base (Aave, Compound, Morpho, Moonwell, Euler, Fluid).</p>

<p><span class="badge">${signalPrice}/call signal</span><span class="badge">${decisionPrice}/call decision</span><span class="badge">3 free/day per IP via ?trial=1</span><span class="badge">signed + on-chain track record</span></p>

${accuracySection(score, windowed)}

<h2>REST</h2>
<pre>GET https://yieldsignal.vercel.app${ASSET_ROUTES.ETH_STAKING}
GET https://yieldsignal.vercel.app${ASSET_ROUTES.USDC}
GET https://yieldsignal.vercel.app${ASSET_ROUTES.WETH}</pre>
<p>Call it without payment and you'll get a <code>402 Payment Required</code> with the exact price/asset/network. Any x402-compatible client (e.g. <a href="https://www.npmjs.com/package/@x402/fetch">@x402/fetch</a>) completes the payment automatically. Add <code>?trial=1</code> to use one of the 3 free daily calls per IP instead of paying. Bare <code>/signal</code> and <code>/decision</code> redirect (308) to the ${ASSET_LABELS[FLAGSHIP_ASSET]} route.</p>

<h2>Decision, not just data</h2>
<pre>GET /decision/eth-staking-yield?position=lido&amp;amountUsd=25000&amp;horizonDays=30</pre>
<p>The signal endpoints answer “what pays best right now”. The decision endpoints answer “given where my money already sits, is moving it worth the cost?” — returning MOVE/HOLD with expected net gain, break-even in days and a confidence tier, deterministic from the signed signal so you can reproduce it locally.</p>

<h2>MCP</h2>
<pre>POST https://yieldsignal.vercel.app/mcp</pre>
<p>Tools <code>get_yield_signal</code> and <code>get_yield_decision</code> (optional <code>asset</code>: <code>"ETH_STAKING"</code>, <code>"USDC"</code> or <code>"WETH"</code>), gated per-call via <a href="https://www.npmjs.com/package/@x402/mcp">@x402/mcp</a> — <code>tools/list</code>/<code>initialize</code> stay free, only the tool call is paid. Also available as an <a href="https://www.npmjs.com/package/elizaos-plugin-yieldsignal">elizaOS plugin</a>.</p>

<h2>Every reading is source-tagged</h2>
<pre>{
  "asset": "ETH_STAKING",
  "bestProtocol": "lido",
  "gapBps": 57,
  "rates": [
    { "protocol": "lido", "apyBps": 296, "weightedApyBps": 293, "source": "defillama", "asOf": "..." },
    { "protocol": "rocket-pool", "apyBps": 240, "weightedApyBps": 235, "source": "defillama", "asOf": "..." }
  ]
}</pre>
<p><code>source</code> is <code>onchain</code>/<code>api</code> (read directly from the protocol — Aave, Compound and Morpho) or <code>defillama</code> (aggregator — Moonwell, Euler, Fluid and all staking pools) — a reading that fails or looks invalid is omitted, never estimated.</p>

<h2>Verifiable, not just claimed</h2>
<p>Two independent ways to check a response wasn't tampered with or fabricated, without needing to trust our uptime at query time:</p>
<ul>
  <li><strong>Signed responses</strong> — every REST/MCP response is signed (EIP-712 typed data) by the same <code>payTo</code> address the 402 payment requirement names for that route. REST exposes it as <code>X-Signal-Signature</code>/<code>X-Signal-Signer</code>/<code>X-Signal-Eip712-Payload</code> response headers over the exact response body; MCP returns it as a sibling content block over the exact previous block's text. Verify with <a href="https://viem.sh/docs/utilities/verifyTypedData">viem's <code>verifyTypedData</code></a>.</li>
  <li><strong>On-chain attestations (EAS, Base mainnet)</strong> — periodic public, permanent records of "at time T, protocol X paid Y bps, Z ahead of the runner-up," independently verifiable on <a href="https://base.easscan.org">easscan.org</a> without trusting this server at all. Attester address is that same <code>payTo</code> address. Published automatically whenever the signal changes materially or gets stale (not on every call — see <a href="/track-record">track record</a>).</li>
</ul>

<h2>Agent discovery &amp; reputation</h2>
<p>Registration file (<a href="https://eips.ethereum.org/EIPS/eip-8004">ERC-8004</a>) at <a href="/agent-card.json"><code>/agent-card.json</code></a> — a portable identity for this service, discoverable outside x402-specific directories. Any buyer can leave verifiable feedback via the <code>ReputationRegistry</code> — see the agent card for both contract addresses.</p>

<footer>
  Track record: <a href="/track-record">yieldsignal.vercel.app/track-record</a><br>
  Open source: <a href="https://github.com/Stakemate369/yieldsignal">github.com/Stakemate369/yieldsignal</a>
</footer>
</body>
</html>
`;
}
