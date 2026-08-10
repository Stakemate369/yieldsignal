// Faz uma chamada PAGA REAL (Base mainnet) na rota que ainda falta no índice
// do Bazaar da CDP, pra que a liquidação fresca a faça aparecer lá.
//
// /decision/eth-staking-yield já foi pago com sucesso em 2026-07-30.
// Só /signal/eth-staking-yield ficou pra trás: naquela rodada ela voltou 402
// sem recibo e SEM debitar nada (saldo caiu exatamente 0,05, o preço só da
// outra rota) — ou seja, o pagamento não chegou a acontecer, provavelmente
// porque foi a primeira invocação da função na Vercel (cold start) e a
// verificação com o facilitador estourou o tempo.
//
// Custo: 0,01 USDC. O dinheiro sai da carteira COMPRADORA e cai na RECEPTORA,
// as duas suas; o gas do EIP-3009 é pago pelo facilitador.
import "dotenv/config";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";

// Rota alvo: passe o path como argumento, ou usa a vitrine por padrão.
//   node scripts/indexMissingRoutes.mjs /decision/weth-base-yield
const URL = "https://yieldsignal.vercel.app" + (process.argv[2] ?? "/signal/eth-staking-yield");

/** O motivo da recusa vem no header `Payment-Required` (base64), campo `error`. */
function motivoDoRecusado(res) {
  const h = res.headers.get("payment-required");
  if (!h) return "(sem header Payment-Required)";
  try {
    const j = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    return j.error ?? "(sem campo error)";
  } catch {
    return "(header ilegível)";
  }
}

const client = new CdpX402Client();
const { evmAddress } = await client.getAddresses();
console.log("pagando a partir de:", evmAddress);

// Preço lido do próprio desafio — não fixar à mão aqui: as rotas de sinal
// custam 0,01 e as de decisão 0,05, e um número escrito no script mente
// silenciosamente quando você aponta pra outra rota.
{
  const h = (await fetch(URL)).headers.get("payment-required");
  const j = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  const evm = j.accepts.find((a) => String(a.network).startsWith("eip155"));
  console.log(`rota: ${URL}`);
  console.log(`custo: ${Number(evm.amount) / 1e6} USDC\n`);
}

// Aquece a função primeiro pra que a chamada paga não caia num cold start —
// que é a causa mais provável da falha anterior. A degustação gratuita não
// existe mais (removida em 2026-08-10), então o aquecimento é o próprio 402:
// ele já executa todo o boot do servidor — carteira, x402ResourceServer,
// requisitos de pagamento — que é a parte lenta do cold start.
console.log("aquecendo a função (desafio 402, sem pagar)...");
const aquece = await fetch(URL);
console.log("aquecimento:", aquece.status, "\n");

const pagar = wrapFetchWithPayment(fetch, client);

for (let tentativa = 1; tentativa <= 3; tentativa++) {
  console.log(`--- tentativa ${tentativa}`);
  try {
    const res = await pagar(URL);
    const recibo = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
    console.log("status:", res.status);

    if (res.status === 200 && recibo) {
      console.log("PAGO. recibo presente.");
      console.log("corpo:", (await res.text()).slice(0, 200));
      break;
    }

    console.log("ainda não liquidou — motivo:", motivoDoRecusado(res));
  } catch (err) {
    console.log("ERRO:", err?.message ?? String(err));
  }

  if (tentativa < 3) {
    console.log("esperando 5s...\n");
    await new Promise((r) => setTimeout(r, 5000));
  }
}

console.log("\nO Bazaar não indexa na hora — reconferir daqui algumas horas.");
