import readline from "node:readline/promises";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, http } from "viem";
import { loadEnv } from "../config/env.js";
import { withdrawNetworkFor, X402_RECEIVER_ACCOUNT_NAME } from "../config/networks.js";
import { assertWalletAddress, readLockedAddress } from "../wallet/walletLock.js";
import { retryUntil } from "../execution/retry.js";
import { logger } from "../notify/logger.js";

// Só usada pra LER o saldo (mais simples/direto via viem que via
// listTokenBalances do SDK). O envio usa o helper `.transfer({ token: "usdc" })`
// nativo do SDK, não calldata montado à mão.
const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Saca todo o USDC acumulado (pagamentos x402 já liquidados) pra carteira
 * pessoal do dono. Sem posição em protocolo pra desfazer antes — o saldo
 * aqui é sempre USDC puro. Exige "CONFIRM" digitado manualmente; esta CLI
 * nunca deve ser chamada de forma automática/programática.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.OWNER_WALLET_ADDRESS) {
    throw new Error(
      "OWNER_WALLET_ADDRESS não configurado — não há destino de saque definido. Configure no .env antes de sacar.",
    );
  }
  const ownerAddress = env.OWNER_WALLET_ADDRESS as `0x${string}`;
  const isProduction = env.X402_ENVIRONMENT === "production";

  // Se EXPECTED_WALLET_ADDRESS estiver configurado (produção na Vercel, sem
  // disco persistente), não precisa de lock file nenhum — é a própria
  // configuração que serve de baseline. Só exige o arquivo local quando
  // rodando sem essa variável (desenvolvimento na própria máquina).
  if (!env.EXPECTED_WALLET_ADDRESS) {
    const lockedAddress = readLockedAddress(env.X402_ENVIRONMENT);
    if (!lockedAddress) {
      throw new Error(
        `Nenhuma carteira travada ainda pro ambiente "${env.X402_ENVIRONMENT}" — rode o servidor (npm run dev) pelo menos uma vez antes de sacar.`,
      );
    }
  }

  const cdp = new CdpClient({
    apiKeyId: env.CDP_API_KEY_ID,
    apiKeySecret: env.CDP_API_KEY_SECRET,
    walletSecret: env.CDP_WALLET_SECRET,
  });
  // Resolve a carteira de novo a partir das credenciais ATUAIS (mesmo nome
  // usado por server.ts), não a partir do endereço salvo — só assim a
  // trava abaixo consegue de fato detectar uma troca de CDP_WALLET_SECRET.
  const account = await cdp.evm.getOrCreateAccount({ name: X402_RECEIVER_ACCOUNT_NAME });
  assertWalletAddress(env.X402_ENVIRONMENT, account.address, env.EXPECTED_WALLET_ADDRESS);

  const { chain, usdc, cdpNetworkName } = withdrawNetworkFor(env.X402_ENVIRONMENT);
  const networkAccount = await account.useNetwork(cdpNetworkName);
  const publicClient = createPublicClient({ chain, transport: http() });

  logger.info({ address: account.address, ownerAddress, environment: env.X402_ENVIRONMENT }, "iniciando saque");

  const usdcBalance = await retryUntil(
    () =>
      publicClient.readContract({
        address: usdc,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [account.address as `0x${string}`],
      }),
    (balance) => balance > 0n,
  );

  if (usdcBalance === 0n) {
    console.log("Saldo de USDC na carteira é zero — nada pra sacar.");
    return;
  }

  const amountUsd = Number(usdcBalance) / 1e6;
  console.log(`\nSaldo encontrado: $${amountUsd.toFixed(4)} USDC`);
  console.log(`Origem (carteira do agente): ${account.address}`);
  console.log(`Destino (carteira pessoal):  ${ownerAddress}`);
  console.log(`Ambiente: ${isProduction ? "PRODUCTION — base mainnet, dinheiro real" : "development — base-sepolia, dinheiro de teste"}`);
  console.log('\nDigite "CONFIRM" pra prosseguir, ou qualquer outra coisa pra cancelar:');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("> ");
  rl.close();

  if (answer.trim() !== "CONFIRM") {
    console.log("Cancelado — nenhuma transação enviada.");
    return;
  }

  // Sem retry automático aqui de propósito: `.transfer()` move fundo de
  // verdade, e um erro de rede "transitório" pode ter acontecido DEPOIS do
  // envio já ter sido aceito — reenviar às cegas arrisca sacar duas vezes.
  // Se falhar, conferimos o saldo pra dar um diagnóstico seguro em vez de
  // adivinhar.
  let transactionHash: `0x${string}`;
  try {
    ({ transactionHash } = await networkAccount.transfer({
      to: ownerAddress,
      amount: usdcBalance,
      token: "usdc",
      network: cdpNetworkName,
    }));
  } catch (err) {
    const balanceAfter = await publicClient
      .readContract({
        address: usdc,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [account.address as `0x${string}`],
      })
      .catch(() => usdcBalance);

    if (balanceAfter < usdcBalance) {
      throw new Error(
        `A transferência deu erro, mas o saldo já caiu de $${amountUsd.toFixed(4)} pra $${(Number(balanceAfter) / 1e6).toFixed(4)} — ` +
          `ela pode ter sido enviada mesmo assim. NÃO rode o saque de novo antes de conferir no BaseScan se a transação já chegou em ${ownerAddress}. ` +
          `Erro original: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw new Error(
      `Falha ao enviar a transferência — saldo intacto ($${amountUsd.toFixed(4)}), seguro tentar de novo. ` +
        `Erro original: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const receipt = await networkAccount.waitForTransactionReceipt({ transactionHash });
  if (receipt.status !== "success") {
    throw new Error(
      `Transação enviada (${transactionHash}) mas não confirmou com sucesso (status: ${receipt.status}) — confira no BaseScan antes de tentar de novo.`,
    );
  }

  logger.info({ transactionHash, amountUsd, ownerAddress }, "saque concluído — fundo mandado pra carteira do dono");
  console.log(`\nSaque executado com sucesso.\nTx: ${transactionHash}`);
}

main().catch((err) => {
  logger.error({ err }, "falha no saque");
  process.exit(1);
});
