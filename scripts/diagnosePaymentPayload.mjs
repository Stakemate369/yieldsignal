// DIAGNÓSTICO DECISIVO — separa as duas causas possíveis da recusa do
// facilitador da CDP em /signal/eth-staking-yield (10.000 atômicos, 879 chars):
//
//   (A) valor baixo demais  -> piso do facilitador acima de 0,01 USDC
//   (B) description longa demais -> limite de tamanho no payload
//
// Teste: /signal/usdc-base-yield tem o MESMO valor (10.000) mas description
// MENOR (715 chars).
//   - se FALHAR  -> a causa é o VALOR (descrição menor não salvou)
//   - se PAGAR   -> a causa é a DESCRIÇÃO (mesmo valor passou)
//
// Custo: 0,01 USDC se pagar; zero se falhar (falha não debita — comprovado
// em 4 tentativas anteriores, saldo intacto). Se pagar, o dinheiro vai da sua
// carteira compradora pra sua receptora e ainda revalida essa rota no Bazaar.
import "dotenv/config";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";

const URL = "https://yieldsignal.vercel.app/signal/usdc-base-yield";

function motivo(res) {
  const h = res.headers.get("payment-required");
  if (!h) return "(sem header)";
  try {
    return JSON.parse(Buffer.from(h, "base64").toString("utf8")).error ?? "(sem campo error)";
  } catch {
    return "(header ilegível)";
  }
}

const client = new CdpX402Client();
console.log("rota testada:", URL);
console.log("valor: 10.000 atômicos (igual ao da rota que falha)");
console.log("description: 715 chars (menor que os 879 da que falha)\n");

const pagar = wrapFetchWithPayment(fetch, client);
const res = await pagar(URL);
const recibo = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");

console.log("status:", res.status);
if (res.status === 200 && recibo) {
  console.log("\n>>> PAGOU. Causa = DESCRIPTION longa demais.");
  console.log(">>> Correção: encurtar a descrição de ETH_STAKING em expressApp.ts.");
} else {
  console.log("motivo:", motivo(res));
  console.log("\n>>> FALHOU. Causa = VALOR de 0,01 USDC abaixo do piso do facilitador.");
  console.log(">>> Implicação: TODAS as 3 rotas de sinal a 0,01 estão sem conseguir");
  console.log(">>> receber pagamento hoje. Só as de decisão (0,05) funcionam.");
}
