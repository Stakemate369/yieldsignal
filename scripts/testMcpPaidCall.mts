import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { fromCdpEvmAccount } from "@coinbase/cdp-sdk/x402";
import { CdpClient } from "@coinbase/cdp-sdk";

/**
 * Testa a tool MCP paga (get_yield_signal) contra o servidor local, usando
 * a MESMA carteira compradora de teste dos outros scripts. Development =
 * base-sepolia (dinheiro de teste); precisa já ter saldo (rodar
 * scripts/testPaidCall.mts primeiro, ou o faucet ali mesmo).
 */
async function main(): Promise<void> {
  const cdp = new CdpClient({
    apiKeyId: process.env.CDP_API_KEY_ID,
    apiKeySecret: process.env.CDP_API_KEY_SECRET,
    walletSecret: process.env.CDP_WALLET_SECRET,
  });
  const account = await cdp.evm.getOrCreateAccount({ name: "x402-client-wallet-1" });
  console.log(`Carteira compradora: ${account.address}`);

  const paymentClient = new x402Client();
  registerExactEvmScheme(paymentClient, { signer: fromCdpEvmAccount(account) });

  const mcpClient = new Client({ name: "yieldsignal-test-buyer", version: "1.0.0" });
  const url = process.argv[2] ?? "http://localhost:4021/mcp";
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await mcpClient.connect(transport);

  const x402Mcp = wrapMCPClientWithPayment(mcpClient, paymentClient, { autoPayment: true });

  console.log(`\nChamando a tool "get_yield_signal" via MCP contra ${url} ...`);
  const result = await x402Mcp.callTool("get_yield_signal", {});

  console.log("\nResultado:");
  console.log(JSON.stringify(result, null, 2));

  await mcpClient.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
