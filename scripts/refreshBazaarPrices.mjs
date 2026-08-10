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
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";

const BASE = "https://yieldsignal.vercel.app";
const BAZAAR = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const PAGAR = process.argv.includes("--pagar");

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

const desatualizadas = linhas.filter((l) => l.divergente);
const custo = desatualizadas.reduce((s, l) => s + l.atual, 0);
console.log(`\n${desatualizadas.length} rota(s) fora de sincronia — custo para corrigir: ${usd(custo)}`);

if (!PAGAR) {
  console.log("\nNada foi pago. Rode com --pagar para corrigir.");
  process.exit(0);
}
if (desatualizadas.length === 0) process.exit(0);

const cliente = await CdpX402Client.create();
const conta = await cliente.getAccount();
console.log(`\npagando a partir de ${conta.address}\n`);

const pagar = wrapFetchWithPayment(fetch, cliente);
let ok = 0;
for (const l of desatualizadas) {
  process.stdout.write(`${l.rota.padEnd(30)} ${usd(l.atual)} ... `);
  try {
    // Aquece com o próprio 402: em cold start a verificação com o facilitador
    // estoura o tempo e o pagamento falha sem debitar (ver indexMissingRoutes.mjs).
    await fetch(BASE + l.rota);
    const res = await pagar(BASE + l.rota);
    if (res.status === 200) {
      ok++;
      console.log("PAGO");
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
