// Movimento de USDC entre as DUAS contas operacionais do dono na Base:
// a RECEPTORA (onde a receita cai) e a COMPRADORA (que paga as chamadas de
// manutenção que reescrevem o índice do Bazaar).
//
// A manutenção é um CICLO FECHADO: o que a compradora paga cai na receptora.
// O dinheiro nunca sai, só troca de bolso — então "a compradora secou" nunca é
// motivo pra pedir aporte ao dono enquanto a receptora tiver saldo. Este módulo
// existe pra que essa recarga seja automática, e não uma etapa manual que
// alguém precisa lembrar de fazer toda vez que um preço muda.
import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

export const RECEPTORA = "x402-receiver-wallet-1";
export const COMPRADORA = "x402-client-wallet-1";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ABI_SALDO = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

export const clientePublico = () =>
  createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });

export async function saldoUsdc(publico, endereco) {
  return publico.readContract({ address: USDC, abi: ABI_SALDO, functionName: "balanceOf", args: [endereco] });
}

/**
 * Resolve as duas contas pelo NOME a partir das credenciais atuais — nunca por
 * endereço escrito à mão. Mesmo cuidado de `cli/withdraw.ts`: endereço chumbado
 * não detecta uma troca de CDP_WALLET_SECRET, nome re-derivado detecta.
 */
export async function contas() {
  const cdp = new CdpClient({
    apiKeyId: process.env.CDP_API_KEY_ID,
    apiKeySecret: process.env.CDP_API_KEY_SECRET,
    walletSecret: process.env.CDP_WALLET_SECRET,
  });
  const receptora = await cdp.evm.getOrCreateAccount({ name: RECEPTORA });
  const compradora = await cdp.evm.getOrCreateAccount({ name: COMPRADORA });
  if (receptora.address.toLowerCase() === compradora.address.toLowerCase()) {
    throw new Error("receptora e compradora resolveram pro MESMO endereço — nomes de conta trocados?");
  }
  return { receptora, compradora };
}

/**
 * Move `valorUsd` da receptora pra compradora.
 *
 * Sem retry automático, pelo mesmo motivo de `cli/withdraw.ts`: um erro de rede
 * "transitório" pode ter acontecido DEPOIS do envio ser aceito, e reenviar às
 * cegas move o dinheiro duas vezes. Em falha, relê o saldo pra dar diagnóstico
 * seguro em vez de adivinhar.
 */
export async function recarregarCompradora(valorUsd, { log = console.log } = {}) {
  const valor = BigInt(Math.round(valorUsd * 1e6));
  if (valor <= 0n) throw new Error("valor precisa ser positivo");

  const publico = clientePublico();
  const { receptora, compradora } = await contas();
  const disponivel = await saldoUsdc(publico, receptora.address);

  if (disponivel < valor) {
    return {
      ok: false,
      motivo: `receptora tem $${(Number(disponivel) / 1e6).toFixed(2)}, precisava de $${valorUsd.toFixed(2)}`,
      disponivel,
    };
  }

  log(`recarregando compradora: $${valorUsd.toFixed(2)} de ${receptora.address} -> ${compradora.address}`);
  const naRede = await receptora.useNetwork("base");
  try {
    const { transactionHash } = await naRede.transfer({
      to: compradora.address,
      amount: valor,
      token: "usdc",
      network: "base",
    });
    log(`  tx: ${transactionHash}`);
    return { ok: true, transactionHash };
  } catch (err) {
    const depois = await saldoUsdc(publico, receptora.address).catch(() => null);
    const caiu = depois != null && depois < disponivel;
    return {
      ok: false,
      motivo: caiu
        ? `envio falhou MAS o saldo da receptora caiu — pode ter ido; confira antes de repetir. (${err?.message ?? err})`
        : `envio falhou e o saldo está intacto, é seguro tentar de novo. (${err?.message ?? err})`,
    };
  }
}

/**
 * TETO ABSOLUTO por recarga. Nenhuma execução automática move mais que isto,
 * mesmo que o cálculo peça — é a rede de segurança contra um `necessarioUsd`
 * errado (bug de unidade, custo lido torto do índice) virar uma transferência
 * grande. As 14 rotas juntas custam menos de $4; qualquer pedido acima de $10
 * é sintoma de defeito, não de demanda real.
 */
