# Modelo de segurança do YieldSignal

## Regra central

Nenhum processo deste projeto move fundos pra fora da carteira sem confirmação humana explícita. Diferente do YieldPilot, o servidor HTTP (`src/server.ts`) só LÊ taxas de mercado e RECEBE pagamentos (nunca envia) — o único caminho de saída de dinheiro é `src/cli/withdraw.ts`, um comando manual separado.

- `src/server.ts` nunca importa nada de `src/cli/withdraw.ts`, e vice-versa — são processos independentes que só compartilham a mesma carteira CDP por credencial, não por código.
- `withdraw.ts` exige digitar `CONFIRM` num prompt interativo antes de qualquer transferência.

## Camadas de defesa

1. **Separação de credenciais entre projetos** — CDP_API_KEY_ID/SECRET/WALLET_SECRET próprios deste projeto, nunca os do YieldPilot. Um bug ou vazamento aqui não dá acesso à carteira do outro agente.
2. **Trava de endereço da carteira receptora** (`src/wallet/walletLock.ts`) — mesmo mecanismo do YieldPilot (`assertWalletAddressLock`), aplicado desde o primeiro run em vez de adicionado depois de um incidente: o endereço resolvido por `createX402Server`/`getAccount` é travado em `state/{environment}-wallet.lock.json` na primeira verificação, e qualquer divergência depois disso lança erro alto e claro (ver o incidente de troca silenciosa de owner documentado no SECURITY.md do YieldPilot — a mesma classe de bug se aplica a qualquer carteira CDP).
3. **Confirmação manual explícita no saque** — `cli/withdraw.ts` mostra origem, destino, valor e ambiente (development/production) antes de pedir a palavra `CONFIRM`.
4. **Destino de saque fixo** — `OWNER_WALLET_ADDRESS` vem só do `.env`, nunca é parâmetro de linha de comando nem input de rede; não há como um request HTTP externo influenciar pra onde o saque vai.
5. **Sequência de ambiente antes de dinheiro real** — `X402_ENVIRONMENT=development` (base-sepolia, dinheiro de teste) testado de ponta a ponta antes de trocar pra `production` (base mainnet).
6. **Falha isolada por fonte de dado** — `collectRates.ts` usa `Promise.allSettled`/try-catch por protocolo: uma fonte fora do ar (RPC, API da Morpho, DefiLlama) faz esse protocolo sumir da resposta, não derruba a chamada paga inteira nem inventa um número.

## Superfícies de ataque conhecidas e como são tratadas

- **Chave da carteira receptora vazada**: dano limitado ao saldo acumulado de pagamentos x402 (nunca é um valor grande por design — cobra centavos por chamada); não há capital de investimento nessa carteira, diferente do YieldPilot.
- **Request malicioso no endpoint público**: a rota só faz leitura (nenhum parâmetro do request influencia o que é lido ou pra onde algo é enviado) — não há injeção possível na lógica de negócio a partir do HTTP.
- **DefiLlama fora do ar ou pool renomeado/removido**: `defillamaPools.ts` retorna `null` pro protocolo afetado em vez de lançar ou inventar dado; `computeSignal.ts` só falha (503) se **nenhuma** fonte respondeu.
- **Protocolo pesquisado mas sem mercado real (Spark/Seamless/Silo)**: deliberadamente fora da lista até existir um pool USDC na Base indexado de verdade — ver `market-data/types.ts`.
- **Endereço de contrato errado**: cada endereço em `config/networks.ts` tem a fonte exata usada pra conferir, em comentário — reconfira antes de trocar pra `production`.

## O que este projeto explicitamente NÃO faz

- Não redeploya automaticamente o saldo acumulado em nenhum protocolo de lending (isso é um passo futuro deliberadamente fora do escopo da v1).
- Não guarda a chave da carteira em nenhum lugar além da CDP (MPC/enclave) — o `.env` local só tem credenciais de API, não uma chave privada.
- Não aceita nenhum destino de saque diferente de `OWNER_WALLET_ADDRESS`.
