import { encodeAbiParameters, encodeFunctionData, zeroAddress, zeroHash } from "viem";
import type { SensitivityEntry, SensitivityReport } from "../signal/sensitivity.js";
import { EAS_ABI, SENSITIVITY_SCHEMA_TYPES } from "./schema.js";

/**
 * Codificação da atestação de sensibilidade — pura, sem I/O, testável com
 * fixture, mesmo espírito de `encodeSignalAttestation.ts`.
 *
 * Só entradas MEDIDAS podem ser atestadas. Gravar on-chain que um protocolo
 * estava a X do joelho quando na verdade não havia curva legível criaria um
 * registro permanente e falso — o oposto exato do que o histórico serve pra
 * fazer. Por isso a checagem é uma exceção dura, não um valor default.
 */
export function encodeSensitivityData(asset: string, entry: SensitivityEntry, asOf: string): `0x${string}` {
  if (!entry.measured || entry.utilizationBps === null || entry.kinkBps === null || entry.borrowApyBpsNow === null) {
    throw new Error(
      `entrada de ${entry.protocol} não é medida — atestar isso gravaria um fato falso e permanente on-chain`,
    );
  }
  const asOfSeconds = BigInt(Math.floor(new Date(asOf).getTime() / 1000));
  return encodeAbiParameters(SENSITIVITY_SCHEMA_TYPES, [
    asset,
    entry.protocol,
    BigInt(entry.utilizationBps),
    BigInt(entry.kinkBps),
    BigInt(entry.borrowApyBpsNow),
    asOfSeconds,
  ]);
}

/** Calldata de `EAS.attest()` — mesmas escolhas do sinal: público, irrevogável, sem refUID. */
export function buildSensitivityAttestCalldata(
  schemaUid: `0x${string}`,
  asset: string,
  entry: SensitivityEntry,
  asOf: string,
): `0x${string}` {
  return encodeFunctionData({
    abi: EAS_ABI,
    functionName: "attest",
    args: [
      {
        schema: schemaUid,
        data: {
          recipient: zeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: zeroHash,
          data: encodeSensitivityData(asset, entry, asOf),
          value: 0n,
        },
      },
    ],
  });
}

/**
 * Quais entradas do relatório vale atestar AGORA.
 *
 * Atestar tudo a cada leitura não tem teto de custo (mesma lição que fez o
 * gatilho do sinal existir), e a maior parte das leituras é repetição: um
 * mercado parado a 60% de utilização não gera informação nova nenhuma.
 *
 * O critério é onde a informação está: PERTO do joelho. Um mercado a 89,8% de
 * um joelho em 90% é exatamente o ponto em que a série temporal vai valer
 * alguma coisa depois; um a 60% não diz nada que o próximo mês não diga igual.
 * `pastKink` também entra — o outro lado da mesma fronteira é igualmente raro
 * e igualmente informativo.
 */
export const ATTEST_HEADROOM_THRESHOLD_BPS = 500;

/**
 * Quanto a utilização precisa ter andado desde o último registro pra valer uma
 * transação nova. 25bps é o mesmo limiar que o gatilho do sinal usa pro gap —
 * abaixo disso o mercado praticamente não se mexeu e o registro seria uma cópia
 * paga do anterior.
 */
export const ATTEST_UTILIZATION_DELTA_BPS = 25;

/**
 * Passou disso, registra mesmo com o mercado parado — é o batimento que garante
 * série contínua em vez de só picos.
 *
 * 24h, não as 12h do sinal, e a diferença é orçamento medido, não estilo. Com
 * custo de US$ 0,0043 por atestação e ~3 mercados tipicamente dentro da faixa:
 * 12h dá ~US$ 0,77/mês, 24h dá ~US$ 0,39/mês. O serviço ainda não gera receita,
 * então o saldo em carteira (0,0021 ETH) é o orçamento real — e ele cobre 154
 * dias a 12h contra 308 dias a 24h. Amostra diária é densa o bastante pra a
 * pergunta que este registro existe pra responder ("mercado perto do joelho
 * cruzou em quanto tempo?"), e o gatilho de 25bps continua capturando qualquer
 * movimento relevante entre os batimentos.
 *
 * Sem nenhum mercado dentro da faixa de 5pp, o custo é ZERO — nada é gravado.
 */
export const ATTEST_MAX_STALENESS_MS = 24 * 60 * 60 * 1_000;

/** O que já foi gravado pra um mercado, o mínimo pra decidir se vale gravar de novo. */
export interface LastSensitivityRecord {
  utilizationBps: number;
  /** Segundos desde a época, como o EAS devolve. */
  time: number;
}

export function entriesWorthAttesting(report: SensitivityReport): SensitivityEntry[] {
  return report.entries.filter(
    (e) =>
      e.measured &&
      e.headroomBps !== null &&
      // Dentro de 5 pontos percentuais do joelho, dos dois lados.
      e.headroomBps <= ATTEST_HEADROOM_THRESHOLD_BPS,
  );
}

/**
 * Vale gravar ESTE mercado agora? Pura, testável sem RPC.
 *
 * Estar perto do joelho diz que o mercado é INTERESSANTE; não diz que houve
 * informação nova. Sem esta segunda peneira o gatilho publicaria a cada rodada
 * do cron — com 3 mercados qualificando e cron horário, ~72 transações por dia
 * gravando registros quase idênticos. O gatilho do sinal já tinha essa
 * disciplina (`decideAutoAttest`); o de sensibilidade nasceu sem, e isso é um
 * teto de custo faltando, não uma otimização.
 */
export function shouldAttestEntry(
  entry: SensitivityEntry,
  last: LastSensitivityRecord | undefined,
  now: Date = new Date(),
): { attest: boolean; reason: string } {
  if (entry.utilizationBps === null) return { attest: false, reason: "entrada não medida" };
  if (!last) return { attest: true, reason: "nenhum registro anterior para este mercado" };

  const delta = Math.abs(entry.utilizationBps - last.utilizationBps);
  if (delta >= ATTEST_UTILIZATION_DELTA_BPS) {
    return { attest: true, reason: `utilização andou ${delta} bps (limiar ${ATTEST_UTILIZATION_DELTA_BPS})` };
  }
  const ageMs = now.getTime() - last.time * 1_000;
  if (ageMs >= ATTEST_MAX_STALENESS_MS) {
    return { attest: true, reason: `último registro tem ${Math.round(ageMs / 3_600_000)}h` };
  }
  return { attest: false, reason: `utilização andou só ${delta} bps e o registro é recente` };
}
