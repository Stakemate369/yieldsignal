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

/**
 * Limiar POR ASSET pra mudança de gap. Medido em 2026-07-30 sobre 100
 * atestações reais: USDC tinha 78 delas contra 11 de WETH e 11 de ETH_STAKING.
 * O gatilho de gap dispara mesmo com o líder INALTERADO — num mercado que
 * oscila com utilização hora a hora (lending de USDC na Base), 25 bps é ruído,
 * e cada disparo publicava uma atestação a mais no histórico, todas depois
 * julgadas contra o mercado do momento da consulta.
 *
 * Não é maquiagem de métrica: atestar ruído também gasta gas e polui o registro
 * público com "mudanças" que não mudam a decisão de ninguém — o gap muda, o
 * protocolo recomendado é o mesmo. Assets pegajosos (staking, WETH) seguem em
 * 25 bps porque neles um movimento desse tamanho é sinal de verdade.
 */
const GAP_CHANGE_THRESHOLD_BPS_BY_ASSET: Partial<Record<AssetId, number>> = {
  USDC: 75,
};

/**
 * MUDANÇA DE LÍDER NUNCA É SUPRIMIDA, de propósito: a atestação é o registro
 * público do que o serviço ESTÁ vendendo, e `/signal` responde o estado real do
 * mercado naquele instante. Aplicar histerese só aqui faria o registro on-chain
 * apontar um protocolo diferente do que a resposta paga entrega — o histórico
 * deixaria de ser prova do produto. A histerese econômica (vale a pena trocar,
 * dado custo e horizonte) fica onde ela custa dinheiro de verdade ao comprador:
 * em signal/decideMove.ts, que já exige o ganho superar o break-even.
 */
function gapThresholdFor(asset: AssetId): number {
  return GAP_CHANGE_THRESHOLD_BPS_BY_ASSET[asset] ?? GAP_CHANGE_THRESHOLD_BPS;
}

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
  const gapThresholdBps = gapThresholdFor(signal.asset);
  const gapDelta = Math.abs(lastAttestation.gapBps - signal.gapBps);
  if (gapDelta >= gapThresholdBps) {
    return { shouldAttest: true, reason: `gap mudou ${gapDelta} bps (limiar ${gapThresholdBps} bps para ${signal.asset})` };
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
