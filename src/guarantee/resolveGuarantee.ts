import type { AssetId, ProtocolId } from "../market-data/types.js";

/**
 * CAMADA 3: garantia econômica com bond.
 *
 * O fosso que nenhum concorrente tem: o vendedor põe dinheiro atrás da
 * afirmação. Ao vender um sinal COM garantia, o vendedor compromete: "o
 * protocolo que nomeei vai continuar o melhor ajustado por risco durante
 * `windowSeconds`; se outro protocolo o ultrapassar por mais que
 * `toleranceBps` dentro dessa janela, você recebe `payoutUsd` do meu bond".
 *
 * Este arquivo é o CÉREBRO da garantia: a regra DETERMINÍSTICA que arbitra
 * "a garantia foi cumprida ou rompida?", dado o compromisso original e uma
 * leitura de verificação independente. É a parte de software — o IP real e
 * testável. A CUSTÓDIA on-chain do bond (escrow que segura e libera capital
 * real) é um passo de deploy separado e explicitamente manual — ver
 * `src/guarantee/README.md`. Nada aqui move dinheiro; só decide o veredito.
 *
 * Resistência a manipulação, por construção:
 *  - Só leituras DENTRO da janela contam (um "rompimento" depois de expirar
 *    não dispara payout).
 *  - Banda de tolerância (`toleranceBps`): ruído de 1-2bps não conta como
 *    rompimento — só uma ultrapassagem clara.
 *  - O compromisso é amarrado ao conteúdo exato do sinal vendido
 *    (`contentHash`), então não dá pra redefinir a regra depois do fato.
 *  - Leitura ilegível vira INDETERMINATE (nem cumprida nem rompida) — não
 *    pune nem premia nenhum lado por uma falha transitória de leitura.
 */

export interface GuaranteeClaim {
  asset: AssetId;
  /** Protocolo que o vendedor afirmou ser o melhor ajustado por risco. */
  guaranteedProtocol: ProtocolId;
  /** APY ponderado do protocolo garantido no momento da venda (bps). */
  guaranteedWeightedApyBps: number;
  /** Quanto o protocolo garantido pode cair abaixo de um novo líder antes de contar como rompimento. */
  toleranceBps: number;
  /** Duração da garantia, em segundos, a partir de `issuedAt`. */
  windowSeconds: number;
  /** Unix seconds em que a garantia foi emitida. */
  issuedAt: number;
  /** Quanto o comprador recebe do bond se a garantia romper. */
  payoutUsd: number;
  /** Amarra o compromisso ao corpo exato do sinal vendido (mesmo contentHash do EIP-712). */
  contentHash: `0x${string}`;
}

export interface VerificationReading {
  /** Unix seconds da leitura de verificação. */
  observedAt: number;
  /** O melhor protocolo ajustado por risco AGORA, segundo esta leitura. */
  bestProtocol: ProtocolId;
  /** APY ponderado do melhor protocolo agora (bps). */
  bestWeightedApyBps: number;
  /** APY ponderado do protocolo GARANTIDO agora (bps). `null` se ilegível nesta leitura. */
  guaranteedNowWeightedApyBps: number | null;
}

export type GuaranteeVerdict = "UPHELD" | "BREACHED" | "INDETERMINATE" | "OUT_OF_WINDOW";

export interface GuaranteeResolution {
  verdict: GuaranteeVerdict;
  /** Quanto do bond é devido ao comprador (0 salvo em BREACHED). */
  payoutOwedUsd: number;
  /** Margem (bps) pela qual o novo líder superou o protocolo garantido. Negativo/zero = garantido ainda na frente. `null` se indeterminado/fora da janela. */
  breachMarginBps: number | null;
  reason: string;
}

/**
 * Núcleo determinístico — sem I/O. Aplica a regra da garantia a UMA leitura
 * de verificação. Um comprador que queira acionar o payout deve apresentar
 * uma leitura BREACHED dentro da janela; a regra aqui é o que um escrow
 * on-chain (ou um árbitro) checaria pra liberar o bond.
 */
