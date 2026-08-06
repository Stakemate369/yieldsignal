import { logger } from "./logger.js";

/**
 * O CÓDIGO NO AR É O CÓDIGO MAIS RECENTE?
 *
 * Existe por dois incidentes reais, do mesmo tipo. Em 2026-08-05 descobriu-se
 * que a integração Vercel↔GitHub estava desconectada e SEIS DIAS de commits
 * nunca tinham ido ao ar — invisível de fora, porque produção seguia
 * respondendo normalmente com o código antigo. Em 2026-08-06, já com a esteira
 * própria funcionando, dois deploys seguidos foram cancelados pelo GitHub por
 * falta de runner, sem executar um passo sequer.
 *
 * O que os dois têm em comum: nada falha visivelmente. O serviço continua no
 * ar, os testes continuam verdes, e a única evidência é uma rota nova que
 * responde 404. Um alerta de "publicação parada" é a peça que faltava.
 *
 * Sem estado durável: em vez de guardar "quando foi o último deploy", compara o
 * SHA em execução com o topo do branch e usa a IDADE do commit como período de
 * carência. Deploy em andamento é normal por alguns minutos; commit de duas
 * horas que ainda não subiu, não é.
 */

const REPO = "Stakemate369/yieldsignal";
const BRANCH = "main";
const REQUEST_TIMEOUT_MS = 6_000;

/** Carência antes de considerar que a publicação travou, e não que está em curso. */
export const DEPLOY_GRACE_MS = 2 * 60 * 60 * 1_000;

export type DeployDriftStatus = "current" | "stale" | "unknown";

export interface DeployDrift {
  status: DeployDriftStatus;
  deployedSha: string | null;
  latestSha: string | null;
  commitAgeMs: number | null;
  /** Mensagem pronta pro alerta quando `stale`; `null` nos demais casos. */
  message: string | null;
}

/**
 * Pura — decide sem I/O, então o critério fica testável.
 *
 * `unknown` NÃO alerta de propósito: rodando fora da Vercel (local, teste) não
 * existe SHA de deploy, e transformar isso em alerta faria a checagem gritar em
 * todo ambiente de desenvolvimento até alguém aprender a ignorá-la — que é como
 * um alerta morre.
 */
export function assessDeployDrift(
  deployedSha: string | null,
  latestSha: string | null,
  commitAgeMs: number | null,
): DeployDrift {
  if (!deployedSha || !latestSha || commitAgeMs === null) {
    return { status: "unknown", deployedSha, latestSha, commitAgeMs, message: null };
  }
  // Compara por prefixo: a Vercel expõe o SHA completo, mas comparar os 7
  // primeiros basta e sobrevive a qualquer diferença de formato.
  const same = deployedSha.slice(0, 7).toLowerCase() === latestSha.slice(0, 7).toLowerCase();
  if (same) {
    return { status: "current", deployedSha, latestSha, commitAgeMs, message: null };
  }
  if (commitAgeMs < DEPLOY_GRACE_MS) {
    // Provavelmente um deploy em andamento — ainda dentro da carência.
    return { status: "current", deployedSha, latestSha, commitAgeMs, message: null };
  }
  const horas = Math.round(commitAgeMs / 3_600_000);
  return {
    status: "stale",
    deployedSha,
    latestSha,
    commitAgeMs,
    message:
      `publicação parada: produção roda ${deployedSha.slice(0, 7)} enquanto ${BRANCH} está em ` +
      `${latestSha.slice(0, 7)}, commitado há ~${horas}h. O serviço segue no ar com código antigo — ` +
      `nada falha visivelmente, então isso só aparece aqui.`,
  };
}

/**
 * Lê o SHA em execução (injetado pela Vercel) e o topo do branch pela API
 * pública do GitHub — repositório é público, então não precisa de token, e o
 * limite de 60 req/h por IP é folgado pra uma checagem horária.
 *
 * Nunca lança: uma falha de rede aqui não pode derrubar a checagem que carrega
 * o alerta de atestação, que é o sinal principal.
 */
export async function readDeployDrift(): Promise<DeployDrift> {
  const deployedSha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "yieldsignal-deploy-drift" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
    const json = (await res.json()) as { sha?: string; commit?: { committer?: { date?: string } } };
    const latestSha = json.sha ?? null;
    const dateIso = json.commit?.committer?.date;
    const commitAgeMs = dateIso ? Date.now() - new Date(dateIso).getTime() : null;
    return assessDeployDrift(deployedSha, latestSha, commitAgeMs);
  } catch (err) {
    logger.warn({ err }, "falha checando se o código em produção está atualizado");
    return { status: "unknown", deployedSha, latestSha: null, commitAgeMs: null, message: null };
  }
}
