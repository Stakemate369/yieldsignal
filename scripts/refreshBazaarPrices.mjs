// Sincroniza o PREÇO anunciado no índice do Bazaar (CDP) com o preço real que a
// rota cobra hoje.
//
// Por que isto existe: o Bazaar guarda um retrato de cada rota tirado na última
// liquidação bem-sucedida dela — `lastUpdated` de cada entrada bate exatamente
// com o timestamp do último pagamento naquela rota. Ou seja, o índice não é
// consultado, é EMPURRADO por venda. Quando os preços subiram em 2026-08-10
// (sinal $0.01→$0.10, analíticas $0.01→$0.25, decisão $0.05→$0.50), as 14
// entradas continuaram anunciando os valores antigos.
//
// Isso não é cosmético: um agente comprador que lê o Bazaar monta o pagamento
// com o valor que encontrou lá. Se montar $0.01 contra uma rota que agora exige
// $0.10, a liquidação é recusada — e o comportamento normal de um cliente
// automático diante de recusa repetida é marcar o endpoint como quebrado e
// parar de tentar. Índice desatualizado é pior que ausência no índice.
//
// A única forma de reescrever a entrada é fazer uma liquidação real. Este
// script faz exatamente isso, e só onde precisa:
//
//   node scripts/refreshBazaarPrices.mjs            # mostra o que está fora de sincronia (não gasta)
//   node scripts/refreshBazaarPrices.mjs --pagar    # paga só as rotas divergentes
//
// O dinheiro sai da carteira COMPRADORA e cai na RECEPTORA, as duas suas — o
// gas do EIP-3009 é pago pelo facilitador. O custo líquido é zero; o que limita
// é o saldo da compradora no momento da chamada.
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";
import { garantirSaldo } from "./lib/tesouraria.mjs";

/**
 * Memória local de "já paguei esta rota, o índice é que ainda não atualizou".
 *
 * O Bazaar leva horas pra refletir uma liquidação. Sem esta trava, rodar o
 * script duas vezes no mesmo dia paga TUDO DE NOVO: a segunda execução relê o
 * índice, encontra o preço velho (que ainda não mudou) e conclui que a rota
 * continua fora de sincronia. Erro real e caro, cometido em 2026-08-10 — a
 * segunda execução regastou em rotas que a primeira já tinha corrigido e secou
 * a carteira antes de chegar nas que faltavam.
 *
 * `state/*.json` é gitignorado (ver .gitignore), então isto não versiona nada.
 */
const ARQUIVO_ESTADO = new URL("../state/bazaar-sync.json", import.meta.url);
const CARENCIA_HORAS = 12;

function lerEstado() {
  try {
    return JSON.parse(readFileSync(ARQUIVO_ESTADO, "utf8"));
  } catch {
    return {};
  }
}

function gravarEstado(estado) {
  try {
    mkdirSync(new URL("../state/", import.meta.url), { recursive: true });
    writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2) + "\n");
  } catch (err) {
    // Perder a memória degrada pra "paga de novo", não pra travar o script.
    console.error(`aviso: não consegui gravar ${ARQUIVO_ESTADO.pathname}: ${err?.message ?? err}`);
  }
}

const horasDesde = (iso) => (Date.now() - new Date(iso).getTime()) / 3_600_000;

const BASE = "https://yieldsignal.vercel.app";
const BAZAAR = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const PAGAR = process.argv.includes("--pagar");

/**
 * Rotas que EXIGEM parâmetro pra responder 200. `/exposure/*` recebe as
 * posições do comprador e recusa entrada ausente com 400 (ver
 * signal/parsePositions.ts — recusar é proposital, "não atribuído" em silêncio
 * seria pior). Chamar a URL nua aqui gastava o pagamento e levava 400: o
 * middleware x402 liquida ANTES do handler rodar, então o dinheiro sai e a
 * resposta é erro. Aconteceu de verdade em 2026-08-10, nas duas rotas de
 * exposure, na primeira execução deste script.
 *
 * O valor é só um exemplo válido — o que interessa é a liquidação, que é o que
 * reescreve a entrada do índice. O Bazaar indexa o path sem query string, então
 * pagar com parâmetro atualiza a mesma entrada.
 */
const PARAMETROS_OBRIGATORIOS = {
  "/exposure/usdc-base-yield": "?positions=aave:100000,morpho:50000",
  "/exposure/weth-base-yield": "?positions=aave:100000",
};

