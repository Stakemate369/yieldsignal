import { collectRates } from "../signal/collectRates.js";
import { collectBorrowRateCurves } from "../market-data/rateCurve.js";
import { computeSensitivity } from "../signal/sensitivity.js";
import { buildSensitivityAttestCalldata, entriesWorthAttesting } from "./encodeSensitivityAttestation.js";
import { sendAttestation, InsufficientGasError } from "./publishAttestation.js";
import { logger } from "../notify/logger.js";
import type { SignerAccount } from "../wallet/signerAccount.js";
import type { LendingAssetId } from "../market-data/types.js";

export interface SensitivityAttestResult {
  asset: LendingAssetId;
  /** Quantas entradas estavam perto do joelho e mereciam registro. */
  candidates: number;
  attested: { protocol: string; uid: string }[];
  error?: string;
}

/**
 * Publica atestações do ESTADO DA CURVA pros mercados que estão perto do
 * joelho. Ver `SENSITIVITY_SCHEMA` (attestation/schema.ts) sobre por que a
 * sensibilidade foi o primeiro produto analítico a entrar no registro público.
 *
 * NUNCA lança — mesmo contrato de `runAutoAttestForAsset`: este runner roda
 * dentro do cron que também dispara as atestações de sinal, e uma falha aqui
 * não pode impedir aquelas de acontecerem. Erro vira campo no resultado.
 *
 * Cada entrada é uma transação separada, e uma que falhe não impede as
 * seguintes: são fatos independentes sobre mercados diferentes, e abortar o
 * lote inteiro por causa de um perderia registro que não dá pra recuperar
 * depois (atestação não pode ser retroagida).
 */
export async function runSensitivityAttestForAsset(
  asset: LendingAssetId,
  opts: { signer: SignerAccount; schemaUid: `0x${string}`; minGasReserveEth: number },
): Promise<SensitivityAttestResult> {
  const attested: { protocol: string; uid: string }[] = [];
  try {
    const readings = await collectRates(asset);
    const curves = await collectBorrowRateCurves(
      asset,
      readings.map((r) => r.protocol),
    );
    const report = computeSensitivity(asset, readings, curves);
    const candidatos = entriesWorthAttesting(report);

    // Reserva em wei a partir do ETH configurado — mesma conversão que
    // publishAttestation espera. Feita uma vez, fora do laço.
    const minGasReserveWei = BigInt(Math.round(opts.minGasReserveEth * 1e18));

    for (const entry of candidatos) {
      try {
        const data = buildSensitivityAttestCalldata(opts.schemaUid, asset, entry, report.asOf);
        const { uid } = await sendAttestation({ data, signer: opts.signer, minGasReserveWei });
        attested.push({ protocol: String(entry.protocol), uid });
      } catch (err) {
        if (err instanceof InsufficientGasError) {
          // Sem gas, nenhuma das seguintes vai passar — parar aqui evita
          // repetir a mesma leitura de saldo pra cada mercado restante.
          return {
            asset,
            candidates: candidatos.length,
            attested,
            error: err.message,
          };
        }
        logger.warn(
          { asset, protocol: entry.protocol, err },
          "falha atestando sensibilidade de um mercado — os outros seguem",
        );
      }
    }
    return { asset, candidates: candidatos.length, attested };
  } catch (err) {
    return {
      asset,
      candidates: 0,
      attested,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
