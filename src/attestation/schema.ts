/**
 * Registro público e permanente (EAS na Base mainnet) do sinal vendido —
 * ver [[project_yieldsignal_agent]] no porquê: o índice de confiança que
 * classifica endpoints x402 mede uptime/estabilidade do PRÓPRIO servidor,
 * não a fonte de dado; uma atestação on-chain prova que o número servido
 * numa data específica bateu com a realidade, sem exigir que o comprador
 * confie no uptime do servidor no momento da checagem.
 *
 * Só os campos "manchete" do sinal entram no esquema (protocolo vencedor,
 * taxa dele, vantagem sobre o 2º) — não a lista inteira de leituras: é esse
 * o dado que vale a pena provar depois, e calldata menor custa menos gas.
 */
export const SIGNAL_SCHEMA = "string asset,string bestProtocol,uint256 weightedApyBps,uint256 gapBps,uint64 asOf";

// Tipos dos campos do schema acima, na mesma ordem — usado tanto pra montar
// quanto (futuramente) decodificar o `data` da atestação.
export const SIGNAL_SCHEMA_TYPES = [
  { name: "asset", type: "string" },
  { name: "bestProtocol", type: "string" },
  { name: "weightedApyBps", type: "uint256" },
  { name: "gapBps", type: "uint256" },
  { name: "asOf", type: "uint64" },
] as const;

// Fragmentos mínimos de ABI (só o que este projeto chama) — endereços
// conferidos em config/networks.ts (EAS_BASE_MAINNET), não repetidos aqui.
export const SCHEMA_REGISTRY_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schema", type: "string" },
      { name: "resolver", type: "address" },
      { name: "revocable", type: "bool" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  // ATENÇÃO: o predeploy real na Base (0x...0020) NÃO bate com o ABI
  // publicado em `deployments/base/SchemaRegistry.json` do repo oficial
  // ethereum-attestation-service/eas-contracts — aquele JSON documenta uma
  // versão mais nova (`Registered(bytes32 indexed uid, address indexed
  // registerer, SchemaRecord schema)`), enquanto o predeploy congelado no
  // genesis da OP Stack emite só 2 campos, sem o `schema`. Confirmado ao
  // vivo em 2026-07-17 inspecionando o log de uma transação real de
  // `register()` (topic0 bateu com `keccak256("Registered(bytes32,address)")`,
  // não com a versão de 3 campos) — não repetir o erro de confiar cegamente
  // no JSON do repo pra esse endereço específico.
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "uid", type: "bytes32", indexed: true },
      { name: "registerer", type: "address", indexed: false },
    ],
  },
] as const;

export const EAS_ABI = [
  {
    type: "function",
    name: "attest",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  // Ao contrário do `Registered` do SchemaRegistry (ver comentário acima),
  // este SIM bate com o predeploy real — confirmado em 2026-07-17 comparando
  // o topic0 contra atestações reais já existentes no EAS da Base mainnet
  // (`getLogs` num intervalo recente, topic0 = keccak256("Attested(address,
  // address,bytes32,bytes32)"), igual ao daqui).
  {
    type: "event",
    name: "Attested",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "attester", type: "address", indexed: true },
      { name: "uid", type: "bytes32", indexed: false },
      { name: "schemaUID", type: "bytes32", indexed: true },
    ],
  },
] as const;
