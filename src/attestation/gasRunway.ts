import { createPublicClient, http, parseEther } from "viem";
import { withdrawNetworkFor } from "../config/networks.js";
import { loadEnv } from "../config/env.js";

/**
 * QUANTO AINDA DÁ PRA ATESTAR antes do saldo bater na reserva.
 *
 * Existe por causa de um incidente real (2026-08-05): o saldo caiu 1 centavo de
 * dólar abaixo da reserva mínima, o gatilho parou de publicar, e o aviso só
 * chegou DEPOIS de já estar bloqueando. Resultado: 11 horas sem registro
 * on-chain — e atestação não pode ser retroagida, então esse buraco no
 * histórico é permanente. O histórico é justamente o único ativo do serviço que
 * leva calendário pra reconstruir.
 *
 * A correção não é avisar mais alto, é avisar ANTES. E a unidade importa:
 * "saldo abaixo de X wei" não diz nada a quem lê; "cabem mais N atestações"
 * diz exatamente quanto tempo você tem.
 */

/**
 * Custo observado de UMA atestação, medido na transação real de 2026-08-05
 * (0,000002265 ETH a 0,006 gwei na Base). Arredondado PRA CIMA, de propósito:
 * este número serve só pra decidir quando avisar, e um aviso adiantado demais
 * custa uma mensagem, enquanto um atrasado custa buraco permanente no
 * histórico. Se o gas na Base subir muito, a folga real encolhe e o aviso
 * dispara ainda mais cedo — que é o lado certo pra errar.
 */
export const OBSERVED_ATTESTATION_COST_WEI = 5_000_000_000_000n; // 0,000005 ETH

/**
 * Abaixo disto o alerta dispara. ~50 atestações são cerca de uma semana no
 * ritmo observado (3 assets, gatilho horário, publicando por mudança material
 * ou 12h de staleness) — prazo folgado pra um humano reagir sem correria.
 */
export const LOW_RUNWAY_ATTESTATIONS = 50;

export type GasRunwayStatus = "ok" | "low" | "blocked";

export interface GasRunway {
  balanceWei: bigint;
  reserveWei: bigint;
  /** Quantas atestações ainda cabem antes de encostar na reserva. */
  attestationsLeft: number;
  status: GasRunwayStatus;
  /** Mensagem pronta pro alerta quando não está `ok`; `null` quando está. */
  message: string | null;
}

/**
 * Pura — a decisão de avisar fica testável sem RPC nem carteira.
 *
 * `blocked` e `low` são estados DIFERENTES de propósito: bloqueado significa
 * que o registro já parou (o dano começou), enquanto baixo significa que ainda
 * dá pra agir. Colapsar os dois num "problema de gas" perderia justamente a
 * distinção que faz o aviso ser útil.
 */
export function assessGasRunway(
  balanceWei: bigint,
  reserveWei: bigint,
  address: string,
  costPerAttestationWei: bigint = OBSERVED_ATTESTATION_COST_WEI,
): GasRunway {
  const usable = balanceWei > reserveWei ? balanceWei - reserveWei : 0n;
  // Custo zero ou negativo tornaria a divisão sem sentido; nesse caso não há
  // base pra afirmar folga nenhuma, e não afirmar é melhor que afirmar errado.
  const attestationsLeft = costPerAttestationWei > 0n ? Number(usable / costPerAttestationWei) : 0;

  if (balanceWei <= reserveWei) {
    return {
      balanceWei,
      reserveWei,
      attestationsLeft: 0,
      status: "blocked",
      message:
        `saldo de gas ABAIXO da reserva — o registro on-chain já parou e o histórico perdido não pode ser retroagido. ` +
        `Mande ETH pra ${address} na Base mainnet.`,
    };
  }

  if (attestationsLeft < LOW_RUNWAY_ATTESTATIONS) {
    return {
      balanceWei,
      reserveWei,
      attestationsLeft,
      status: "low",
      message:
        `folga de gas baixa: cabem ~${attestationsLeft} atestações antes de bloquear (limiar ${LOW_RUNWAY_ATTESTATIONS}). ` +
        `Ainda publicando normalmente — mande ETH pra ${address} na Base mainnet antes que pare.`,
    };
  }

  return { balanceWei, reserveWei, attestationsLeft, status: "ok", message: null };
}

/**
 * Lê o saldo e avalia a folga. Mesma resolução de rede de
 * `publishAttestation` (`withdrawNetworkFor`), pra a sonda nunca olhar uma
 * chain diferente da que de fato gasta o gas.
 */
export async function readGasRunway(address: string, minGasReserveEth: number): Promise<GasRunway> {
  const env = loadEnv();
  const { chain } = withdrawNetworkFor(env.X402_ENVIRONMENT);
  const publicClient = createPublicClient({ chain, transport: http() });
  const balanceWei = await publicClient.getBalance({ address: address as `0x${string}` });
  return assessGasRunway(balanceWei, parseEther(String(minGasReserveEth)), address);
}
