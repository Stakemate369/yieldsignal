import { createPublicClient, http } from "viem";
import { BASE_MAINNET } from "../config/networks.js";

/**
 * Um só PublicClient reaproveitado por todos os leitores on-chain da Camada 1
 * — cada chamada paga do endpoint aciona Aave + Compound em paralelo
 * (collectRates.ts); não faz sentido cada um instanciar o próprio client.
 */
export const basePublicClient = createPublicClient({ chain: BASE_MAINNET.chain, transport: http() });
