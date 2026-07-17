import "dotenv/config";
import { createApp } from "./expressApp.js";
import { loadEnv } from "./config/env.js";
import { logger } from "./notify/logger.js";

/** Entrypoint só pra desenvolvimento local — em produção real (Vercel) quem sobe é api/index.ts. */
async function main(): Promise<void> {
  const env = loadEnv();
  const { app, payToEvmAddress } = await createApp();

  app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, payTo: payToEvmAddress, environment: env.X402_ENVIRONMENT, price: env.PRICE_USD },
      "YieldSignal no ar",
    );
  });
}

main().catch((err) => {
  logger.error({ err }, "falha ao iniciar o servidor");
  process.exit(1);
});
