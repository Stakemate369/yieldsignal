import "dotenv/config";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  toBytes,
  verifyTypedData,
} from "viem";
import { base } from "viem/chains";

// Prova end-to-end de PAGAMENTO REAL + VERIFICAÇÃO — dinheiro de verdade na
// Base mainnet. Exercita exatamente o caminho que o elizaos-plugin-yieldsignal
// blindado (0.2.0) faz: paga via x402, lê o corpo BRUTO, e roda a MESMA
// verificação EIP-712 do plugin (viem.verifyTypedData + contentHash amarrado ao
// corpo + signer fixado no payee anunciado). Rode assim (gasta ~$0.01/$0.05):
//   tsx scripts/evidenceE2E.mts https://yieldsignal.vercel.app/signal/usdc-base-yield
//   tsx scripts/evidenceE2E.mts https://yieldsignal.vercel.app/decision/usdc-base-yield?position=aave

const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
// Endereço receptor/assinante anunciado do serviço — o plugin fixa o signer aqui.
const ADVERTISED_PAYEE = getAddress(
  "0x561143BFE9E2D975D92e915B8EfFEAa54119472a",
);
const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// Mesma verificação que o plugin ships (src/security.ts#verifyYieldSignalSignature).
// A rota /signal assina o corpo inteiro (o corpo É o sinal); a rota /decision
// assina o SINAL EMBUTIDO (`decision.signal`), não o corpo da decisão — então o
// contentHash é sobre esse sub-objeto. `signedBytes` já vem resolvido conforme
// a rota.
async function verifySignature(params: {
  signedBytes: string;
  signature: `0x${string}`;
  signer: `0x${string}`;
  eip712Json: string;
}): Promise<{ signerMatchesPayee: boolean; contentHashMatches: boolean; signatureValid: boolean }> {
  const { signedBytes, signature, signer, eip712Json } = params;
  const signerMatchesPayee = getAddress(signer) === ADVERTISED_PAYEE;
  const { domain, types, primaryType, message } = JSON.parse(eip712Json);
  const contentHashMatches = message.contentHash === keccak256(toBytes(signedBytes));
  let signatureValid = false;
  try {
    signatureValid = await verifyTypedData({
      address: getAddress(signer),
      domain,
      types,
      primaryType,
      message: {
        ...message,
        weightedApyBps: BigInt(message.weightedApyBps),
        gapBps: BigInt(message.gapBps),
        asOf: BigInt(message.asOf),
      },
      signature,
    });
  } catch {
    signatureValid = false;
  }
  return { signerMatchesPayee, contentHashMatches, signatureValid };
}

async function main(): Promise<void> {
  const url =
    process.argv[2] ?? "https://yieldsignal.vercel.app/signal/usdc-base-yield";

  const client = new CdpX402Client();
  const { evmAddress } = await client.getAddresses();

  const publicClient = createPublicClient({ chain: base, transport: http() });
  const balanceBefore = (await publicClient.readContract({
    address: USDC_BASE_MAINNET,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [evmAddress],
  })) as bigint;

  if (balanceBefore === 0n) {
    throw new Error("Saldo zero — financie a carteira compradora com USDC real na Base antes de rodar.");
  }

  const fetchWithPayment = wrapFetchWithPayment(
    fetch,
    client as unknown as Parameters<typeof wrapFetchWithPayment>[1],
  );
  const startedAt = new Date().toISOString();
  const res = await fetchWithPayment(url);
  const raw = await res.text();

  const signature = res.headers.get("x-signal-signature") as `0x${string}` | null;
  const signer = res.headers.get("x-signal-signer") as `0x${string}` | null;
  const eip712Json = res.headers.get("x-signal-eip712-payload");

  const body = JSON.parse(raw) as {
    asset?: string;
    bestProtocol?: string;
    gapBps?: number;
    // Presente na rota /decision — é o sub-objeto que foi assinado.
    signal?: { bestProtocol?: string; gapBps?: number };
  };
  // A rota /decision assina `JSON.stringify(decision.signal)`; a /signal assina
  // o corpo inteiro. Reproduz os bytes exatos que o servidor assinou.
  const signedBytes = body.signal !== undefined ? JSON.stringify(body.signal) : raw;

  const verification =
    signature && signer && eip712Json
      ? await verifySignature({ signedBytes, signature, signer, eip712Json })
      : null;

  // A liquidação x402 (transferência USDC via facilitator) pode não ter minerado
  // ainda quando lemos o saldo — faz polling curto até o saldo cair.
  let balanceAfter = balanceBefore;
  for (let i = 0; i < 12 && balanceAfter >= balanceBefore; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    balanceAfter = (await publicClient.readContract({
      address: USDC_BASE_MAINNET,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [evmAddress],
    })) as bigint;
  }

  console.log("===== YieldSignal — evidência de pagamento real e-2-e =====");
  console.log(JSON.stringify(
    {
      startedAt,
      url,
      buyerWallet: evmAddress,
      usdcBalanceBefore: `$${(Number(balanceBefore) / 1e6).toFixed(6)}`,
      usdcBalanceAfter: `$${(Number(balanceAfter) / 1e6).toFixed(6)}`,
      spentUsd: `$${(Number(balanceBefore - balanceAfter) / 1e6).toFixed(6)}`,
      httpStatus: res.status,
      responseSigned: Boolean(signature && signer && eip712Json),
      signer,
      advertisedPayee: ADVERTISED_PAYEE,
      verification,
      signal: {
        asset: body.asset,
        bestProtocol: body.bestProtocol ?? body.signal?.bestProtocol,
        gapBps: body.gapBps ?? body.signal?.gapBps,
      },
    },
    null,
    2,
  ));

  const ok =
    res.status === 200 &&
    verification?.signerMatchesPayee &&
    verification.contentHashMatches &&
    verification.signatureValid &&
    balanceAfter < balanceBefore;
  console.log(ok ? "\nRESULTADO: PASS ✓ (pago de verdade + assinatura verificada)" : "\nRESULTADO: FALHOU ✗");
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
