import { ERC8004_BASE_MAINNET } from "./attestation/erc8004.js";

/**
 * Registration file ERC-8004 (https://eips.ethereum.org/EIPS/eip-8004#registration-v1),
 * servido em GET /agent-card.json — é o que o `agentURI` do IdentityRegistry
 * resolve pra, formato exato exigido pelo spec (campos `type`/`name`/
 * `description`/`services`/`x402Support`/`active`/`registrations`/
 * `supportedTrust`).
 *
 * `registrations` preenchido com o agentId real, mintado em 2026-07-17 —
 * tx `0x11529ab3ce854afc41f8ec4bd04bbe74bdff2f7f6c9c3ca508ee72b5fa210239`,
 * verificável em https://basescan.org/tx/0x11529ab3ce854afc41f8ec4bd04bbe74bdff2f7f6c9c3ca508ee72b5fa210239.
 */
const AGENT_CARD = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "YieldSignal",
  description:
    "Real-time, risk-weighted yield signals: USDC/WETH lending APY across Aave, Compound, Morpho, Moonwell, Euler and Fluid on Base, plus ETH liquid staking APY across Lido, Rocket Pool, Coinbase Wrapped Staked ETH, Frax Ether and Binance Staked ETH on Ethereum mainnet — sold per-call via x402 ($0.01), REST + MCP. Every response signed (EIP-712 typed data) by the payment-receiving address; periodic on-chain attestations (EAS, Base mainnet) provide a public, permanent track record independent of this server's uptime.",
  services: [
    { name: "web", endpoint: "https://yieldsignal.vercel.app/" },
    { name: "MCP", endpoint: "https://yieldsignal.vercel.app/mcp", version: "2025-06-18" },
  ],
  x402Support: true,
  active: true,
  registrations: [{ agentId: 59272, agentRegistry: "eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }],
  // Só "reputation" por enquanto — feedback via ERC8004_BASE_MAINNET.reputationRegistry
  // (giveFeedback contra o agentId, uma vez registrado). Nenhum outro trust
  // model (crypto-economic/tee-attestation) está implementado.
  supportedTrust: ["reputation"] as const,
  // Não é um campo do spec ERC-8004 — extensão nossa, útil pra quem for
  // deixar feedback saber ONDE sem precisar ler o bytecode do IdentityRegistry.
  reputationRegistry: `eip155:8453:${ERC8004_BASE_MAINNET.reputationRegistry}`,
};

export const AGENT_CARD_JSON = JSON.stringify(AGENT_CARD, null, 2);
