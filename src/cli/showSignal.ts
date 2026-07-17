import { collectRates } from "../signal/collectRates.js";
import { computeSignal } from "../signal/computeSignal.js";
import type { AssetId } from "../market-data/types.js";

const VALID_ASSETS: AssetId[] = ["USDC", "WETH"];

/**
 * Mostra o sinal calculado agora, sem servidor nem pagamento — pra conferir
 * manualmente que os números fazem sentido antes de vender de verdade.
 * `npm run signal` (USDC, default) ou `npm run signal -- WETH`.
 */
async function main(): Promise<void> {
  const requested = (process.argv[2] ?? "USDC").toUpperCase();
  if (!VALID_ASSETS.includes(requested as AssetId)) {
    throw new Error(`asset inválido: "${requested}" — use ${VALID_ASSETS.join(" ou ")}`);
  }
  const asset = requested as AssetId;

  const readings = await collectRates(asset);
  const signal = computeSignal(readings);
  console.log(JSON.stringify(signal, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
