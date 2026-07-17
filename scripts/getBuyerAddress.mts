import "dotenv/config";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";

/**
 * Imprime o endereço da carteira compradora de teste (a mesma que
 * scripts/testPaidCall.mts / realPaidCall.mts usam) sem fazer nenhuma
 * chamada — só pra saber pra onde mandar fundo antes de rodar o pagamento
 * de verdade em mainnet (não existe faucet de mainnet, tem que financiar
 * manualmente).
 */
async function main(): Promise<void> {
  const client = new CdpX402Client();
  const { evmAddress } = await client.getAddresses();
  console.log(evmAddress);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
