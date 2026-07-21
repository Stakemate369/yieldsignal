/**
 * Descrição pública e legível por máquina do mecanismo de garantia econômica
 * (Camada 3). Exposto em `/guarantee/terms.json` (grátis, read-only).
 *
 * HONESTIDADE deliberada: o motor de resolução (resolveGuarantee.ts) está
 * pronto e testado, mas a CUSTÓDIA on-chain do bond (escrow que segura e
 * libera capital real) ainda NÃO foi deployada nem fundeada. Por isso o
 * `status` abaixo é explícito — nenhum robô pagante deve ler isto como uma
 * promessa de payout ativa. Quando o escrow for deployado e fundeado (decisão
 * manual do dono, ver src/guarantee/README.md), `status` vira "live" e os
 * campos de endereço do bond são preenchidos.
 */
export const GUARANTEE_TERMS = {
  mechanism: "economic-bond",
  status: "engine-ready:escrow-not-deployed" as "engine-ready:escrow-not-deployed" | "live",
  description:
    "Optional per-signal economic guarantee: when a signal is sold WITH a guarantee, the seller commits that the named best-risk-adjusted protocol will stay best (within a tolerance band) for a stated window. If another protocol overtakes it beyond tolerance inside the window, the buyer collects a fixed payout from the seller's on-chain bond. The resolution rule is deterministic and content-bound (see resolveGuarantee.ts) — no discretion after the fact.",
  rule: {
    breach:
      "best-risk-adjusted protocol != guaranteed protocol AND (best.weightedApyBps - guaranteed.weightedApyBps) > toleranceBps, observed within [issuedAt, issuedAt+windowSeconds]",
    noiseBand: "toleranceBps — sub-band moves do not count as a breach",
    windowBound: "only readings inside the window can trigger a payout",
    indeterminate: "an unreadable guaranteed-protocol APY yields no verdict (neither breach nor uphold) — re-verify within the window",
  },
  defaults: {
    toleranceBps: 15,
    windowSeconds: 3600,
    payoutMultipleOfPrice: 10,
  },
  bond: {
    // Preenchidos quando o escrow for deployado + fundeado (status -> "live").
    escrowAddress: null as string | null,
    fundedUsd: 0,
    chain: "base",
  },
} as const;

export type GuaranteeTerms = typeof GUARANTEE_TERMS;
