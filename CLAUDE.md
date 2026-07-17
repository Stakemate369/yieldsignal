# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                # instala dependências
npm test                   # roda toda a suíte (vitest run)
npm run test:watch         # vitest em modo watch
npx tsc --noEmit           # typecheck sem gerar arquivos — rodar depois de qualquer mudança
npm run signal              # calcula e imprime o sinal AGORA, com dados reais — sem servidor, sem carteira, sem credencial CDP nenhuma
npm run dev                 # sobe o servidor x402 (lê X402_ENVIRONMENT do .env pra decidir development/production)
npm run test:paid           # cria uma carteira compradora de teste, pega USDC de teste no faucet da CDP, e faz uma chamada paga de verdade contra localhost:4021 — só funciona em development
npm run withdraw            # saca o USDC acumulado pra OWNER_WALLET_ADDRESS — pede confirmação manual digitada "CONFIRM"
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
