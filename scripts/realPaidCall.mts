import "dotenv/config";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * Pagamento REAL em mainnet — dinheiro de verdade. Não tem faucet aqui (só
 * existe pra base-sepolia); a carteira compradora precisa já ter sido
 * financiada manualmente antes de rodar isto. Usado uma vez pra "plantar a
 * bandeira": a primeira liquidação real via facilitator CDP é o que dispara
 * a indexação automática no x402 Bazaar.
 */
async function main(): Promise<void> {
  const client = new CdpX402Client();
  const { evmAddress } = await client.getAddresses();
  console.log(`Carteira compradora (mainnet): ${evmAddress}`);

  const publicClient = createPublicClient({ chain: base, transport: http() });
  const balance = await publicClient.readContract({
    address: USDC_BASE_MAINNET,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [evmAddress],
  });

  if (balance === 0n) {
    throw new Error("Saldo zero — financie essa carteira com USDC real na Base antes de rodar este script.");
  }
  console.log(`Saldo confirmado: $${(Number(balance) / 1e6).toFixed(4)} USDC real`);

  const url = process.argv[2] ?? "http://localhost:4021/signal/usdc-base-yield";
  console.log(`\nPagando de verdade via x402 contra ${url} ...`);
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const res = await fetchWithPayment(url);

  console.log(`\nStatus da resposta: ${res.status}`);
  console.log(await res.json());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
