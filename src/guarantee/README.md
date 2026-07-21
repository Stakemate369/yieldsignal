# Camada 3 — Garantia econômica com bond

O fosso que nenhum concorrente tem: **o vendedor põe dinheiro atrás da afirmação**. Um feed gratuito (DefiLlama) e mesmo um feed assinado só dizem "acho que X é o melhor". Aqui o vendedor compromete capital: *"se eu estiver errado dentro da janela, você recebe do meu bond"*. Para um mercado robô-para-robô, essa é a primitiva de confiança definitiva.

## O que já está pronto (software, testado)

- **`resolveGuarantee.ts`** — o cérebro: a regra **determinística** que arbitra "a garantia foi cumprida ou rompida?", dado o compromisso original e uma leitura de verificação. É o que um escrow on-chain (ou árbitro) checaria pra liberar o bond. Coberto por `test/resolveGuarantee.test.ts`.
- **`issueGuarantee(...)`** — constrói o compromisso do lado do vendedor, validando invariantes (janela/payout positivos, tolerância não-negativa).
- **`terms.ts`** + **`GET /guarantee/terms.json`** — descrição pública, legível por máquina, do mecanismo, com `status` HONESTO (`engine-ready:escrow-not-deployed`).

### A regra (resistente a manipulação por construção)

- **Rompimento:** o melhor protocolo ajustado por risco passa a ser OUTRO, e o supera por **mais que `toleranceBps`**, observado **dentro** de `[issuedAt, issuedAt+windowSeconds]`.
- **Banda de ruído** (`toleranceBps`): oscilação de 1-2bps não conta — só ultrapassagem clara.
- **Limite de janela:** só leituras dentro da janela disparam payout.
- **Amarra ao conteúdo** (`contentHash`): não dá pra redefinir a regra depois do fato.
- **Indeterminado:** APY ilegível => sem veredito (nem cumprido, nem rompido).

## O que falta — passo MANUAL, decisão do dono (capital em risco)

O escrow que **segura e libera capital real NÃO está deployado** — de propósito. Deployar um contrato que custodia dinheiro e travar ETH/USDC real é uma ação irreversível de risco financeiro que só o dono decide e executa. Nada neste diretório move dinheiro.

Quando/se o dono decidir ativar:

1. **Escrow contract (`SignalBond`)** — projeto Foundry SEPARADO (não neste repo TS), com a interface:
   - `fundBond()` — vendedor deposita o bond (USDC na Base).
   - `issue(bytes32 contentHash, address buyer, uint256 payout, uint64 issuedAt, uint32 windowSeconds, ...)` — registra o compromisso on-chain no momento da venda paga.
   - `claim(bytes32 contentHash, VerificationReading calldata)` — comprador aciona; o contrato aplica **a MESMA regra de `resolveGuarantee.ts`** (portada pra Solidity, com testes de equivalência contra os vetores de `test/resolveGuarantee.test.ts`) e, se `BREACHED`, transfere `payout` do bond pro comprador.
   - Fonte de verdade da leitura de verificação: um oráculo/atestação assinada pelo próprio agente (reaproveita a infra EIP-712/EAS já existente) — o comprador apresenta uma leitura assinada dentro da janela.
2. **Auditoria** antes de fundear com valor não-trivial (custódia = superfície crítica).
3. **Fundear** o bond e flipar `terms.ts#status` pra `"live"`, preenchendo `bond.escrowAddress`/`bond.fundedUsd`.

Só depois disso um sinal pode ser vendido COM garantia ativa. Até lá, `/guarantee/terms.json` deixa explícito que é engine, não promessa — nenhum robô pagante é induzido a erro.

## Por que essa ordem

Portar a regra pro Solidity e auditar é a parte cara e crítica. Fazer o motor primeiro (puro, testado, com vetores) significa que o contrato tem uma especificação executável e um conjunto de casos de equivalência prontos — reduz o risco da parte on-chain em vez de escrever contrato + regra ao mesmo tempo.
