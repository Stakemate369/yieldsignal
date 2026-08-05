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
  // Lidera com ETH staking, não com lending de USDC: é o asset cujo histórico
  // público de acurácia sustenta a afirmação (ver FLAGSHIP_ASSET em
  // market-data/types.ts). Preço NÃO é citado aqui de propósito — a descrição é
  // servida estaticamente e o valor real vem de PRICE_USD/DECISION_PRICE_USD no
  // desafio 402; número de preço escrito aqui desatualiza sem ninguém notar.
  description:
    "Real-time, risk-weighted yield signals for autonomous agents: ETH liquid staking APY across Lido, Rocket Pool, Coinbase Wrapped Staked ETH, Frax Ether and Binance Staked ETH on Ethereum mainnet, plus USDC/WETH lending APY across Aave, Compound, Morpho, Moonwell, Euler and Fluid on Base — sold per-call via x402, REST + MCP, no API key. Four products: the raw signal; a buyer-side MOVE/HOLD decision with expected net gain and break-even in days; a durability report splitting each APY into base vs incentive and reporting the post-incentive floor; an exit-capacity report giving per-protocol utilization and withdrawable liquidity from the protocol's own books; and a rate-sensitivity report giving each market's distance to the kink where borrow rates explode, read from the protocol's own interest rate curve. Every response signed (EIP-712 typed data) by the payment-receiving address; periodic on-chain attestations (EAS, Base mainnet) provide a public, permanent track record independent of this server's uptime, and per-asset verified accuracy is free at /accuracy.json.",
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
