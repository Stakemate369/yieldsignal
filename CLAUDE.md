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
npm run bazaar:check        # compara o preço anunciado no índice do Bazaar com o que cada rota cobra hoje — não gasta nada
npm run bazaar:sync         # paga UMA chamada real em cada rota divergente pra reescrever o preço no índice (gasta USDC da carteira compradora)
npm run fund-buyer -- 1.50  # devolve USDC da receptora pra compradora, pra manutenção nunca precisar de aporte externo
```

### Manutenção paga é um CICLO FECHADO — nunca peça aporte novo

As chamadas de `bazaar:sync` saem da carteira COMPRADORA e caem na RECEPTORA, as duas do dono: o dinheiro troca de bolso, não é gasto. Quando a compradora seca, o valor está na receptora — a resposta certa é `npm run fund-buyer`, não pedir depósito. Só existe custo real se a receptora também estiver vazia.

`bazaar:sync` é IDEMPOTENTE por `state/bazaar-sync.json` (gitignorado, carência de 12h). Isso não é otimização: o Bazaar leva horas pra refletir uma liquidação, então uma segunda execução relê o índice, ainda vê o preço antigo e conclui que a rota continua fora de sincronia. Sem a trava, rodar duas vezes no mesmo dia paga tudo de novo — aconteceu em 2026-08-10 e secou a carteira antes de chegar nas rotas que faltavam. O marcador é gravado a cada sucesso, não no fim do laço, pra que morrer no meio não vire pagamento repetido.

`/exposure/*` exige `?positions=`; chamar a URL nua gasta o pagamento e devolve 400, porque o middleware x402 liquida ANTES do handler rodar. Rota com parâmetro obrigatório precisa entrar em `PARAMETROS_OBRIGATORIOS` no script.

### O índice do Bazaar é EMPURRADO por venda, não consultado

O `lastUpdated` de cada entrada bate exatamente com o timestamp da última liquidação naquela rota: o Bazaar guarda o retrato tirado no último pagamento, e não há endpoint pra atualizar a entrada de outro jeito. Consequência prática: **toda mudança de preço deixa as 14 entradas anunciando o valor antigo até que cada rota receba um pagamento novo** — e um comprador automático que leia o índice monta a transação com o valor de lá, é recusado, e o comportamento padrão diante de recusa repetida é marcar o endpoint como quebrado. Por isso `bazaar:sync` existe e por isso ele roda depois de qualquer mexida em `PRICE_USD`/`ANALYTICS_PRICE_USD`/`DECISION_PRICE_USD`.

Ao varrer o índice, pagine até `pagination.total` — são ~14.500 recursos. Uma varredura parcial (as primeiras 1.200 entradas) fez concluir em 2026-08-10 que nenhuma rota estava indexada, quando as 14 estavam.

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

### Produtos analíticos: /durability/* e /capacity/* (2026-08-05)

Duas famílias de rota pagas novas (preço BASE, não o premium da decisão — produto novo ainda sem track record próprio), mais as tools MCP `get_yield_durability` e `get_exit_capacity`. As duas derivam de leituras que `collectRates` JÁ faz: nenhuma fonte nova, nenhuma chamada RPC extra.

**As duas são SÓ `LendingAssetId` (USDC/WETH), não os 3 assets** — e por medição, não por preguiça. Capacidade: staking não tem mercado de empréstimo, a saída lá é resgate/swap. Durabilidade: checado ao vivo em 2026-08-05, os 5 protocolos de staking vêm da DefiLlama com `apyReward: null`, ou seja 0 de 5 decomponíveis em TODA chamada — a rota cobraria pra devolver "não consigo afirmar nada". Por isso `/durability` e `/capacity` sem asset resolvem pra USDC e não pro `FLAGSHIP_ASSET` (que é ETH_STAKING).

- **`signal/durability.ts`** (puro) decompõe `supplyApyBps` em base + incentivo e devolve o piso pós-incentivo. Só decompõe `rewardBasis` `reported`/`inferred`; `included-not-itemized`/`unavailable` entram em `undecomposable` e **nunca** viram "sem incentivo". Guarda central: se o LÍDER ATUAL não é decomponível, `rankingChangesWithoutIncentives` é `null` (não `false`) — sem saber o piso dele, qualquer afirmação de troca de ranking seria invenção. `bestVerifiableFloor` existe pra resposta não sair vazia nesse caso: é o maior piso que se consegue provar.
- **`signal/capacity.ts`** (puro) + `market-data/depth.ts#marketLiquidity`. Utilização e liquidez sacável saem dos livros do protocolo na MESMA leitura que já trazia a taxa: Aave usa o tuple do `getReserveData` (`totalAToken` vs `totalStableDebt`+`totalVariableDebt`), Compound deriva o emprestado de `getUtilization()` × `totalSupply()` (ambos já lidos). Morpho e toda a Camada 2 não expõem emprestado → `measured: false`, e um protocolo não medido NUNCA entra como `bestProtocolExecutable`. `availableLiquidityUsd` é 0 (não `null`) num mercado 100% utilizado — zero sacável é medição, e foi por isso que `stableUnits` existe separado de `onchainDepthUsd`, que corta em `> 0`.

**Merkl foi avaliada e descartada** (checagem ao vivo em 2026-08-05, documentada em `durability.ts`): a API tem `earliestCampaignEnd`, mas Aave/Compound/Euler/Fluid não têm nenhuma campanha `LEND` na Base, Morpho/Moonwell só aparecem como vaults MetaMorpho que não são os mercados lidos aqui, e `status=PAST` devolve timestamps nulos (sem histórico de renovação). Cobrir 2 de 6 com casamento adivinhado, num universo onde a maioria das campanhas é semanal e renova, geraria alarme falso recorrente. Não reintroduzir sem refazer essa checagem.

### /sensitivity/* — a curva de juros, e por que o client agora usa multicall (2026-08-05)

Terceira rota analítica, e a primeira que fala com o lado TOMADOR. `market-data/rateCurve.ts` normaliza as duas curvas suportadas na MESMA forma (joelho + três âncoras: u=0, u=kink, u=100%), porque ambas são lineares por partes na taxa NATIVA — a interpolação tem que ser feita ali e só depois convertida pra APY, nunca o contrário (a conversão é composta e não-linear).

Cada leitura vem com uma prova viva anexada, e é isso que separa esta rota de um chute com cara de precisão:
- **Compound** (`onchain-rate-function`): a curva reconstruída é conferida a cada leitura contra `getBorrowRate(u)`, função PURA do Comet. Bateu wei a wei em 50/85/90/93/99% na validação de 2026-08-05. Divergiu? Omite.
- **Aave** (`onchain-curve-params`): não há função pura pra comparar, mas o contrato reporta o TETO, que por definição é `base + slope1 + slope2`. Identidade não fecha = forma da curva mudou = omite. O endereço da estratégia é lido POR CHAMADA via `getReserveData`, nunca fixado em config — a governança troca a estratégia de uma reserva sem avisar, e um endereço chumbado serviria a curva antiga com toda a cara de estar certa.
- **Morpho fica de fora** por três motivos independentes, todos checados ao vivo: o `AdaptiveCurveIRM` não expõe as constantes da curva (são `internal constant`); `rateAtTarget(id)` é ESTADO que escorrega com o tempo, não curva estática; e `morpho.ts` lê um VAULT que mistura 5 mercados Blue e cujo curador realoca. Não reintroduzir sem refazer essa checagem.

**`market-data/client.ts` ganhou `batch: { multicall: true }` por causa desta rota, e o motivo é medido:** a sensibilidade dispara ~6 leituras por asset (1 `getReserveData` + 5 getters da estratégia, mais 4 parâmetros + 1 sonda no Comet). Sem agrupar, o RPC público devolvia `over rate limit` em TODOS os protocolos e a resposta saía com cobertura 0 de 5 — a degradação graciosa funcionava e entregava um relatório vazio. O TTL do cache da curva é 300s (não 30s como os leitores de taxa) de propósito: o que se guarda são parâmetros que só mudam por governança, enquanto a utilização continua vindo fresca das leituras de taxa.

`UsageRoute` ganhou `"durability"`/`"capacity"`/`"sensitivity"` e `routeFromResourceUrl` mapeia os três paths — sem isso toda venda dos produtos novos cairia em `"other"` e o funil não saberia dizer qual vendeu.

### /exposure/* — fator compartilhado, e a armadilha de contabilidade (2026-08-06)

Quarta rota analítica, e a PRIMEIRA que recebe dado do comprador (`?positions=aave:200000,morpho:150000`) — daí `signal/parsePositions.ts` recusar protocolo desconhecido com 400 em vez de deixar passar: um `aavee` digitado errado viraria "não atribuído" em silêncio e o comprador pagaria por uma análise que ignorou parte da carteira sem avisar.

**A separação `factors` × `parameters` em `ProtocolExposure` não é organização, é correção.** A Aave não tem composição legível (pool compartilhado) mas TEM joelho legível. Se o joelho entrasse na mesma lista de fatores, a posição em Aave contaria como atribuída, entraria no denominador dos percentuais de colateral e faria a concentração parecer menor — escondendo exatamente o que precisava aparecer. Por isso `attributedUsd` conta só quem tem composição, e o joelho sai em `sharedParameters`, contado sobre todas as posições onde foi legível.

Atribuição por topologia, com `basis` dizendo qual você recebeu: Morpho `isolated-market` (exata, mercado isolado com um colateral), Compound `collateral-basket` (pesos reais do que está postado, via `totalsCollateral` × `getPrice` do próprio Comet), Aave **não atribuída** — v3 é pool compartilhado, atribuir a um colateral seria falso e ratear entre todos sugeriria diversificação inexistente.

**Bug real corrigido durante a implementação:** o leitor da Compound tratava falha de RPC e saldo zero como a mesma coisa, e uma leitura falha virava `"no collateral posted"` — motivo plausível e errado, com o protocolo sumindo do relatório em silêncio. Agora falha em QUALQUER perna da cesta recusa a atribuição inteira: com cesta incompleta, os colaterais restantes apareceriam com fatia maior do que têm.

**Detecção de colateral recursivo foi avaliada e descartada** (checagem ao vivo em 2026-08-06): zero ciclos e zero ativos que sejam colateral E emprestado nos 77 mercados vivos do Morpho na Base. E a recursão que matou a Stream Finance não estava no grafo de empréstimo, estava na EMISSÃO do sintético — um detector de ciclo teria dito "tudo limpo" durante o colapso inteiro. Falsa segurança é pior que alarme falso.

**`BASE_RPC_URL` (opcional) entrou junto:** as rotas analíticas leem bastante (a cesta da Compound sozinha são ~26 leituras) e o RPC público limita por taxa. Vazio mantém o default da chain. Lido de `process.env` direto em `market-data/client.ts`, NÃO via `loadEnv()`, porque esse módulo roda em teste e em `npm run signal` sem credencial nenhuma — puxar `loadEnv` ali transformaria "escolher RPC" em "precisar de carteira".

### Vigias de operação: folga de gas e publicação parada (2026-08-06)

Dois alertas novos, cada um nascido de um incidente real, e os dois no MESMO gatilho que já existia (nenhum cron novo).

**`attestation/gasRunway.ts`** — em 2026-08-05 o saldo caiu 1 centavo abaixo da reserva, a atestação parou, e o aviso só chegou DEPOIS de já estar bloqueando: 11h de buraco num histórico que não pode ser retroagido. Agora avisa enquanto ainda publica, e mede em ATESTAÇÕES, não em wei — "cabem ~40" diz quanto tempo você tem, "abaixo de X wei" não diz nada. `blocked` e `low` são estados distintos de propósito: um diz que o dano começou, o outro que dá pra agir.

**`notify/deployDrift.ts`** — dois incidentes do mesmo formato, ambos invisíveis: 6 dias de commits que nunca subiram (integração Vercel↔GitHub desconectada) e dois deploys cancelados pelo GitHub por falta de runner, sem executar um passo. Nos dois, produção seguiu respondendo com código antigo. Compara o `VERCEL_GIT_COMMIT_SHA` em execução com o topo de `main` e usa a IDADE do commit como carência — deploy em curso é normal por minutos, commit de 2h que não subiu não é. Sem estado durável. `unknown` NÃO alerta: fora da Vercel não há SHA, e alertar aí faria a checagem gritar em todo ambiente local até virar ruído.

### Atestação dos produtos analíticos — sensibilidade primeiro (2026-08-06)

`SENSITIVITY_SCHEMA` é o primeiro dos quatro analíticos a entrar no registro público. O fosso do serviço é o histórico verificável, e ele cobria SÓ o sinal — os analíticos eram vendidos apoiados numa credibilidade que não ajudavam a construir e não podiam ser pontuados.

**Por que sensibilidade primeiro:** é a única cujo registro vira pergunta EMPÍRICA depois. Gravando utilização e joelho a cada leitura, o histórico responde sozinho "mercado a meio ponto do joelho cruzou em quanto tempo?" — e a folga deixa de ser descritiva. Nenhuma outra rota produz série que se pontue contra o que aconteceu depois.

Um registro POR PROTOCOLO (mercados do mesmo ativo têm joelhos diferentes), sem `headroomBps` (derivável dos dois campos gravados; o v2 do sinal só manteve campo derivável pra não quebrar decodificador antigo, peso que schema novo não tem). `encodeSensitivityData` LANÇA em entrada não medida — gravar "estava a X do joelho" sem curva legível criaria fato falso e permanente. Só atesta quem está a ≤5pp do joelho: atestar tudo não tem teto de custo, e mercado parado longe não gera informação.

`sendAttestation` foi extraído de `publishAttestation` pros dois formatos compartilharem o cuidado de envio — a lógica de "posso tentar de novo?" é a PIOR pra ter duplicada, porque errar nela publica atestação duplicada e permanente. Gated por `EAS_SENSITIVITY_SCHEMA_UID`; vazio = gatilho não roda, mesmo interruptor-por-omissão do v2.

### Identidade ERC-8004 (attestation/erc8004.ts, agentCard.ts, cli/registerAgent.ts)

[ERC-8004 "Trustless Agents"](https://eips.ethereum.org/EIPS/eip-8004) tem `IdentityRegistry`/`ReputationRegistry` deployados no MESMO endereço (CREATE2 determinístico) em toda chain, Base mainnet incluída — confirmado nesta sessão com `eth_getCode` direto contra `mainnet.base.org` (bytecode real presente, não só o README do repo `erc-8004/erc-8004-contracts` AFIRMANDO isso — mesmo rigor já aplicado ao EAS, ver [[feedback_eas_op_stack_predeploy_abi_mismatch]]). `GET /agent-card.json` serve o registration file no formato exato do spec (`type`/`name`/`description`/`services`/`x402Support`/`active`/`registrations`/`supportedTrust`); `registrations` começa vazio de propósito — só existe `agentId` DEPOIS do mint. `cli/registerAgent.ts` (mesmo padrão `CONFIRM` de `registerSchema.ts`) chama `IdentityRegistry.register(agentURI)` uma vez e imprime a entrada exata pra colar em `src/agentCard.ts`. `ReputationRegistry` é só DOCUMENTADO (endereço no card) — quem chama `giveFeedback` é o COMPRADOR, o contrato bloqueia self-feedback do owner/operador.