export function resolveGuarantee(claim: GuaranteeClaim, reading: VerificationReading): GuaranteeResolution {
  const windowEnd = claim.issuedAt + claim.windowSeconds;

  if (reading.observedAt < claim.issuedAt || reading.observedAt > windowEnd) {
    return {
      verdict: "OUT_OF_WINDOW",
      payoutOwedUsd: 0,
      breachMarginBps: null,
      reason: `Leitura em ${reading.observedAt} está fora da janela da garantia [${claim.issuedAt}, ${windowEnd}]. Rompimentos só valem dentro da janela.`,
    };
  }

  if (reading.guaranteedNowWeightedApyBps === null) {
    return {
      verdict: "INDETERMINATE",
      payoutOwedUsd: 0,
      breachMarginBps: null,
      reason: `APY do protocolo garantido (${claim.guaranteedProtocol}) ilegível nesta leitura — sem veredito. Reapresente uma leitura legível dentro da janela.`,
    };
  }

  // Se o melhor de agora é o próprio protocolo garantido, não há rompimento
  // possível (ele continua líder), independente do valor.
  if (reading.bestProtocol === claim.guaranteedProtocol) {
    return {
      verdict: "UPHELD",
      payoutOwedUsd: 0,
      breachMarginBps: reading.bestWeightedApyBps - reading.guaranteedNowWeightedApyBps,
      reason: `${claim.guaranteedProtocol} continua sendo o melhor ajustado por risco. Garantia cumprida.`,
    };
  }

  const breachMarginBps = reading.bestWeightedApyBps - reading.guaranteedNowWeightedApyBps;

  if (breachMarginBps > claim.toleranceBps) {
    return {
      verdict: "BREACHED",
      payoutOwedUsd: claim.payoutUsd,
      breachMarginBps,
      reason: `${reading.bestProtocol} superou ${claim.guaranteedProtocol} em ${breachMarginBps}bps ajustado por risco, além da tolerância de ${claim.toleranceBps}bps, dentro da janela. Garantia rompida — payout de $${claim.payoutUsd.toFixed(4)} devido.`,
    };
  }

  return {
    verdict: "UPHELD",
    payoutOwedUsd: 0,
    breachMarginBps,
    reason: `${reading.bestProtocol} está apenas ${breachMarginBps}bps à frente de ${claim.guaranteedProtocol} — dentro da tolerância de ${claim.toleranceBps}bps. Garantia cumprida (ainda direcionalmente correta).`,
  };
}

export interface IssueGuaranteeParams {
  asset: AssetId;
  guaranteedProtocol: ProtocolId;
  guaranteedWeightedApyBps: number;
  toleranceBps: number;
  windowSeconds: number;
  payoutUsd: number;
  contentHash: `0x${string}`;
  /** Unix seconds; default = agora. Injetável pra teste determinístico. */
  now?: number;
}

/**
 * Constrói o compromisso de garantia a partir dos parâmetros da venda —
 * lado do vendedor. Valida invariantes que tornariam a garantia sem sentido
 * (janela/payout não-positivos, tolerância negativa) pra falhar cedo em vez
 * de emitir um compromisso quebrado.
 */
export function issueGuarantee(params: IssueGuaranteeParams): GuaranteeClaim {
  if (params.windowSeconds <= 0) throw new Error("windowSeconds precisa ser > 0");
  if (params.payoutUsd <= 0) throw new Error("payoutUsd precisa ser > 0");
  if (params.toleranceBps < 0) throw new Error("toleranceBps não pode ser negativo");

  return {
    asset: params.asset,
    guaranteedProtocol: params.guaranteedProtocol,
    guaranteedWeightedApyBps: params.guaranteedWeightedApyBps,
    toleranceBps: params.toleranceBps,
    windowSeconds: params.windowSeconds,
    issuedAt: params.now ?? Math.floor(Date.now() / 1000),
    payoutUsd: params.payoutUsd,
    contentHash: params.contentHash,
  };
}
