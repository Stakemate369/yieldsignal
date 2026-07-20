/**
 * ERC-8004 "Trustless Agents" (https://eips.ethereum.org/EIPS/eip-8004) —
 * `IdentityRegistry` (ERC-721 com URIStorage) dá ao YieldSignal um handle
 * portável e descobrível por outros agentes/frameworks, fora dos diretórios
 * x402 (que hoje são a única forma de descoberta). `ReputationRegistry`
 * deixa QUEM COMPROU deixar feedback on-chain contra o `agentId` — não é
 * algo que ESTE servidor chama (chamar `giveFeedback` sobre si mesmo é
 * bloqueado pelo contrato, "Self-feedback not allowed"), só documentado
 * aqui + em `agentCard.ts` pra quem quiser deixar feedback saber onde.
 *
 * Endereços: CREATE2 determinístico, MESMO endereço em toda chain onde o
 * projeto foi deployado — confirmado ao vivo nesta sessão (2026-07-17) com
 * `eth_getCode` direto contra `mainnet.base.org` (bytecode real presente na
 * Base mainnet, não só o que o README do repo AFIRMA que está deployado —
 * mesmo rigor já aplicado ao EAS, ver schema.ts e o gotcha real que motivou
 * essa disciplina: feedback_eas_op_stack_predeploy_abi_mismatch). Fonte:
 * github.com/erc-8004/erc-8004-contracts (branch master), README.md — ABI
 * conferido contra contracts/IdentityRegistryUpgradeable.sol e
 * contracts/ReputationRegistryUpgradeable.sol do mesmo repo/branch.
 */
export const ERC8004_BASE_MAINNET = {
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const,
  reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const,
};

// Fragmento mínimo — só a sobrecarga de `register` que este projeto chama
// (uma vez, via cli/registerAgent.ts): agentURI sem metadata extra.
export const IDENTITY_REGISTRY_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;
