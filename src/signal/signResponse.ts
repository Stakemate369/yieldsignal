import { logger } from "../notify/logger.js";
import type { SignerAccount } from "../wallet/signerAccount.js";

export interface SignedPayload {
  signature: `0x${string}`;
  signer: `0x${string}`;
}

// `signMessage` é uma chamada remota (API da CDP) num request que já foi
// PAGO — sem limite de tempo, uma CDP lenta/instável travaria a resposta até
// o timeout da própria plataforma (Vercel) matar a function, e o comprador
// veria um 504 por algo que não tem nada a ver com o dado que ele comprou.
const SIGN_TIMEOUT_MS = 5_000;

/**
 * Assina (EIP-191 personal_sign) os bytes exatos servidos ao comprador —
 * verificável por qualquer cliente via `viem.verifyMessage({ address: signer,
 * message: raw, signature })`, sem precisar confiar no uptime do servidor no
 * momento da checagem (ao contrário de simplesmente reconsultar a API).
 * Nunca lança: o comprador já pagou pelo `raw` antes desta função rodar (ver
 * expressApp.ts/mcp.ts), então uma falha OU demora aqui não pode virar erro/
 * timeout 5xx — só degrada pra resposta sem assinatura, registrada como aviso.
 */
export async function signPayload(signer: SignerAccount, raw: string): Promise<SignedPayload | undefined> {
  try {
    const signature = await Promise.race([
      signer.signMessage(raw),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`timeout assinando resposta (${SIGN_TIMEOUT_MS}ms)`)), SIGN_TIMEOUT_MS),
      ),
    ]);
    return { signature, signer: signer.address };
  } catch (err) {
    logger.warn({ err }, "falha assinando resposta — servindo sem assinatura");
    return undefined;
  }
}
