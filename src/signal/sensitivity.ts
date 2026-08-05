import { borrowApyBpsAt, type BorrowRateCurve } from "../market-data/rateCurve.js";
import type { AssetId, ProtocolId, RateReading } from "../market-data/types.js";

/**
 * SENSIBILIDADE À UTILIZAÇÃO — "a que distância este mercado está do ponto onde
 * a taxa dispara, e quanto ela dispara?"
 *
 * A taxa de um mercado de lending não é um número, é uma função da utilização
 * com um JOELHO. Abaixo dele a taxa sobe devagar; acima, explode. Medido na
 * Compound USDC da Base em 2026-08-05: kink em 90%, utilização em 89,83% —
 * DEZESSETE CENTÉSIMOS de ponto de folga — e do outro lado o custo de tomar
 * emprestado sai de ~4% para ~16%.
 *
 * É a peça que faltava ao lado de `/capacity`: aquele diz se você consegue sair
 * agora, este diz quão perto o mercado está de reprecificar contra você. E é a
 * primeira rota que fala com o lado TOMADOR, não só com o credor.
 *
 * Nada aqui é previsão: não se afirma que a utilização VAI subir. Afirma-se
 * onde ela está, onde está o joelho, e qual taxa o próprio contrato cobraria em
 * cada ponto — tudo derivado de parâmetros lidos on-chain.
 */

/** Deslocamentos de utilização em que a curva é reportada, relativos ao kink. */
const PROBE_OFFSETS_BPS = [-500, 0, 100, 300, 900] as const;

/** Referência para o multiplicador: 3 pontos percentuais acima do joelho. */
const SHOCK_OFFSET_BPS = 300;

export interface CurvePoint {
  utilizationBps: number;
  borrowApyBps: number;
  /** `true` no ponto que corresponde ao joelho da curva. */
  isKink: boolean;
}

export interface SensitivityEntry {
  protocol: ProtocolId;
  /** `false` = não há curva legível para este protocolo. Nunca significa "estável". */
  measured: boolean;
  utilizationBps: number | null;
  kinkBps: number | null;
  /**
   * Quantos bps de utilização faltam para o joelho. NEGATIVO quando o mercado já
   * passou dele — e isso é uma medição, não um erro.
   */
  headroomBps: number | null;
  pastKink: boolean | null;
  borrowApyBpsNow: number | null;
  borrowApyBpsAtKink: number | null;
  /**
   * Quantas vezes o custo de empréstimo se multiplica se a utilização for do
   * ponto atual até 3 pontos acima do joelho. `null` se não medido, ou se a taxa
   * atual for zero (divisão sem sentido).
   */
  shockMultiple: number | null;
  /** A curva em pontos ao redor do joelho, para o comprador ver a forma. */
  curve: CurvePoint[] | null;
  curveBasis: BorrowRateCurve["basis"] | null;
}

export interface SensitivityReport {
  asset: AssetId;
  basis: "onchain-interest-rate-curve";
  /**
   * O mercado medido com MENOS folga até o joelho — o mais perto de
   * reprecificar. `null` quando nada foi medido, ou quando nenhum medido ainda
   * está abaixo do joelho.
   */
  tightestToKink: { protocol: ProtocolId; headroomBps: number } | null;
  /** Medidos que JÁ passaram do joelho: estão na perna íngreme da curva agora. */
  pastKink: ProtocolId[];
  unmeasured: ProtocolId[];
  coverage: { measured: number; total: number };
  entries: SensitivityEntry[];
  asOf: string;
}

function buildCurve(curve: BorrowRateCurve): CurvePoint[] {
  const seen = new Set<number>();
  const points: CurvePoint[] = [];
  for (const offset of PROBE_OFFSETS_BPS) {
    const u = Math.max(0, Math.min(10_000, curve.kinkBps + offset));
    if (seen.has(u)) continue;
    seen.add(u);
    points.push({ utilizationBps: u, borrowApyBps: borrowApyBpsAt(curve, u), isKink: u === curve.kinkBps });
  }
  return points.sort((a, b) => a.utilizationBps - b.utilizationBps);
}

function toEntry(reading: RateReading, curve: BorrowRateCurve | undefined): SensitivityEntry {
  const utilizationBps = reading.liquidity?.utilizationBps ?? null;
  // Precisa dos DOIS lados: a curva sem saber onde o mercado está não responde
  // "quão perto", e a utilização sem curva não responde "perto do quê".
  if (!curve || utilizationBps === null) {
    return {
      protocol: reading.protocol,
      measured: false,
      utilizationBps,
      kinkBps: curve?.kinkBps ?? null,
      headroomBps: null,
      pastKink: null,
      borrowApyBpsNow: null,
      borrowApyBpsAtKink: null,
      shockMultiple: null,
      curve: null,
      curveBasis: curve?.basis ?? null,
    };
  }

  const now = borrowApyBpsAt(curve, utilizationBps);
  const shocked = borrowApyBpsAt(curve, Math.min(10_000, curve.kinkBps + SHOCK_OFFSET_BPS));

  return {
    protocol: reading.protocol,
    measured: true,
    utilizationBps,
    kinkBps: curve.kinkBps,
    headroomBps: curve.kinkBps - utilizationBps,
    pastKink: utilizationBps > curve.kinkBps,
    borrowApyBpsNow: now,
    borrowApyBpsAtKink: borrowApyBpsAt(curve, curve.kinkBps),
    shockMultiple: now > 0 ? Math.round((shocked / now) * 10) / 10 : null,
    curve: buildCurve(curve),
    curveBasis: curve.basis,
  };
}

/**
 * Pura, sem I/O — mesma disciplina de `computeSignal`/`computeCapacity`.
 * `curves` traz a curva por protocolo (ou `undefined` para quem não tem).
 */
export function computeSensitivity(
  asset: AssetId,
  readings: RateReading[],
  curves: Map<ProtocolId, BorrowRateCurve | undefined>,
  now: Date = new Date(),
): SensitivityReport {
  const entries = readings
    .map((r) => toEntry(r, curves.get(r.protocol)))
    .sort((a, b) => {
      // Medidos primeiro, e entre eles o de menor folga na frente: é a ordem em
      // que a informação importa para quem vai decidir.
      if (a.measured !== b.measured) return a.measured ? -1 : 1;
      return (a.headroomBps ?? Number.POSITIVE_INFINITY) - (b.headroomBps ?? Number.POSITIVE_INFINITY);
    });

  // Só entra na manchete quem foi medido E ainda está abaixo do joelho: dizer
  // "o mais apertado" apontando pra um mercado que já passou confundiria as duas
  // situações, que pedem reações diferentes.
  const belowKink = entries.filter((e) => e.measured && e.headroomBps !== null && e.headroomBps >= 0);
  const tightest = belowKink.length > 0 ? belowKink[0]! : null;

  return {
    asset,
    basis: "onchain-interest-rate-curve",
    tightestToKink: tightest ? { protocol: tightest.protocol, headroomBps: tightest.headroomBps! } : null,
    pastKink: entries.filter((e) => e.pastKink === true).map((e) => e.protocol),
    unmeasured: entries.filter((e) => !e.measured).map((e) => e.protocol),
    coverage: { measured: entries.filter((e) => e.measured).length, total: entries.length },
    entries,
    asOf: now.toISOString(),
  };
}
