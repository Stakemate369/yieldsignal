import { collectRates } from "../signal/collectRates.js";
import { computeSignal } from "../signal/computeSignal.js";
import { ASSET_IDS, type AssetId } from "../market-data/types.js";

/**
 * Mostra o sinal calculado agora, sem servidor nem pagamento — pra conferir
 * manualmente que os números fazem sentido antes de vender de verdade.
 * `npm run signal` (USDC, default) ou `npm run signal -- WETH`/`-- ETH_STAKING`.
 */
async function main(): Promise<void> {
  const requested = (process.argv[2] ?? "USDC").toUpperCase();
  if (!ASSET_IDS.includes(requested as AssetId)) {
    throw new Error(`asset inválido: "${requested}" — use ${ASSET_IDS.join(" ou ")}`);
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
