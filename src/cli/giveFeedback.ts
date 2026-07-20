import readline from "node:readline/promises";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, decodeEventLog, encodeFunctionData, formatEther, http, keccak256, toBytes } from "viem";
import { loadEnv } from "../config/env.js";
import { withdrawNetworkFor, X402_RECEIVER_ACCOUNT_NAME } from "../config/networks.js";
import { ERC8004_BASE_MAINNET, REPUTATION_REGISTRY_ABI } from "../attestation/erc8004.js";
import { logger } from "../notify/logger.js";

const AGENT_ID = 59272n;
const DEFAULT_ENDPOINT = "https://yieldsignal.vercel.app/signal/usdc-base-yield";
const DEFAULT_BUYER_ACCOUNT_NAME = "yieldsignal-feedback-buyer";

/**
 * Deixa UM feedback real on-chain (ERC-8004 ReputationRegistry) sobre o
 * agentId do YieldSignal — só funciona se rodado por uma carteira que NÃO
 * seja a receptora do serviço: o contrato reverte com "Self-feedback not
 * allowed" pra owner/operador do agentId (`isAuthorizedOrOwner`), de
 * propósito — este script NUNCA deve (e não consegue) fabricar a própria
 * reputação do agente. Resolve uma conta CDP separada (nome configurável via
 * argumento, default "yieldsignal-feedback-buyer") em vez de
 * `wallet/signerAccount.ts` (que sempre resolve X402_RECEIVER_ACCOUNT_NAME).
 * Precisa ter feito pelo menos uma chamada paga de verdade pra o feedback
 * fazer sentido — este script não valida isso, é uma questão de honestidade
 * de quem roda.
 *
 * `npm run give-feedback` (usa a conta default) ou
 * `npm run give-feedback -- outro-nome-de-conta`
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (env.X402_ENVIRONMENT !== "production") {
    throw new Error('Feedback só faz sentido sobre o agentId real — rode com X402_ENVIRONMENT="production".');
  }

  const buyerAccountName = process.argv[2] ?? DEFAULT_BUYER_ACCOUNT_NAME;
  if (buyerAccountName === X402_RECEIVER_ACCOUNT_NAME) {
    throw new Error(
      `"${buyerAccountName}" é a conta receptora do próprio serviço — o contrato vai recusar ("Self-feedback not allowed"). Use outro nome de conta.`,
    );
  }

  const cdp = new CdpClient({
    apiKeyId: env.CDP_API_KEY_ID,
    apiKeySecret: env.CDP_API_KEY_SECRET,
    walletSecret: env.CDP_WALLET_SECRET,
  });
  const buyer = await cdp.evm.getOrCreateAccount({ name: buyerAccountName });
  const { chain, cdpNetworkName } = withdrawNetworkFor(env.X402_ENVIRONMENT);
  const buyerNetworkAccount = await buyer.useNetwork(cdpNetworkName);
  const publicClient = createPublicClient({ chain, transport: http() });
  const ethBalance = await publicClient.getBalance({ address: buyer.address });

  console.log("\nFeedback ERC-8004 — Base mainnet, transação real, gasta ETH de gas.\n");
  console.log(`ReputationRegistry: ${ERC8004_BASE_MAINNET.reputationRegistry}`);
  console.log(`agentId:            ${AGENT_ID}`);
  console.log(`Conta compradora:   ${buyer.address} (conta "${buyerAccountName}", NÃO a receptora do serviço)`);
  console.log(`Saldo ETH:          ${formatEther(ethBalance)} ETH`);
  if (ethBalance === 0n) {
    throw new Error(`${buyer.address} não tem ETH pra gas na Base mainnet — mande um pouco antes de rodar de novo.`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const scoreRaw = await rl.question("\nNota de 0 a 100 (só inteiro, sem casas decimais): ");
  const score = Number.parseInt(scoreRaw.trim(), 10);
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    rl.close();
    throw new Error(`Nota inválida: "${scoreRaw}" — precisa ser um inteiro entre 0 e 100.`);
  }
  const tag1 = (await rl.question('Tag principal (livre, ex.: "accurate", ou Enter pra deixar em branco): ')).trim();
  const tag2 = (await rl.question("Tag secundária (opcional, Enter pra deixar em branco): ")).trim();
  const endpoint = (await rl.question(`Endpoint sobre o qual o feedback é (Enter pra usar "${DEFAULT_ENDPOINT}"): `)).trim() || DEFAULT_ENDPOINT;
  const feedbackURI = (await rl.question("Link com mais detalhes do feedback (opcional, Enter pra deixar em branco): ")).trim();
  // feedbackHash é o keccak256 do próprio feedbackURI (string vazia se
  // nenhum link foi dado) — não é um hash de conteúdo baixado, só uma
  // amarração determinística do que foi de fato submetido aqui.
  const feedbackHash = keccak256(toBytes(feedbackURI));

  console.log("\nResumo do feedback:");
  console.log(`  Nota:     ${score}/100`);
  console.log(`  Tag1:     ${tag1 || "(vazia)"}`);
  console.log(`  Tag2:     ${tag2 || "(vazia)"}`);
  console.log(`  Endpoint: ${endpoint}`);
  console.log(`  URI:      ${feedbackURI || "(vazio)"}`);
  console.log('\nDigite "CONFIRM" pra publicar esse feedback on-chain, ou qualquer outra coisa pra cancelar:');
  const answer = await rl.question("> ");
  rl.close();
  if (answer.trim() !== "CONFIRM") {
    console.log("Cancelado — nenhuma transação enviada.");
    return;
  }

  const data = encodeFunctionData({
    abi: REPUTATION_REGISTRY_ABI,
    functionName: "giveFeedback",
    args: [AGENT_ID, BigInt(score), 0, tag1, tag2, endpoint, feedbackURI, feedbackHash],
  });

  let transactionHash: `0x${string}`;
  try {
    const result = await buyerNetworkAccount.sendTransaction({
      transaction: { to: ERC8004_BASE_MAINNET.reputationRegistry, data, value: 0n },
    });
    transactionHash = result.transactionHash;
  } catch (err) {
    const balanceAfter = await publicClient.getBalance({ address: buyer.address }).catch(() => ethBalance);
    if (balanceAfter < ethBalance) {
      throw new Error(
        `O envio deu erro, mas o saldo de ETH já caiu de ${formatEther(ethBalance)} pra ${formatEther(balanceAfter)} — ` +
          `a transação pode ter saído mesmo assim. Confira no BaseScan antes de rodar de novo. Erro original: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw new Error(
      `Falha ao enviar a transação — saldo de ETH intacto (${formatEther(ethBalance)}), seguro tentar de novo. ` +
        `Erro original: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  console.log(`\nTransação enviada: ${transactionHash}`);
  console.log("Aguardando confirmação...");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success") {
    throw new Error(`Transação confirmou com status "${receipt.status}" — confira no BaseScan antes de tentar de novo.`);
  }

  const feedbackLog = receipt.logs
    .filter((log) => log.address.toLowerCase() === ERC8004_BASE_MAINNET.reputationRegistry.toLowerCase())
    .map((log) => {
      try {
        return decodeEventLog({ abi: REPUTATION_REGISTRY_ABI, eventName: "NewFeedback", ...log });
      } catch {
        return undefined;
      }
    })
    .find((decoded) => decoded !== undefined);

  logger.info({ transactionHash, agentId: AGENT_ID.toString(), score }, "feedback ERC-8004 publicado");
  console.log("\nFeedback publicado com sucesso.");
  if (feedbackLog) console.log(`Índice do feedback: ${feedbackLog.args.feedbackIndex}`);
  console.log(`Verificar: https://basescan.org/tx/${transactionHash}`);
}

main().catch((err) => {
  logger.error({ err }, "falha publicando feedback ERC-8004");
  process.exit(1);
});
