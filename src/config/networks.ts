import { base, baseSepolia } from "viem/chains";
import type { Chain } from "viem";
import type { LendingAssetId } from "../market-data/types.js";

/**
 * O produto vendido é sempre sobre taxas reais da Base mainnet — não faz
 * sentido vender sinal sobre dados de testnet. Só existe uma rede de dado
 * aqui (diferente do YieldPilot, que opera testnet+mainnet); testnet só é
 * usado do lado do pagamento x402 (facilitator), não do lado do dado.
 *
 * Endereços conferidos contra a mesma fonte usada no YieldPilot
 * (config/networks.ts de lá) em 2026-07-16 — reconfira a fonte linkada
 * antes de confiar cegamente se for alterar.
 */
export interface NetworkConfig {
  chain: Chain;
  chainId: number;
  usdc: `0x${string}`;
  aave: {
    pool: `0x${string}`;
    poolDataProvider: `0x${string}`;
  };
  morpho: {
    core: `0x${string}`;
  };
  compound: {
    comet: `0x${string}`;
  };
}

export const BASE_MAINNET: NetworkConfig = {
  chain: base,
  chainId: 8453,
  // Circle docs oficiais: https://developers.circle.com/stablecoins/usdc-contract-addresses
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  aave: {
    // BaseScan "Aave: Pool Proxy Base": https://basescan.org/address/0xa238dd80c259a72e81d7e4664a9801593f98d1c5
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    // AAVE_PROTOCOL_DATA_PROVIDER em bgd-labs/aave-address-book, src/AaveV3Base.sol.
    poolDataProvider: "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
  },
  morpho: {
    // Morpho docs oficiais: https://docs.morpho.org/get-started/resources/addresses/
    core: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  },
  compound: {
    // Comet proxy pro mercado USDC — fonte oficial:
    // github.com/compound-finance/comet/blob/main/deployments/base/usdc/roots.json
    comet: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
  },
};

// Vault MetaMorpho USDC usado como referência — mesmo endereço já validado
// com depósito/saque real no YieldPilot (2026-07-16), não escolhido às cegas.
export const MORPHO_USDC_VAULT: `0x${string}` = "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61";

/**
 * Endereços por ativo vendido — cada leitor de Camada 1 (aave/compound/morpho)
 * indexa aqui em vez de receber endereço solto, pra nunca ter USDC e WETH
 * misturados por engano num cache ou numa chamada de contrato.
 *
 * WETH verificado ao vivo em 2026-07-17 (não adivinhado):
 * - token: predeploy padrão da Base (mesmo endereço em toda a Superchain),
 *   confirmado via campo `asset.address` da própria API do Morpho.
 * - compoundComet: raw.githubusercontent.com/compound-finance/comet/main/
 *   deployments/base/weth/roots.json, campo "comet" — mesma fonte oficial já
 *   citada acima pro Comet de USDC.
 * - morphoVault: maior TVL retornado pela query `vaults` da API oficial do
 *   Morpho (chainId 8453, assetSymbol WETH) — "Moonwell Flagship ETH".
 */
export const BASE_ASSETS: Record<
  LendingAssetId,
  { token: `0x${string}`; compoundComet: `0x${string}`; morphoVault: `0x${string}` }
> = {
  USDC: {
    token: BASE_MAINNET.usdc,
    compoundComet: BASE_MAINNET.compound.comet,
    morphoVault: MORPHO_USDC_VAULT,
  },
  WETH: {
    token: "0x4200000000000000000000000000000000000006",
    compoundComet: "0x46e6b214b524310239732D51387075E0e70970bf",
    morphoVault: "0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1",
  },
};

/**
 * EAS (Ethereum Attestation Service) — predeploys padrão de qualquer chain OP
 * Stack, MESMO endereço em toda a Superchain (Base incluída). Conferidos
 * direto contra `deployments/base/{EAS,SchemaRegistry}.json` em
 * github.com/ethereum-attestation-service/eas-contracts (branch master) em
 * 2026-07-17 — não adivinhados: endereço errado aqui perderia gas real sem
 * nunca registrar/atestar nada.
 */
export const EAS_BASE_MAINNET = {
  eas: "0x4200000000000000000000000000000000000021" as const,
  schemaRegistry: "0x4200000000000000000000000000000000000020" as const,
};

// Nome da conta CDP usada como carteira receptora dos pagamentos x402 — usado
// tanto por server.ts (payToConfig.accountName, explícito em vez de depender
// do default implícito do SDK) quanto por cli/withdraw.ts (getOrCreateAccount
// por nome, pra derivar o endereço de novo a partir das credenciais ATUAIS,
// nunca a partir de um endereço salvo — ver wallet/walletLock.ts).
export const X402_RECEIVER_ACCOUNT_NAME = "x402-receiver-wallet-1";

/**
 * Único lugar que mapeia X402_ENVIRONMENT pra rede — usado tanto pra ler o
 * saldo (viem/publicClient) quanto pra assinar o envio (CDP SDK), justamente
 * pra nunca ter as duas pontas apontando pra chains diferentes por causa de
 * duas cópias independentes do mesmo if/else.
 */
export function withdrawNetworkFor(
  x402Environment: "development" | "production",
): { chain: Chain; usdc: `0x${string}`; cdpNetworkName: "base" | "base-sepolia" } {
  if (x402Environment === "production") {
    return { chain: BASE_MAINNET.chain, usdc: BASE_MAINNET.usdc, cdpNetworkName: "base" };
  }
  // Endereço testnet: Circle docs oficiais (developers.circle.com/stablecoins/usdc-contract-addresses).
  return { chain: baseSepolia, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", cdpNetworkName: "base-sepolia" };
}