export const TETO_RECARGA_USD = 10;

/**
 * Decide QUANTO puxar da receptora. Pura de propósito: é a única parte do
 * caminho de dinheiro que dá pra testar sem rede, e é onde um erro custa caro.
 *
 * Regras, todas com um jeito conhecido de dar errado:
 *  - entrada não-finita (NaN de um parse falho) => não move nada. NaN em
 *    comparação numérica é sempre falso, então sem esta guarda um NaN passaria
 *    direto pelos testes de "já tem o bastante" e viraria BigInt(NaN), que lança.
 *  - já tem o bastante => 0.
 *  - o que falta é limitado pelo TETO e pelo que a receptora realmente tem;
 *    pedir mais do que existe faz a transferência inteira falhar, e aí nem a
 *    parte possível acontece.
 *  - resultado arredondado pra baixo em 6 casas (unidade do USDC): pedir uma
 *    frações de unidade a mais que o saldo faz o contrato reverter.
 */
export function calcularRecarga({ saldoAtualUsd, necessarioUsd, disponivelUsd, folgaUsd = 0.5 }) {
  const numeros = [saldoAtualUsd, necessarioUsd, disponivelUsd, folgaUsd];
  if (!numeros.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
    return { valorUsd: 0, motivo: "entrada inválida (valor não-finito ou negativo)" };
  }
  if (saldoAtualUsd >= necessarioUsd) return { valorUsd: 0, motivo: "compradora já tem o bastante" };
  if (disponivelUsd <= 0) return { valorUsd: 0, motivo: "receptora está vazia" };

  const idealUsd = necessarioUsd - saldoAtualUsd + folgaUsd;
  const limitado = Math.min(idealUsd, TETO_RECARGA_USD, disponivelUsd);
  // Trunca (não arredonda) na unidade do USDC: arredondar pra cima poderia
  // pedir 1 unidade a mais do que a receptora tem e reverter a transferência.
  const valorUsd = Math.floor(limitado * 1e6) / 1e6;

  if (valorUsd <= 0) return { valorUsd: 0, motivo: "valor calculado não é positivo" };
  const motivo =
    limitado < idealUsd
      ? limitado === TETO_RECARGA_USD
        ? `limitado pelo teto de $${TETO_RECARGA_USD}`
        : "limitado pelo saldo da receptora"
      : "";
  return { valorUsd, motivo };
}

/**
 * Garante que a compradora tenha pelo menos `necessarioUsd`, puxando da
 * receptora o que faltar. Nunca lança por saldo insuficiente: o chamador
 * precisa poder seguir e pagar o que der.
 */
export async function garantirSaldo(necessarioUsd, { folgaUsd = 0.5, log = console.log } = {}) {
  const publico = clientePublico();
  const { compradora, receptora } = await contas();
  const atualUsd = Number(await saldoUsdc(publico, compradora.address)) / 1e6;
  const disponivelUsd = Number(await saldoUsdc(publico, receptora.address)) / 1e6;

  const { valorUsd, motivo } = calcularRecarga({ saldoAtualUsd: atualUsd, necessarioUsd, disponivelUsd, folgaUsd });
  if (valorUsd <= 0) return { recarregou: false, saldoUsd: atualUsd, motivo };

  log(`compradora tem $${atualUsd.toFixed(2)}, precisa de $${necessarioUsd.toFixed(2)} — puxando da receptora`);
  if (motivo) log(`  (${motivo})`);
  const r = await recarregarCompradora(valorUsd, { log });
  if (!r.ok) {
    log(`  não deu pra recarregar: ${r.motivo}`);
    return { recarregou: false, saldoUsd: atualUsd, motivo: r.motivo };
  }

  // Relê em vez de somar: assumir o valor esperado esconderia uma liquidação
  // parcial ou um envio que não chegou.
  const depois = Number(await saldoUsdc(publico, compradora.address)) / 1e6;
  log(`  saldo da compradora agora: $${depois.toFixed(2)}`);
  return { recarregou: true, saldoUsd: depois };
}
