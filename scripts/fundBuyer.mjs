// Devolve USDC da carteira RECEPTORA (onde a receita cai) para a carteira
// COMPRADORA (que paga as chamadas de manutenção, como `npm run bazaar:sync`).
//
//   node scripts/fundBuyer.mjs 1.50        # move $1.50
//
// Por que existe: as chamadas de manutenção que reescrevem o índice do Bazaar
// são pagas pela compradora e caem na receptora — as duas do dono. O dinheiro
// nunca é gasto, só troca de bolso. Sem este script o ciclo é aberto: a
// compradora seca, a receptora acumula, e o dono tem que mandar dinheiro novo
// de fora pra fazer um trabalho que a própria receita já pagou. Com ele o ciclo
// fecha e nenhuma manutenção futura precisa de aporte.
//
// Diferente de `npm run withdraw`, que manda pra carteira PESSOAL do dono
// (saída de verdade). Aqui os dois lados são contas operacionais da CDP, então
// não pede CONFIRM digitado — mas confere o destino contra o endereço
// re-derivado pelo NOME da conta antes de enviar, que é a trava que importa.
import "dotenv/config";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const RECEPTORA = "x402-receiver-wallet-1";
const COMPRADORA = "x402-client-wallet-1";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ABI_SALDO = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
];

const pedido = Number(process.argv[2]);
if (!Number.isFinite(pedido) || pedido <= 0) {
  console.error("uso: node scripts/fundBuyer.mjs <valor em USD>   (ex.: 1.50)");
  process.exit(1);
}
const valor = BigInt(Math.round(pedido * 1e6));

const cdp = new CdpClient({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
  walletSecret: process.env.CDP_WALLET_SECRET,
});

// Resolvidas pelo NOME a partir das credenciais atuais — nunca por endereço
// escrito à mão. É o mesmo cuidado de cli/withdraw.ts: endereço chumbado não
// detecta troca de CDP_WALLET_SECRET, nome re-derivado detecta.
const origem = await cdp.evm.getOrCreateAccount({ name: RECEPTORA });
const destino = await cdp.evm.getOrCreateAccount({ name: COMPRADORA });

if (origem.address.toLowerCase() === destino.address.toLowerCase()) {
  console.error("origem e destino são a MESMA conta — abortando (nomes de conta trocados?)");
  process.exit(1);
}

const publico = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });
const saldo = await publico.readContract({ address: USDC, abi: ABI_SALDO, functionName: "balanceOf", args: [origem.address] });

console.log(`origem  (receptora): ${origem.address}  $${(Number(saldo) / 1e6).toFixed(2)}`);
console.log(`destino (compradora): ${destino.address}`);
console.log(`valor: $${(Number(valor) / 1e6).toFixed(2)}\n`);

if (saldo < valor) {
  console.error(`saldo insuficiente na receptora: tem $${(Number(saldo) / 1e6).toFixed(2)}, pediu $${pedido.toFixed(2)}`);
  process.exit(1);
}

// Sem retry automático, pelo mesmo motivo de withdraw.ts: um erro de rede pode
// ter acontecido DEPOIS do envio ser aceito, e reenviar às cegas move o dinheiro
// duas vezes. Em falha, relê o saldo e dá um diagnóstico seguro.
const naRede = await origem.useNetwork("base");
try {
  const { transactionHash } = await naRede.transfer({ to: destino.address, amount: valor, token: "usdc", network: "base" });
  console.log(`enviado: ${transactionHash}`);
  console.log(`https://basescan.org/tx/${transactionHash}`);
} catch (err) {
  const depois = await publico
    .readContract({ address: USDC, abi: ABI_SALDO, functionName: "balanceOf", args: [origem.address] })
    .catch(() => null);
  console.error(`\nfalhou: ${err?.message ?? err}`);
  if (depois != null && depois < saldo) {
    console.error("ATENÇÃO: o saldo da receptora CAIU — a transferência pode ter ido apesar do erro. Confira antes de repetir.");
  } else {
    console.error("O saldo da receptora está intacto — é seguro tentar de novo.");
  }
  process.exit(1);
}
