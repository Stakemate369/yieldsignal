import { encodeAbiParameters, encodeFunctionData, zeroAddress, zeroHash } from "viem";
import type { YieldSignal } from "../signal/computeSignal.js";
import { EAS_ABI, SIGNAL_SCHEMA_TYPES, SIGNAL_SCHEMA_TYPES_V2 } from "./schema.js";

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
 * Versão v2: os mesmos campos MAIS o segundo colocado e a cobertura da leitura
 * — ver SIGNAL_SCHEMA_V2 em schema.ts pro porquê.
 *
 * Sem 2º colocado (um único protocolo legível na chamada), grava string vazia e
 * APY zero: é a representação honesta de "não havia contra quem comparar", e
 * inventar um concorrente seria pior que registrar o vazio.
 */
export function encodeSignalDataV2(signal: YieldSignal): `0x${string}` {
  const best = signal.rates.find((r) => r.protocol === signal.bestProtocol);
  if (!best) {
    throw new Error(`sinal inconsistente: bestProtocol "${signal.bestProtocol}" não aparece em rates`);
  }
  // `rates` já vem ordenado desc por weightedApyBps (computeSignal), mas resolvo
  // o 2º pela posição relativa ao vencedor pra não depender dessa ordem.
  const runnerUp = signal.rates.filter((r) => r.protocol !== signal.bestProtocol).sort((a, b) => b.weightedApyBps - a.weightedApyBps)[0];
  const asOfSeconds = BigInt(Math.floor(new Date(signal.asOf).getTime() / 1000));
  return encodeAbiParameters(SIGNAL_SCHEMA_TYPES_V2, [
    signal.asset,
    signal.bestProtocol,
    BigInt(best.weightedApyBps),
    BigInt(signal.gapBps),
    asOfSeconds,
    runnerUp?.protocol ?? "",
    BigInt(runnerUp?.weightedApyBps ?? 0),
    BigInt(signal.coverage.read),
    BigInt(signal.coverage.expected),
  ]);
}

/**
 * Calldata pronto pra `EAS.attest()` — atestação sem destinatário específico
 * (recipient zero: é um fato público, não dirigido a ninguém), irrevogável
 * (a atestação registra o que foi servido NUM MOMENTO real, revogar depois
 * derrotaria o propósito), sem `refUID` (não referencia atestação anterior)
 * e sem valor pago ao resolver (não há resolver, ver schema.ts).
 */
export function buildAttestCalldata(schemaUid: `0x${string}`, signal: YieldSignal, version: 1 | 2 = 1): `0x${string}` {
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
          // A versão é explícita (não deduzida do UID): gravar com a codificação
          // errada produziria uma atestação permanente e ilegível.
          data: version === 2 ? encodeSignalDataV2(signal) : encodeSignalData(signal),
          value: 0n,
        },
      },
    ],
  });
}
