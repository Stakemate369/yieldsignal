// Confere se os CANAIS DE DESCOBERTA continuam anunciando o catálogo real.
//
// Por que existe: todo canal deste serviço é empurrado, nenhum é consultado. O
// Bazaar guarda o retrato da última venda de cada rota, o registro MCP guarda o
// último `server.json` publicado, o /openapi.json é gerado pelo servidor. Os
// três divergem em silêncio — o servidor segue saudável, a telemetria não acusa
// nada, e quem quebra é o agente comprador que leu o anúncio errado. Já
// aconteceu duas vezes: as 4 rotas analíticas anunciaram $0.10 cobrando $0.25
// por semanas, e a família /persistence nasceu fora do índice.
//
// NÃO gasta nada e NÃO precisa de credencial: só faz GET público e lê o desafio
// 402, que é a fonte da verdade do preço. Feito pra rodar em CI agendado.
//
//   node scripts/checkDiscoveryHealth.mjs
//
// Sai com código 1 se algum canal divergir — é o que faz o CI avisar.
import { readFileSync } from "node:fs";

const BASE = process.env.YIELDSIGNAL_BASE ?? "https://yieldsignal.vercel.app";
const BAZAAR = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const MCP_REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";

const problemas = [];
const notas = [];
const usd = (n) => "$" + (n / 1e6).toFixed(2);

/** Preço que a rota cobra AGORA, do desafio 402 — fonte da verdade. */
async function precoReal(rota) {
  const res = await fetch(BASE + rota);
  const h = res.headers.get("payment-required");
  if (!h) return null;
  try {
    const j = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    const aceito = (j.accepts ?? []).find((a) => a.network === "eip155:8453") ?? j.accepts?.[0];
    const bruto = aceito?.amount ?? aceito?.maxAmountRequired;
    return bruto == null ? null : Number(bruto);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- /openapi.json
const openapi = await (await fetch(`${BASE}/openapi.json`)).json();
const rotasPublicadas = Object.keys(openapi.paths ?? {});
if (rotasPublicadas.length === 0) problemas.push("/openapi.json não lista rota nenhuma");
notas.push(`/openapi.json: ${rotasPublicadas.length} rotas`);

const precoReais = new Map();
for (const rota of rotasPublicadas) {
  const real = await precoReal(rota);
  if (real == null) {
    problemas.push(`${rota}: não devolveu desafio 402 — rota paga sem cobrança é receita perdida`);
    continue;
  }
  precoReais.set(rota, real);

  // O preço anunciado vem do texto da entrada. A descrição pode conter outros
  // cifrões (ex.: "per $10k"), então o anunciado é o ÚLTIMO valor com centavos —
  // é assim que o gerador o escreve. Comparar com o penúltimo daria falso alarme.
  const texto = JSON.stringify(openapi.paths[rota]);
  const comCentavos = texto.match(/\$\d+\.\d{2}\b/g) ?? [];
  const anunciado = comCentavos.length > 0 ? comCentavos[comCentavos.length - 1] : null;
  if (anunciado && anunciado !== usd(real)) {
    problemas.push(`${rota}: /openapi.json anuncia ${anunciado} mas o 402 cobra ${usd(real)}`);
  }
}

// ---------------------------------------------------------------------- Bazaar
// Paginação até o total declarado: parar antes já levou a concluir, errado, que
// nenhuma rota estava indexada.
const indexadas = new Map();
let offset = 0;
let total = null;
for (;;) {
  const res = await fetch(`${BAZAAR}?limit=100&offset=${offset}`);
  if (!res.ok) {
    problemas.push(`Bazaar devolveu HTTP ${res.status} — não deu pra conferir o índice`);
    break;
  }
  const j = await res.json();
  const itens = j.items ?? [];
  total = j.pagination?.total ?? total;
  for (const it of itens) {
    const url = String(it.resource ?? "");
    if (!url.includes("yieldsignal.vercel.app")) continue;
    const rota = url.replace(BASE, "").split("?")[0];
    const aceito = (it.accepts ?? [])[0] ?? {};
    indexadas.set(rota, Number(aceito.maxAmountRequired ?? aceito.amount));
  }
  if (itens.length === 0) break;
  offset += itens.length;
  if (total != null && offset >= total) break;
}
notas.push(`Bazaar: ${indexadas.size} rotas suas de ${total ?? "?"} recursos`);

for (const rota of rotasPublicadas) {
  const real = precoReais.get(rota);
  if (real == null) continue;
  if (!indexadas.has(rota)) {
    problemas.push(`${rota}: ausente do índice do Bazaar — corrigir com \`npm run bazaar:sync\``);
  } else if (indexadas.get(rota) !== real) {
    problemas.push(
      `${rota}: Bazaar anuncia ${usd(indexadas.get(rota))} mas o 402 cobra ${usd(real)} — \`npm run bazaar:sync\``,
    );
  }
}

// --------------------------------------------------------------- registro MCP
const local = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
try {
  const res = await fetch(`${MCP_REGISTRY}?search=${encodeURIComponent(local.name)}&version=latest`);
  const j = await res.json();
  const entrada = (j.servers ?? []).map((s) => s.server ?? s).find((s) => s.name === local.name);
  if (!entrada) {
    problemas.push(`registro MCP: "${local.name}" não encontrado`);
  } else {
    notas.push(`registro MCP: publicado ${entrada.version}, local ${local.version}`);
    if (entrada.version !== local.version) {
      problemas.push(`registro MCP publica ${entrada.version} mas server.json está em ${local.version}`);
    }
    if (entrada.description !== local.description) {
      problemas.push("registro MCP: descrição publicada difere do server.json");
    }
  }
} catch (err) {
  problemas.push(`registro MCP: falha consultando (${err.message})`);
}

// --------------------------------------------------- artefatos públicos vivos
// São o canal de divulgação que não depende de terceiro; se caírem, ninguém
// avisa. Conferidos por CONTEÚDO, não só por status: um 200 servindo página de
// erro passaria despercebido.
for (const [rota, precisaConter] of [
  ["/persistence.json", "gapVsDuration"],
  ["/persistence", "Dataset"],
  ["/accuracy.json", "windowedScore"],
  // O documento lista `resources`, não `accepts` — conferido ao vivo, não
  // adivinhado. Um sentinela errado aqui viraria alarme falso permanente, que
  // treina o dono a ignorar o alerta.
  ["/.well-known/x402", "resources"],
  ["/agent-card.json", "yieldsignal"],
  ["/sitemap.xml", "/persistence"],
]) {
  try {
    const res = await fetch(BASE + rota);
    const corpo = await res.text();
    if (!res.ok) problemas.push(`${rota}: HTTP ${res.status}`);
    else if (!corpo.includes(precisaConter)) problemas.push(`${rota}: respondeu 200 mas sem "${precisaConter}"`);
  } catch (err) {
    problemas.push(`${rota}: falha (${err.message})`);
  }
}

// ------------------------------------------------------------------- relatório
for (const n of notas) console.log("  " + n);
console.log("");
if (problemas.length === 0) {
  console.log("Todos os canais de descoberta batem com o catálogo real.");
  process.exit(0);
}
console.log(`${problemas.length} divergência(s):\n`);
for (const p of problemas) console.log("  - " + p);

// Telegram é opcional: sem os segredos, a falha do job já notifica pelo GitHub.
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  const texto = `YieldSignal — ${problemas.length} divergência(s) nos canais de descoberta:\n\n${problemas.map((p) => "• " + p).join("\n")}`;
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: texto }),
    });
  } catch {
    // Notificação nunca pode mascarar o resultado da checagem.
  }
}
process.exit(1);
