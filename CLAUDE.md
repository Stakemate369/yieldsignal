# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                # instala dependências
npm test                   # roda toda a suíte (vitest run)
npm run test:watch         # vitest em modo watch
npx tsc --noEmit           # typecheck sem gerar arquivos — rodar depois de qualquer mudança
npm run signal               # calcula e imprime o sinal AGORA, com dados reais — sem servidor, sem carteira, sem credencial CDP nenhuma (USDC por padrão; `npm run signal -- WETH` pro outro ativo)
npm run dev                 # sobe o servidor x402 (lê X402_ENVIRONMENT do .env pra decidir development/production)
npm run test:paid           # cria uma carteira compradora de teste, pega USDC de teste no faucet da CDP, e faz uma chamada paga de verdade contra localhost:4021 — só funciona em development
npm run withdraw            # saca o USDC acumulado pra OWNER_WALLET_ADDRESS — pede confirmação manual digitada "CONFIRM"
npm run register-schema     # registra o schema EAS uma única vez (mainnet, gasta gas real) — pede "CONFIRM"
npm run attest               # publica UMA atestação on-chain do sinal atual (mainnet, gasta gas real) — pede "CONFIRM"
npm run register-agent      # mint único de identidade ERC-8004 (mainnet, gasta gas real) — pede "CONFIRM"
```

Não existe script de lint configurado ainda.

## Arquitetura

Vende, via protocolo x402, o mesmo tipo de sinal matemático que o projeto irmão YieldPilot calcula pra si mesmo: qual protocolo de lending em USDC na Base paga mais agora, ajustado por risco. Projeto **totalmente separado** do YieldPilot — credenciais CDP próprias (projeto "yieldsignal" no portal, não "yieldpilot"), carteira própria, sem nenhum import cruzado entre os dois repositórios. Ver `SECURITY.md` pro modelo de ameaça completo.

### Duas camadas de fonte de dado, expostas com transparência

`market-data/types.ts` define `ProtocolId` como `DirectProtocolId` (aave/morpho/compound — lidos on-chain/API oficial) + `DefiLlamaProtocolId` (moonwell/euler/fluid — via `yields.llama.fi/pools`, promovido de simples cross-check pra fonte primária). Cada `RateReading` carrega `source` (`onchain`/`api`/`defillama`) e `readAt` — o produto vendido expõe a própria proveniência do dado, não só o número.

Spark, Seamless e Silo foram pesquisados e **deliberadamente excluídos**: checagem manual contra `yields.llama.fi/pools` em 2026-07-16 (`chain=Base`, `symbol=USDC`) não achou nenhum mercado USDC real pra eles na Base (Spark só tem um pool em USDS). Não adicionar de volta sem repetir essa checagem — ver comentário em `market-data/types.ts`.

### `signal/collectRates.ts` degrada graciosamente — um protocolo a menos, não um erro 500

Cada leitor da Camada 1 roda via `Promise.allSettled`; cada leitor da Camada 2 (`market-data/defillamaPools.ts`) captura sua própria exceção e retorna `null` em vez de lançar. Só falha (e derruba a chamada paga) se **nenhuma** fonte respondeu. `computeSignal()` (`signal/computeSignal.ts`) é puro/sem I/O, mesmo espírito do `strategy/decision.ts` do YieldPilot — mas sem histerese: aqui não existe posição pra manter, cada chamada só reporta o estado atual do mercado.

### `defillamaPools.ts` — cache com dedup de chamada em voo

As 3 leituras da Camada 2 disparam em paralelo (`Promise.all` em `collectRates.ts`); sem uma promise-em-voo compartilhada (`inFlight` em `fetchPools()`), as 3 bateriam na API da DefiLlama 3x a cada chamada paga, mesmo com cache de 5min, porque todas chegam antes da primeira preencher o cache. Bug real encontrado em revisão (2026-07-16), confirmado ao vivo comparando `asOf` dos 3 protocolos antes/depois do fix.

### Carteira receptora: auto-provisionada, nunca configurada à mão — e a trava tem que re-derivar, não reler

`server.ts` usa `createX402Server({ payToConfig: { type: "eoa", accountName: X402_RECEIVER_ACCOUNT_NAME } })` (`@coinbase/cdp-sdk/x402`) — o nome da conta é fixado explicitamente em `config/networks.ts` (`X402_RECEIVER_ACCOUNT_NAME = "x402-receiver-wallet-1"`) em vez de depender do default implícito do SDK, justamente pra `cli/withdraw.ts` conseguir resolver a MESMA conta de forma independente via `cdp.evm.getOrCreateAccount({ name })`.

**Bug real encontrado em revisão (2026-07-16), já corrigido:** a primeira versão de `withdraw.ts` lia o endereço do lock file e usava ESSE MESMO endereço pra buscar a conta (`getAccount({ address: lockedAddress })`) — a trava de segurança comparava o endereço consigo mesmo, nunca detectaria uma troca de `CDP_WALLET_SECRET`. Correto é sempre re-derivar pelo NOME da conta a partir das credenciais atuais, e só então comparar contra o lock (`wallet/walletLock.ts`).

### `withdraw.ts` não retenta a transferência real — só a leitura

Diferente do `retryUntil` usado pra ler saldo, o envio de fundo (`.transfer(...)`, helper nativo do CDP SDK que resolve `token: "usdc"` sem precisar montar calldata ERC-20 à mão) nunca é reenviado automaticamente: um erro "transitório" de RPC pode ter acontecido DEPOIS do envio já ter sido aceito, e reenviar às cegas arriscaria sacar duas vezes. Em erro, o código relê o saldo pra dar um diagnóstico seguro (saldo caiu = pode ter ido mesmo com erro; saldo intacto = seguro tentar de novo) em vez de decidir sozinho.

### Testando pagamento de verdade com dinheiro de teste — corrida entre faucet e pagamento

`scripts/testPaidCall.mts` cria uma carteira compradora separada (`CdpX402Client`, nome default `"x402-client-wallet-1"` — diferente da carteira receptora), pede USDC de teste no faucet da própria CDP (`account.requestFaucet({ network: "base-sepolia", token: "usdc" })`) e paga via `wrapFetchWithPayment` (`@x402/fetch`). **Não dá pra pagar imediatamente depois de pedir o faucet** — a transação do faucet ainda não confirmou on-chain nesse instante, e o pagamento falha silenciosamente (402 de novo). O script usa `retryUntil` (`execution/retry.ts`) pra esperar o saldo aparecer antes de tentar pagar.

### Dependências: dois problemas reais só apareceram com credenciais de verdade instaladas

- **Peer dependencies opcionais que na prática são obrigatórias**: `@coinbase/cdp-sdk` declara `@x402/core`, `@x402/evm`, `@x402/svm`, `@x402/extensions` como peer deps *opcionais*, mas `_esm/x402/server-extensions.js` importa `@x402/evm` e `@x402/svm` incondicionalmente em runtime. Sem instalar os dois como dependência direta, `npm run dev` falha com `ERR_MODULE_NOT_FOUND` só na hora de rodar (typecheck não pega isso).
- **Dual package hazard entre `@coinbase/cdp-sdk` e `@x402/express`**: com `moduleResolution: "NodeNext"`, o TypeScript via duas declarações diferentes de `x402HTTPResourceServer` como tipos incompatíveis (`"Types have separate declarations of a private property"`) ao passar `X402Server` pra `paymentMiddlewareFromHTTPServer`. Resolvido trocando `tsconfig.json` pra `"module": "ESNext"` + `"moduleResolution": "bundler"` — não afeta a execução via `tsx` (que ignora esses campos pra transpilar).

### Portal da CDP — criar API key exige desmarcar "Opt-out of IP allowlisting"

O botão "Create" do modal de criar Secret API Key fica visualmente parecido mas fica DESABILITADO até você marcar "Opt-out of IP allowlisting" (ou preencher uma faixa de IP) — clicar nele sem isso não faz nada, sem nenhuma mensagem de erro visível.

### Multi-ativo (USDC + WETH) — `AssetId`/`BASE_ASSETS`, um cache por ativo

`market-data/types.ts` define `AssetId = "USDC" | "WETH"`; `config/networks.ts` define `BASE_ASSETS[asset]` com o endereço do token, o Comet do Compound e o vault do Morpho pra cada um. Cada leitor de Camada 1 (`aave.ts`/`compound.ts`/`morpho.ts`) mantém **um `cachedWithTtl` por asset** (`Record<AssetId, () => Promise<RateReading>>`), não um só — senão uma leitura de WETH serviria do cache de USDC (ou vice-versa) até o TTL expirar. Na Camada 2 (`defillamaPools.ts`), o `symbol` esperado na resposta da DefiLlama muda por PROJETO, não só por asset: WETH aparece como `"ETH"` na Moonwell/Fluid mas como `"WETH"` na Euler — por isso `POOLS` guarda `symbol` por entrada em vez de fixar um valor global (era `p.symbol === "USDC"` fixo antes da expansão).

Endereços WETH verificados ao vivo em 2026-07-17 (mesma exigência de "não adivinhar" que já regia USDC): predeploy padrão `0x4200...0006` (confirmado via API do Morpho), Comet WETH via `roots.json` oficial do compound-finance no GitHub, vault MetaMorpho de maior TVL pra WETH via query `vaults` da API do Morpho. **cbBTC não entrou** — existe mercado na Base (não WBTC, que não existe lá), mas a APY de supply fica quase sempre 0-0.2% em todo protocolo, sinal pouco útil de vender.

### Instrumentação de receita — `onAfterSettle` em DUAS instâncias separadas de `x402ResourceServer`

O REST (`expressApp.ts`) e o MCP (`mcp.ts`) usam cada um sua PRÓPRIA instância de `x402ResourceServer` — não existe uma instância compartilhada, então `notify/paymentLog.ts` precisa ser registrado (`.onAfterSettle(...)`) em cada uma separadamente, cada vez com o `channel` certo (`"rest"`/`"mcp"`). O hook dá acesso a `payer`/`transaction`/`network`/`amount` reais da liquidação (`SettleResultContext`, de `@x402/core/server`) — dado do próprio SDK de pagamento, não inferido. `requirements.asset` nesse contexto é o TOKEN usado pra pagar (USDC), não confundir com o `AssetId` do produto (USDC/WETH) — por isso o log usa o nome de campo `paymentToken`, não `asset`. `resourceUrl` (de `paymentPayload.resource?.url`) é best-effort, populado pelo próprio `x402HTTPResourceServer` a partir da rota que gerou o 402 original — não uma garantia rígida. O hook nunca lança (try/catch interno): uma falha de log não pode derrubar uma liquidação que já aconteceu.

Separado disso, cada handler de rota/tool loga uma linha de **uso** (não de pagamento) na hora — cobre TAMBÉM as chamadas de free trial, que o hook de settlement nunca vê. É essa linha, não a de pagamento, que responde "isso está sendo usado?" antes mesmo de dar receita — mesma lição do QuantumScan, que ficou 30 dias sem saber que x402 dava $0 (ver memória `feedback_quantumscan_monetization_reality`).

### Confiança verificável — assinatura por resposta (grátis) + atestação EAS (gasta gas, manual)

Motivação: o índice que classifica endpoints x402 (ex.: `x402.fuchss.app`) mede uptime/latência/estabilidade DO PRÓPRIO SERVIDOR, não a fonte de dado — usar um oráculo tipo Chainlink não ajudaria diretamente (Chainlink não tem feed de APY de lending), e o ganho real está em provar que o servidor não pode mentir sem deixar rastro.

- **Resposta assinada (sempre, sem custo)**: `wallet/signerAccount.ts` resolve a MESMA carteira que `createX402Server` provisiona (mesmo nome de conta), mas expondo `signMessage`/`sendTransaction`, que `createX402Server` não expõe — por isso a resolução acontece duas vezes em `createApp()`, com um `if` comparando os dois endereços resolvidos (barato, pega de graça qualquer divergência). `signal/signResponse.ts` assina (EIP-191) o texto EXATO que vai no corpo da resposta — por isso `expressApp.ts` usa `res.send(raw)` em vez de `res.json(signal)` (evitaria re-serialização com formatação diferente da que foi assinada). REST expõe em headers (`X-Signal-Signature`/`X-Signal-Signer`); MCP expõe como um segundo content block (nunca embutido no MESMO JSON — obrigaria o cliente a reconstruir o texto exato assinado, frágil). Nunca lança: o comprador já pagou antes desse ponto do código rodar, então falha ao assinar só loga warning e serve sem assinatura.
- **Atestação on-chain (EAS, Base mainnet, manual)**: `src/attestation/schema.ts` define o schema (`asset,bestProtocol,weightedApyBps,gapBps,asOf`) e os fragmentos mínimos de ABI do `EAS`/`SchemaRegistry` (endereços em `config/networks.ts#EAS_BASE_MAINNET` — predeploys padrão de qualquer chain OP Stack, `0x...0020`/`0x...0021`, conferidos direto contra `deployments/base/*.json` do repo oficial `ethereum-attestation-service/eas-contracts`, não adivinhados). `src/attestation/encodeSignalAttestation.ts` é puro (testado em `test/encodeSignalAttestation.test.ts`). `cli/registerSchema.ts` (uma vez) e `cli/attestSignal.ts` (repetível) seguem o MESMO padrão de `cli/withdraw.ts`: `CONFIRM` digitado à mão, nunca automático — cada atestação gasta ETH real de gas. UID da atestação vem de decodificar o evento `Attested`/`Registered` do recibo da transação (nunca calculado à mão) — evita depender de replicar a fórmula de hash do EAS. `attestation/publishAttestation.ts` extrai a parte "monta calldata → envia tx → aguarda recibo → decodifica UID" pra ser reaproveitada tanto por `cli/attestSignal.ts` (recebe o sinal JÁ calculado, pra poder mostrar pro usuário ANTES do CONFIRM sem recalcular) quanto pelo gatilho automático abaixo.

