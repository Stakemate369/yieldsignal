import { parseEther } from "viem";
import { collectRates } from "../signal/collectRates.js";
import { computeSignal } from "../signal/computeSignal.js";
import type { YieldSignal } from "../signal/computeSignal.js";
import type { AssetId } from "../market-data/types.js";
import { fetchSignalAttestations, type DecodedSignalAttestation } from "./queryAttestations.js";
import { publishAttestation, InsufficientGasError } from "./publishAttestation.js";
import type { SignerAccount } from "../wallet/signerAccount.js";
import { logger } from "../notify/logger.js";

// Atestar em TODA chamada paga não tem teto de custo (cresce com tráfego) —
// em vez disso, atesta de novo só quando o sinal mudou o suficiente pra valer
// a pena um novo registro público, OU quando já faz tempo demais desde a
// última (garante frescor mesmo num mercado parado).
const GAP_CHANGE_THRESHOLD_BPS = 25;
const MAX_STALENESS_MS = 12 * 60 * 60 * 1000;

export interface AutoAttestDecision {
  shouldAttest: boolean;
  reason: string;
}

/**
 * Decide SE vale atestar agora — puro, sem I/O, testável com fixtures (mesmo
 * espírito de signal/computeSignal.ts). `lastAttestation` vem de
 * queryAttestations.ts (já filtrado pro asset certo, item mais recente).
 */
export function decideAutoAttest(params: {
  signal: YieldSignal;
  lastAttestation: DecodedSignalAttestation | undefined;
  now?: Date;
}): AutoAttestDecision {
  const { signal, lastAttestation, now = new Date() } = params;

  if (!lastAttestation) {
    return { shouldAttest: true, reason: "nenhuma atestação anterior encontrada pra este asset" };
  }
  if (lastAttestation.bestProtocol !== signal.bestProtocol) {
    return {
      shouldAttest: true,
      reason: `melhor protocolo mudou (${lastAttestation.bestProtocol} -> ${signal.bestProtocol})`,
    };
  }
  const gapDelta = Math.abs(lastAttestation.gapBps - signal.gapBps);
  if (gapDelta >= GAP_CHANGE_THRESHOLD_BPS) {
    return { shouldAttest: true, reason: `gap mudou ${gapDelta} bps (limiar ${GAP_CHANGE_THRESHOLD_BPS} bps)` };
  }
  const ageMs = now.getTime() - lastAttestation.time * 1000;
  if (ageMs >= MAX_STALENESS_MS) {
    return {
      shouldAttest: true,
      reason: `última atestação tem ${Math.round(ageMs / 3_600_000)}h (teto de frescor: ${MAX_STALENESS_MS / 3_600_000}h)`,
    };
  }
  return { shouldAttest: false, reason: "sinal estável e atestação recente — nada a fazer" };
}

export interface AutoAttestOutcome {
  asset: AssetId;
  attested: boolean;
  reason: string;
  transactionHash?: `0x${string}`;
  uid?: `0x${string}`;
  error?: string;
}

/**
 * Orquestra UM asset: lê taxas reais, decide, e só gasta gas se
 * `decideAutoAttest` mandar. Nunca lança — chamado a partir de uma rota HTTP
 * disparada por cron externo (expressApp.ts#/internal/auto-attest), sem
 * humano no loop pra reagir a uma exceção; cada erro vira `{ error }` no
 * resultado, logado, e não derruba o outro asset da mesma chamada.
 */
export async function runAutoAttestForAsset(
  asset: AssetId,
  opts: { signer: SignerAccount; schemaUid: `0x${string}`; minGasReserveEth: number },
): Promise<AutoAttestOutcome> {
  try {
    const readings = await collectRates(asset);
    const signal = computeSignal(readings);

    const attestations = await fetchSignalAttestations({ schemaId: opts.schemaUid, attester: opts.signer.address });
    const lastForAsset = attestations.find((a) => a.asset === asset);

    const decision = decideAutoAttest({ signal, lastAttestation: lastForAsset });
    if (!decision.shouldAttest) {
      return { asset, attested: false, reason: decision.reason };
    }

    const { transactionHash, uid } = await publishAttestation({
      signal,
      signer: opts.signer,
      schemaUid: opts.schemaUid,
      minGasReserveWei: parseEther(opts.minGasReserveEth.toString()),
    });
    logger.info({ asset, transactionHash, uid, reason: decision.reason }, "auto-attest: atestação publicada");
    return { asset, attested: true, reason: decision.reason, transactionHash, uid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof InsufficientGasError) {
      logger.warn({ asset, message }, "auto-attest: saldo de ETH insuficiente — pulado");
    } else {
      logger.error({ err, asset }, "auto-attest: falha");
    }
    return { asset, attested: false, reason: "erro", error: message };
  }
}
