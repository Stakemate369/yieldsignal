/**
 * Página em GET / — sem isso, alguém clicando no link público via humano
 * (não um agente) caía num 404/500 sem explicação nenhuma. Serve como o
 * "cartão de visita" do serviço; a API de verdade continua em
 * /signal/usdc-base-yield e /mcp.
 */
export const LANDING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YieldSignal — real-time USDC/WETH lending APY via x402</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.6; color: #1a1a1a; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #111; } code, pre { background: #222 !important; color: #e8e8e8; } a { color: #8ab4ff; } }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .sub { color: #666; margin-top: 0; }
  code { background: #f2f2f2; padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
  pre { background: #f2f2f2; padding: 1rem; border-radius: 8px; overflow-x: auto; }
  .badge { display: inline-block; background: #eef; color: #33f; border-radius: 6px; padding: 0.1em 0.6em; font-size: 0.8rem; margin-right: 0.4em; }
  footer { margin-top: 3rem; font-size: 0.85rem; color: #888; }
  a { color: #06c; }
</style>
</head>
<body>
<h1>YieldSignal</h1>
<p class="sub">Real-time, risk-weighted USDC and WETH lending APY across Aave, Compound, Morpho, Moonwell, Euler and Fluid on Base — paid per call via <a href="https://x402.org">x402</a>.</p>

<p><span class="badge">$0.01/call</span><span class="badge">3 free/day per IP via ?trial=1</span><span class="badge">no API key</span></p>

<h2>REST</h2>
<pre>GET https://yieldsignal.vercel.app/signal/usdc-base-yield
GET https://yieldsignal.vercel.app/signal/weth-base-yield</pre>
<p>Call it without payment and you'll get a <code>402 Payment Required</code> with the exact price/asset/network. Any x402-compatible client (e.g. <a href="https://www.npmjs.com/package/@x402/fetch">@x402/fetch</a>) completes the payment automatically. Add <code>?trial=1</code> to use one of the 3 free daily calls per IP instead of paying.</p>

<h2>MCP</h2>
<pre>POST https://yieldsignal.vercel.app/mcp</pre>
<p>Tool <code>get_yield_signal</code> (optional <code>asset</code>: <code>"USDC"</code> or <code>"WETH"</code>, defaults to USDC), gated per-call via <a href="https://www.npmjs.com/package/@x402/mcp">@x402/mcp</a> — <code>tools/list</code>/<code>initialize</code> stay free, only the tool call is paid.</p>

<h2>Every reading is source-tagged</h2>
<pre>{
  "asset": "USDC",
  "bestProtocol": "compound",
  "gapBps": 57,
  "rates": [
    { "protocol": "compound", "apyBps": 490, "weightedApyBps": 485, "source": "onchain", "asOf": "..." },
    { "protocol": "moonwell", "apyBps": 440, "weightedApyBps": 387, "source": "defillama", "asOf": "..." }
  ]
}</pre>
<p><code>source</code> is <code>onchain</code>/<code>api</code> (read directly from the protocol) or <code>defillama</code> (aggregator) — a reading that fails or looks invalid is omitted, never estimated.</p>

<footer>
  Open source: <a href="https://github.com/Stakemate369/yieldsignal">github.com/Stakemate369/yieldsignal</a>
</footer>
</body>
</html>
`;