### Atestação automática — gatilho por mudança/staleness (attestation/autoAttest.ts), não por chamada paga

Atestar em TODA chamada paga não tem teto de custo (cresce com tráfego). Em vez disso, `POST /internal/auto-attest` (protegido por `Authorization: Bearer ${CRON_TRIGGER_SECRET}` — **fail-closed**: `CRON_TRIGGER_SECRET` vazio SEMPRE nega, diferente do padrão "vazio = endpoint aberto" usado em checks read-only, porque esta rota gasta ETH real) decide, pra cada asset, se vale atestar agora: sem atestação anterior, `bestProtocol` mudou, `gapBps` mudou ≥25bps, ou já fazem mais de 12h desde a última (`decideAutoAttest`, puro, testado em `test/autoAttest.test.ts`). A "última atestação" vem direto do GraphQL do EASScan (`attestation/queryAttestations.ts`, `https://base.easscan.org/graphql`, filtrando por `schemaId`+`attester`) — nenhum banco novo precisa existir só pra isso, o `decodedDataJson` já vem decodificado pelo próprio EASScan. Antes de gastar gas, `publishAttestation` também checa `MIN_GAS_RESERVE_ETH`: abaixo do piso, lança `InsufficientGasError` em vez de drenar o saldo (logado como warning, não derruba a rota). Gatilho pensado pra **cron-job.org** (mesmo serviço externo já usado pro `/health`), não Vercel Cron — Hobby só dispara 1x/dia, cedo demais. `npm run attest` (CLI manual) continua existindo sem mudança.

