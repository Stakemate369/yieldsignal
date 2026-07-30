// SOMENTE LEITURA — não assina nada, não gasta nada.
// Mostra o endereço da carteira COMPRADORA de teste e seu saldo de USDC/ETH
// na Base mainnet, pra saber se dá pra fazer uma chamada paga real.
import "dotenv/config";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, formatEther, http } from "viem";
import { base } from "viem/chains";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

const cdp = new CdpClient({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
  walletSecret: process.env.CDP_WALLET_SECRET,
});

const buyer = await cdp.evm.getOrCreateAccount({ name: "x402-client-wallet-1" });
console.log("carteira compradora:", buyer.address);

const pub = createPublicClient({ chain: base, transport: http() });
const [usdc, eth] = await Promise.all([
  pub.readContract({ address: USDC_BASE, abi: BALANCE_ABI, functionName: "balanceOf", args: [buyer.address] }),
  pub.getBalance({ address: buyer.address }),
]);

console.log("USDC na Base mainnet:", Number(usdc) / 1e6);
console.log("ETH na Base mainnet: ", formatEther(eth));
console.log("\ncusto das 2 rotas faltantes no Bazaar: 0.01 + 0.05 = 0.06 USDC");
console.log(Number(usdc) >= 60000 ? "-> saldo SUFICIENTE" : "-> saldo INSUFICIENTE, precisa depositar USDC nessa carteira");
