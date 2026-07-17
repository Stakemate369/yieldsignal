import { encodeAbiParameters, encodeFunctionData, zeroAddress, zeroHash } from "viem";
import type { YieldSignal } from "../signal/computeSignal.js";
import { EAS_ABI, SIGNAL_SCHEMA_TYPES } from "./schema.js";

/**
 * ABI-encoda só os campos "manchete" do sinal, na mesma ordem de
 * SIGNAL_SCHEMA_TYPES — puro, sem I/O, testável com fixtures (mesmo espírito
 * de signal/computeSignal.ts).
 */
export function encodeSignalData(signal: YieldSignal): `0x${string}` {
  const best = signal.rates.find((r) => r.protocol === signal.bestProtocol);
  if (!best) {
    throw new Error(`sinal inconsistente: bestProtocol "${signal.bestProtocol}" não aparece em rates`);
  }
  const asOfSeconds = BigInt(Math.floor(new Date(signal.asOf).getTime() / 1000));
  return encodeAbiParameters(SIGNAL_SCHEMA_TYPES, [
    signal.asset,
    signal.bestProtocol,
    BigInt(best.weightedApyBps),
    BigInt(signal.gapBps),
    asOfSeconds,
  ]);
}

/**
 * Calldata pronto pra `EAS.attest()` — atestação sem destinatário específico
 * (recipient zero: é um fato público, não dirigido a ninguém), irrevogável
 * (a atestação registra o que foi servido NUM MOMENTO real, revogar depois
 * derrotaria o propósito), sem `refUID` (não referencia atestação anterior)
 * e sem valor pago ao resolver (não há resolver, ver schema.ts).
 */
export function buildAttestCalldata(schemaUid: `0x${string}`, signal: YieldSignal): `0x${string}` {
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
          data: encodeSignalData(signal),
          value: 0n,
        },
      },
    ],
  });
}