### Dashboard de track record (GET /track-record, /track-record.json) — sem banco novo

Fonte da verdade é o próprio EAS: `attestation/trackRecord.ts` busca o histórico de atestações (mesmo `queryAttestations.ts` do auto-attest) e, pra cada ASSET distinto (não por atestação), lê a taxa ATUAL do protocolo atestado via `collectRates`/`computeSignal` já existentes — mostra "o que dissemos então vs. o que é verdade agora" (`stillBest`). Honesto sobre a limitação: não é um backtest de preço histórico exato (não há indexação própria de APY por bloco passado). `/track-record` é uma casca HTML estática (`src/trackRecordPage.ts`, mesmo estilo de `landingPage.ts`) que busca `/track-record.json` via JS no navegador — nenhuma lógica de servidor duplicada.

### Assinatura de resposta migrada de EIP-191 pra EIP-712 (signal/signResponse.ts)

Struct `YieldSignal(string asset,string bestProtocol,uint256 weightedApyBps,uint256 gapBps,uint64 asOf,bytes32 contentHash)` — os mesmos 5 campos do schema EAS (`SIGNAL_SCHEMA_TYPES`, reaproveitado diretamente, nunca duplicado) + `contentHash` (`keccak256` do texto EXATO servido), amarrando o struct tipado ao corpo completo (que inclui `rates[]`, não só os campos manchete que vão on-chain). `domain.chainId` não é sobre nenhuma tx (não existe contrato verificador) — só desambiguação de contexto. `wallet/signerAccount.ts` expõe `signTypedData` (CDP SDK já tem `account.signTypedData`, mesmo formato `TypedDataDefinition` do viem). Transporte: `eip712ForTransport()` achata os `bigint` do struct pra string decimal (JSON.stringify não serializa bigint) — REST expõe em `X-Signal-Eip712-Payload` (+ `X-Signal-Signature`/`X-Signal-Signer`, mantidos), MCP num bloco de texto irmão. Cliente (`client/src/index.ts#verifySignalPayload`/`getSignalVerified`) reconstrói os `bigint` a partir das strings e roda `viem.verifyTypedData` + confere `contentHash === keccak256(raw)` (as DUAS checagens precisam passar) — sempre contra o texto BRUTO (`res.text()`), nunca `JSON.stringify(res.json())` (reserializar arrisca bytes diferentes dos assinados). Prova ao vivo feita nesta sessão: chamada real contra o servidor em produção, assinatura verificada com `viem.verifyTypedData`, e um corpo adulterado (1 byte trocado) falhando a checagem de `contentHash` como esperado.