const comParametros = (rota) => rota + (PARAMETROS_OBRIGATORIOS[rota] ?? "");

/** Preço que a rota cobra AGORA, lido do desafio 402 (fonte da verdade). */
async function precoAtual(rota) {
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

/**
 * Varre o índice INTEIRO. A paginação importa: numa primeira tentativa parei em
 * 1.200 de 14.504 recursos e conclui que nenhuma rota estava indexada, quando
 * na verdade as 14 estavam. Só confie em `pagination.total` pra encerrar.
 */
async function entradasDoBazaar() {
  const minhas = [];
  let offset = 0;
  let total = null;
  for (;;) {
    const res = await fetch(`${BAZAAR}?limit=100&offset=${offset}`);
    if (!res.ok) throw new Error(`Bazaar devolveu HTTP ${res.status}`);
    const j = await res.json();
    const itens = j.items ?? [];
    total = j.pagination?.total ?? total;
    for (const it of itens) {
      if (String(it.resource ?? "").includes("yieldsignal.vercel.app")) minhas.push(it);
    }
    if (itens.length === 0) break;
    offset += itens.length;
    if (total != null && offset >= total) break;
  }
  return { minhas, total };
}

const { minhas, total } = await entradasDoBazaar();
console.log(`índice do Bazaar: ${total} recursos, ${minhas.length} seus\n`);

const linhas = [];
for (const entrada of minhas) {
  const rota = String(entrada.resource).replace(BASE, "").split("?")[0];
  const aceito = (entrada.accepts ?? [])[0] ?? {};
  const indexado = Number(aceito.maxAmountRequired ?? aceito.amount);
  const atual = await precoAtual(rota);
  if (atual == null) {
    console.log(`${rota.padEnd(30)} não consegui ler o preço atual — pulando`);
    continue;
  }
  linhas.push({ rota, indexado, atual, divergente: indexado !== atual });
}

const usd = (n) => "$" + (n / 1e6).toFixed(2);
for (const l of linhas.sort((a, b) => a.rota.localeCompare(b.rota))) {
  const marca = l.divergente ? "DESATUALIZADO" : "ok";
  console.log(`${l.rota.padEnd(30)} índice ${usd(l.indexado).padStart(7)}  real ${usd(l.atual).padStart(7)}  ${marca}`);
}

/**
 * Rotas que EXISTEM mas nunca apareceram no índice.
 *
 * Buraco encontrado em 2026-08-10, ao lançar a família /persistence: este script
 * só conferia o que já estava indexado, então uma rota nova era invisível pra
 * ele — ficava fora do Bazaar indefinidamente sem ninguém notar, porque o
 * relatório dizia "0 rotas a corrigir" e estava tecnicamente certo.
 *
 * O Bazaar indexa por VENDA, não por cadastro: rota nova só entra depois do
 * primeiro pagamento liquidado. E o Bazaar é o principal canal de descoberta do
 * serviço — lançar produto e não indexá-lo é lançar pra ninguém.
 *
 * A lista canônica vem do /openapi.json da própria produção (não de um array
 * escrito aqui, que é como divergências nascem).
 */
async function rotasPublicadas() {
  const res = await fetch(`${BASE}/openapi.json`);
  if (!res.ok) throw new Error(`/openapi.json devolveu HTTP ${res.status}`);
  const j = await res.json();
  return Object.keys(j.paths ?? {});
}

const indexadas = new Set(linhas.map((l) => l.rota));
const ausentes = [];
for (const rota of await rotasPublicadas()) {
  if (indexadas.has(rota)) continue;
  const atual = await precoAtual(rota);
  if (atual == null) {
    console.log(`${rota.padEnd(30)} não consegui ler o preço atual — pulando`);
    continue;
  }
  ausentes.push({ rota, indexado: null, atual, divergente: true, ausenteDoIndice: true });
}
if (ausentes.length > 0) {
  console.log("");
  for (const l of ausentes.sort((a, b) => a.rota.localeCompare(b.rota))) {
    console.log(`${l.rota.padEnd(30)} índice       —  real ${("$" + (l.atual / 1e6).toFixed(2)).padStart(7)}  AUSENTE DO ÍNDICE`);
  }
}

const estado = lerEstado();
// Ausentes entram na mesma fila das desatualizadas — e, o que mais importa,
// passam pela MESMA trava de carência: uma rota nova paga uma vez e leva horas
// pra aparecer; sem a trava, a execução seguinte pagaria de novo pela mesma
// coisa. Foi assim que uma cobrança dupla aconteceu em 2026-08-10.
const divergentes = [...linhas.filter((l) => l.divergente), ...ausentes];

// Separa "o índice está velho porque ninguém pagou" de "eu já paguei e o índice
// ainda não propagou". As duas parecem idênticas na leitura do Bazaar.
const aguardando = divergentes.filter((l) => estado[l.rota] && horasDesde(estado[l.rota]) < CARENCIA_HORAS);
const desatualizadas = divergentes.filter((l) => !aguardando.includes(l));

const custo = desatualizadas.reduce((s, l) => s + l.atual, 0);
if (aguardando.length > 0) {
  console.log(`\n${aguardando.length} rota(s) já paga(s) nas últimas ${CARENCIA_HORAS}h — aguardando o índice propagar:`);
  for (const l of aguardando) console.log(`  ${l.rota.padEnd(30)} pago há ${horasDesde(estado[l.rota]).toFixed(1)}h`);
}
console.log(`\n${desatualizadas.length} rota(s) a corrigir — custo: ${usd(custo)}`);

if (!PAGAR) {
  console.log("\nNada foi pago. Rode com --pagar para corrigir.");
  process.exit(0);
}
if (desatualizadas.length === 0) {
  console.log("Nada a fazer.");
  process.exit(0);
}

// Mesma construção de `indexMissingRoutes.mjs`: `new CdpX402Client()` +
// `getAddresses()`. Não existe `CdpX402Client.create()` neste SDK.
// AUTOFINANCIAMENTO. Toda mudança de preço deixa as 14 entradas anunciando o
// valor antigo, e corrigir custa uma chamada paga por rota. Isso NÃO pode
// depender de aporte do dono: o dinheiro que a compradora gasta cai na
// receptora, as duas dele — o ciclo é fechado e a receita acumulada já paga a
// própria manutenção. Antes de começar, puxa da receptora o que faltar.
const { recarregou, saldoUsd, motivo } = await garantirSaldo(Number(custo) / 1e6);
if (!recarregou && saldoUsd * 1e6 < custo) {
  console.log(`\naviso: saldo de $${saldoUsd.toFixed(2)} não cobre ${usd(custo)}.`);
  if (motivo) console.log(`       ${motivo}`);
  console.log("       vou pagar o que der, na ordem, e as restantes ficam pra próxima execução.");
}

const cliente = new CdpX402Client();
const { evmAddress } = await cliente.getAddresses();
console.log(`\npagando a partir de ${evmAddress}\n`);

const pagar = wrapFetchWithPayment(fetch, cliente);
let ok = 0;
for (const l of desatualizadas) {
  const alvo = BASE + comParametros(l.rota);
  process.stdout.write(`${l.rota.padEnd(30)} ${usd(l.atual)} ... `);
  try {
    // Aquece com o próprio 402: em cold start a verificação com o facilitador
    // estoura o tempo e o pagamento falha sem debitar (ver indexMissingRoutes.mjs).
    await fetch(alvo);
    const res = await pagar(alvo);
    if (res.status === 200) {
      ok++;
      // Grava a cada sucesso, não no fim: se a carteira secar no meio da fila e
      // o processo morrer, o que já foi pago não pode ser pago de novo.
      estado[l.rota] = new Date().toISOString();
      gravarEstado(estado);
      console.log("PAGO");
    } else if (res.status === 402) {
      // 402 depois de tentar pagar quase sempre é saldo insuficiente na
      // compradora — o cliente não consegue assinar autorização que não cobre.
      console.log("recusado (402) — provável saldo insuficiente; recarregue a carteira compradora");
    } else {
      console.log(`recusado (HTTP ${res.status})`);
    }
  } catch (err) {
    // Saldo insuficiente é o erro esperado quando a compradora seca no meio da
    // fila — reportar e seguir, pra que as rotas restantes ainda sejam tentadas
    // e o operador veja de uma vez quanto falta.
    console.log(`falhou: ${err?.message ?? err}`);
  }
}

console.log(`\n${ok} de ${desatualizadas.length} atualizadas.`);
console.log("O Bazaar não reindexa na hora — reconfira daqui algumas horas rodando este script sem --pagar.");
