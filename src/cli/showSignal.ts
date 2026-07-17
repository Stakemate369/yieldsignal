import { collectRates } from "../signal/collectRates.js";
import { computeSignal } from "../signal/computeSignal.js";

/**
 * Mostra o sinal calculado agora, sem servidor nem pagamento — pra conferir
 * manualmente que os números fazem sentido antes de vender de verdade.
 */
async function main(): Promise<void> {
  const readings = await collectRates();
  const signal = computeSignal(readings);
  console.log(JSON.stringify(signal, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
