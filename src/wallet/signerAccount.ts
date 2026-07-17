import { CdpClient } from "@coinbase/cdp-sdk";
import { loadEnv } from "../config/env.js";
import { X402_RECEIVER_ACCOUNT_NAME, withdrawNetworkFor } from "../config/networks.js";
import { assertWalletAddress } from "./walletLock.js";

export interface SignerAccount {
  address: `0x${string}`;
  /** EIP-191 personal_sign — usado pra provar autenticidade de uma resposta, sem gas. */
  signMessage: (message: string) => Promise<`0x${string}`>;
  /** Envia uma transação já montada (to/data/value) — usado só pelos scripts de atestação, nunca em request path. */
  sendTransaction: (tx: { to: `0x${string}`; data: `0x${string}`; value?: bigint }) => Promise<`0x${string}`>;
}

let cached: Promise<SignerAccount> | undefined;

/**
 * Resolve a MESMA carteira que `createX402Server()` provisiona pra receber
 * pagamentos (mesmo nome de conta, mesmas credenciais CDP — ver
 * cli/withdraw.ts pro precedente desse padrão), mas expondo `signMessage` e
 * `sendTransaction`, que `createX402Server` não expõe. Chamado uma vez por
 * processo (cacheado); quem chama deve comparar `.address` contra
 * `server.payToEvmAddress` antes de confiar — feito em expressApp.ts.
 */
export function getSignerAccount(): Promise<SignerAccount> {
  if (!cached) {
    cached = resolve().catch((err) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}

async function resolve(): Promise<SignerAccount> {
  const env = loadEnv();
  const cdp = new CdpClient({
    apiKeyId: env.CDP_API_KEY_ID,
    apiKeySecret: env.CDP_API_KEY_SECRET,
    walletSecret: env.CDP_WALLET_SECRET,
  });
  const account = await cdp.evm.getOrCreateAccount({ name: X402_RECEIVER_ACCOUNT_NAME });
  assertWalletAddress(env.X402_ENVIRONMENT, account.address, env.EXPECTED_WALLET_ADDRESS);

  const { cdpNetworkName } = withdrawNetworkFor(env.X402_ENVIRONMENT);
  const networkAccount = await account.useNetwork(cdpNetworkName);

  return {
    address: account.address as `0x${string}`,
    signMessage: (message: string) => account.signMessage({ message }),
    sendTransaction: async ({ to, data, value }) => {
      const { transactionHash } = await networkAccount.sendTransaction({
        transaction: { to, data, value: value ?? 0n },
      });
      return transactionHash;
    },
  };
}