### Identidade ERC-8004 (attestation/erc8004.ts, agentCard.ts, cli/registerAgent.ts)

[ERC-8004 "Trustless Agents"](https://eips.ethereum.org/EIPS/eip-8004) tem `IdentityRegistry`/`ReputationRegistry` deployados no MESMO endereço (CREATE2 determinístico) em toda chain, Base mainnet incluída — confirmado nesta sessão com `eth_getCode` direto contra `mainnet.base.org` (bytecode real presente, não só o README do repo `erc-8004/erc-8004-contracts` AFIRMANDO isso — mesmo rigor já aplicado ao EAS, ver [[feedback_eas_op_stack_predeploy_abi_mismatch]]). `GET /agent-card.json` serve o registration file no formato exato do spec (`type`/`name`/`description`/`services`/`x402Support`/`active`/`registrations`/`supportedTrust`); `registrations` começa vazio de propósito — só existe `agentId` DEPOIS do mint. `cli/registerAgent.ts` (mesmo padrão `CONFIRM` de `registerSchema.ts`) chama `IdentityRegistry.register(agentURI)` uma vez e imprime a entrada exata pra colar em `src/agentCard.ts`. `ReputationRegistry` é só DOCUMENTADO (endereço no card) — quem chama `giveFeedback` é o COMPRADOR, o contrato bloqueia self-feedback do owner/operador.
