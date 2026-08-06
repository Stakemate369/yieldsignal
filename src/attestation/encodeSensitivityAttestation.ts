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

export function entriesWorthAttesting(report: SensitivityReport): SensitivityEntry[] {
  return report.entries.filter(
    (e) =>
      e.measured &&
      e.headroomBps !== null &&
      // Dentro de 5 pontos percentuais do joelho, dos dois lados.
      e.headroomBps <= ATTEST_HEADROOM_THRESHOLD_BPS,
  );
}
