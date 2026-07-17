import "dotenv/config";
import { CdpClient } from "@coinbase/cdp-sdk";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { retryUntil } from "../src/execution/retry.js";

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * Simula um agente comprador de verdade: tem sua própria carteira CDP
 * (separada da carteira receptora do servidor), pede USDC de teste no
 * faucet da própria CDP pra base-sepolia, e paga a chamada via x402.
 * Só funciona em development/base-sepolia — dinheiro de teste, sem risco.
 */
async function main(): Promise<void> {
  const cdp = new CdpClient({
    apiKeyId: process.env.CDP_API_KEY_ID,
    apiKeySecret: process.env.CDP_API_KEY_SECRET,
    walletSecret: process.env.CDP_WALLET_SECRET,
  });

  const client = new CdpX402Client();
  const { evmAddress } = await client.getAddresses();
  console.log(`Carteira compradora de teste: ${evmAddress}`);

  const buyerAccount = await cdp.evm.getAccount({ address: evmAddress });
  console.log("Pedindo USDC de teste no faucet da CDP (base-sepolia)...");
  const faucetResult = await buyerAccount.requestFaucet({ network: "base-sepolia", token: "usdc" });
  console.log(`Faucet enviado: ${faucetResult.transactionHash} — esperando confirmar on-chain...`);

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const balance = await retryUntil(
    () =>
      publicClient.readContract({
        address: USDC_BASE_SEPOLIA,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [evmAddress],
      }),
    (b) => b > 0n,
    { attempts: 10, delayMs: 3000 },
  );
  console.log(`Saldo confirmado: ${Number(balance) / 1e6} USDC de teste`);

  console.log("\nChamando o endpoint pago (o fetch vai completar o pagamento x402 sozinho)...");
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const res = await fetchWithPayment("http://localhost:4021/signal/usdc-base-yield");

  console.log(`\nStatus da resposta: ${res.status}`);
  console.log(await res.json());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
