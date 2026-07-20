/**
 * Página em GET /track-record — casca estática (mesmo estilo de
 * landingPage.ts) que busca `/track-record.json` via JS no próprio navegador
 * e renderiza uma tabela; nenhuma lógica de servidor duplicada aqui, a rota
 * JSON (attestation/trackRecord.ts) já é a fonte única de verdade.
 */
export const TRACK_RECORD_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YieldSignal — track record</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 900px; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.6; color: #1a1a1a; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #111; } table, th, td { border-color: #333 !important; } code { background: #222 !important; color: #e8e8e8; } a { color: #8ab4ff; } .yes { color: #6f6 !important; } .no { color: #f77 !important; } }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .sub { color: #666; margin-top: 0; }
  code { background: #f2f2f2; padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.85em; }
  table { border-collapse: collapse; width: 100%; margin-top: 1.5rem; font-size: 0.9rem; }
  th, td { border: 1px solid #ddd; padding: 0.5em 0.7em; text-align: left; }
  th { background: rgba(127,127,127,0.08); }
  .yes { color: #196c19; font-weight: 600; }
  .no { color: #a33; font-weight: 600; }
  a { color: #06c; }
  #empty, #error { color: #888; margin-top: 1.5rem; }
</style>
</head>
<body>
<h1>YieldSignal — track record</h1>
<p class="sub">Every EAS attestation this service has published, plus what the same protocol pays <strong>right now</strong> — not a historical backtest (no per-block price index), just an honest "what we said then vs. what's true now" check. Source: <a href="https://base.easscan.org">EASScan</a>, no database of our own. Machine-readable: <a href="/track-record.json"><code>/track-record.json</code></a>. Auto-refreshes every <span id="interval">60</span>s — last updated <span id="updated">-</span>.</p>

<table id="table" hidden>
  <thead>
    <tr>
      <th>Attested</th>
      <th>Asset</th>
      <th>Protocol (then)</th>
      <th>APY then (bps)</th>
      <th>Gap then (bps)</th>
      <th>Best now</th>
      <th>APY now (bps)</th>
      <th>Still best?</th>
      <th>EASScan</th>
    </tr>
  </thead>
  <tbody id="rows"></tbody>
</table>
<p id="empty" hidden>No attestations published yet.</p>
<p id="error" hidden>Failed to load track record — try again in a moment.</p>

<script>
const REFRESH_MS = 60000;

function load() {
  fetch("/track-record.json")
    .then((r) => r.json())
    .then((data) => {
      document.getElementById("error").hidden = true;
      const entries = data.entries || [];
      const rows = document.getElementById("rows");
      rows.innerHTML = "";
      if (entries.length === 0) {
        document.getElementById("empty").hidden = false;
        document.getElementById("table").hidden = true;
        return;
      }
      document.getElementById("empty").hidden = true;
      for (const e of entries) {
        const tr = document.createElement("tr");
        const stillBest = e.stillBest === null ? "unknown" : (e.stillBest ? "yes" : "no");
        const stillBestClass = e.stillBest === null ? "" : (e.stillBest ? "yes" : "no");
        tr.innerHTML =
          "<td>" + new Date(e.attestedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC</td>" +
          "<td>" + e.asset + "</td>" +
          "<td>" + e.bestProtocolAtAttestation + "</td>" +
          "<td>" + e.weightedApyBpsAtAttestation + "</td>" +
          "<td>" + e.gapBpsAtAttestation + "</td>" +
          "<td>" + (e.currentBestProtocol ?? "n/a") + "</td>" +
          "<td>" + (e.currentWeightedApyBps ?? "n/a") + "</td>" +
          "<td class=\\"" + stillBestClass + "\\">" + stillBest + "</td>" +
          "<td><a href=\\"" + e.easscanUrl + "\\" target=\\"_blank\\" rel=\\"noopener\\">view</a></td>";
        rows.appendChild(tr);
      }
      document.getElementById("table").hidden = false;
      document.getElementById("updated").textContent = new Date().toISOString().slice(11, 19) + " UTC";
    })
    .catch(() => {
      document.getElementById("error").hidden = false;
    });
}

document.getElementById("interval").textContent = String(REFRESH_MS / 1000);
load();
setInterval(load, REFRESH_MS);
</script>
</body>
</html>
`;
