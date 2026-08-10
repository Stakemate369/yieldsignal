// Devolve USDC da carteira RECEPTORA (onde a receita cai) para a COMPRADORA
// (que paga as chamadas de manutenção do índice do Bazaar).
//
//   node scripts/fundBuyer.mjs 1.50        # move $1.50
//
// Na prática você raramente precisa disto: `npm run bazaar:sync` já puxa
// sozinho o que faltar antes de começar (ver garantirSaldo em lib/tesouraria).
// Este comando existe pro caso de querer recarregar por fora, sem sincronizar.
//
// Diferente de `npm run withdraw`, que manda pra carteira PESSOAL do dono
// (saída de verdade). Aqui os dois lados são contas operacionais da CDP e o
// dinheiro continua dentro do sistema — por isso não pede CONFIRM digitado.
//
// A lógica de mover fundo mora em `lib/tesouraria.mjs`, compartilhada com o
// sync. Duplicar código que move dinheiro é o pior lugar pra ter duas versões:
// a divergência aparece como transferência repetida, não como erro de compilar.
import "dotenv/config";
import { recarregarCompradora } from "./lib/tesouraria.mjs";

const pedido = Number(process.argv[2]);
if (!Number.isFinite(pedido) || pedido <= 0) {
  console.error("uso: node scripts/fundBuyer.mjs <valor em USD>   (ex.: 1.50)");
  process.exit(1);
}

const r = await recarregarCompradora(pedido);
if (!r.ok) {
  console.error(`falhou: ${r.motivo}`);
  process.exit(1);
}
console.log(`https://basescan.org/tx/${r.transactionHash}`);
