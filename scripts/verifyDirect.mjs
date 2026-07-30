// Compara, no /verify do facilitador da CDP, a rota que FALHA com a que
// FUNCIONOU — e imprime o diff estrutural entre os dois payloads.
// /verify não liquida: não move fundo, não gasta gas.
import "dotenv/config";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { generateJwt } from "@coinbase/cdp-sdk/auth";

const HOST = "api.cdp.coinbase.com";
const CAMINHO = "/platform/v2/x402/verify";

const ROTAS = {
  FALHA: "https://yieldsignal.vercel.app/signal/eth-staking-yield",
  OK: "https://yieldsignal.vercel.app/decision/eth-staking-yield",
};

const client = new CdpX402Client();
const payloads = {};

for (const [rotulo, url] of Object.entries(ROTAS)) {
  const desafio = await fetch(url);
  const pr = JSON.parse(Buffer.from(desafio.headers.get("payment-required"), "base64").toString("utf8"));
  const payload = await client.createPaymentPayload(pr);
  payloads[rotulo] = payload;

  const jwt = await generateJwt({
    apiKeyId: process.env.CDP_API_KEY_ID,
    apiKeySecret: process.env.CDP_API_KEY_SECRET,
    requestMethod: "POST",
    requestHost: HOST,
    requestPath: CAMINHO,
    expiresIn: 120,
  });

  const res = await fetch(`https://${HOST}${CAMINHO}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      x402Version: payload.x402Version,
      paymentPayload: payload,
      paymentRequirements: payload.accepted,
    }),
  });
  console.log(`[${rotulo}] verify ->`, res.status, (await res.text()).slice(0, 260));
}

// Diff estrutural: quais CAMINHOS de campo existem em cada payload e com que tipo.
function caminhos(o, base = "", acc = new Map()) {
  if (o === null || typeof o !== "object") {
    acc.set(base, typeof o === "string" ? `string(${o.length})` : typeof o);
    return acc;
  }
  if (Array.isArray(o)) {
    acc.set(base, `array(${o.length})`);
    return acc;
  }
  for (const [k, v] of Object.entries(o)) caminhos(v, base ? `${base}.${k}` : k, acc);
  return acc;
}

const a = caminhos(payloads.FALHA);
const b = caminhos(payloads.OK);
const todas = [...new Set([...a.keys(), ...b.keys()])].sort();

console.log("\n--- DIFF (só o que difere) ---");
for (const c of todas) {
  const va = a.get(c) ?? "(ausente)";
  const vb = b.get(c) ?? "(ausente)";
  if (va !== vb) console.log(`${c.padEnd(46)} FALHA=${String(va).padEnd(18)} OK=${vb}`);
}
