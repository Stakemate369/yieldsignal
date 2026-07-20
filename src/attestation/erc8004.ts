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

// Fragmento mínimo — só `giveFeedback` (chamado por cli/giveFeedback.ts, NUNCA
// por este servidor: `isAuthorizedOrOwner(msg.sender, agentId)` bloqueia
// owner/operador) + o evento `NewFeedback` pra decodificar o recibo. Assinatura
// conferida contra o source real (github.com/erc-8004/erc-8004-contracts,
// contracts/ReputationRegistryUpgradeable.sol, branch master) — MESMO rigor
// do IDENTITY_REGISTRY_ABI acima, mas SEM uma transação real já confirmada
// pra validar contra (ninguém deixou feedback ainda). `value`/`valueDecimals`
// é um número de ponto fixo sem escala fixa definida pelo contrato (ex.:
// value=80, valueDecimals=0 → "80"); `tag1`/`tag2`/`endpoint`/`feedbackURI`
// são strings livres, sem semântica imposta on-chain.
export const REPUTATION_REGISTRY_ABI = [
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "NewFeedback",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "clientAddress", type: "address", indexed: true },
      { name: "feedbackIndex", type: "uint64", indexed: false },
      { name: "value", type: "int128", indexed: false },
      { name: "valueDecimals", type: "uint8", indexed: false },
      { name: "indexedTag1", type: "string", indexed: true },
      { name: "tag1", type: "string", indexed: false },
      { name: "tag2", type: "string", indexed: false },
      { name: "endpoint", type: "string", indexed: false },
      { name: "feedbackURI", type: "string", indexed: false },
      { name: "feedbackHash", type: "bytes32", indexed: false },
    ],
  },
] as const;
