// Acha por busca binária o tamanho MÁXIMO de `resource.description` que o
// facilitador da CDP aceita. Varia só a descrição, mantendo todo o resto igual.
// Usa /verify, que não liquida nada — custo zero.
import "dotenv/config";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { generateJwt } from "@coinbase/cdp-sdk/auth";

const HOST = "api.cdp.coinbase.com";
const CAMINHO = "/platform/v2/x402/verify";
const MODELO = "https://yieldsignal.vercel.app/decision/eth-staking-yield";

const base = JSON.parse(
  Buffer.from((await fetch(MODELO)).headers.get("payment-required"), "base64").toString("utf8"),
);
const client = new CdpX402Client();

async function aceita(tamanho) {
  const pr = { ...base, resource: { ...base.resource, description: "x".repeat(tamanho) } };
  const payload = await client.createPaymentPayload(pr);
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
  return res.status === 200;
}

let ok = 1;
let falha = 2000;
console.log("sondando...");
for (const t of [384, 512, 631, 700, 715, 879]) {
  const r = await aceita(t);
  console.log(`  ${String(t).padStart(4)} chars -> ${r ? "ACEITA" : "RECUSA"}`);
  if (r) ok = Math.max(ok, t);
  else falha = Math.min(falha, t);
}

console.log("\nrefinando entre", ok, "e", falha);
while (falha - ok > 1) {
  const meio = Math.floor((ok + falha) / 2);
  if (await aceita(meio)) ok = meio;
  else falha = meio;
  process.stdout.write(`  ${ok}..${falha}\r`);
}

console.log(`\n\n>>> LIMITE: description aceita até ${ok} chars; ${falha} já é recusado.`);
