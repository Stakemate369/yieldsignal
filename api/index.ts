import "dotenv/config";
import type { Request, Response } from "express";
import { createApp } from "../src/expressApp.js";
import { logger } from "../src/notify/logger.js";

/**
 * Entrypoint serverless (Vercel). `createApp()` é assíncrono (provisiona a
 * carteira via CDP) — cacheado em escopo de módulo pra rodar só uma vez por
 * instância "quente" (warm), não a cada request. `vercel.json` reescreve
 * toda rota pra cá, preservando o path original em `req.url`, que o próprio
 * roteamento do Express usa pra despachar pra `/signal/usdc-base-yield`.
 */
let appPromise: ReturnType<typeof createApp> | undefined;

export default async function handler(req: Request, res: Response): Promise<void> {
  if (!appPromise) {
    appPromise = createApp().catch((err) => {
      appPromise = undefined; // permite tentar de novo na próxima invocação, em vez de travar pra sempre
      throw err;
    });
  }

  try {
    const { app } = await appPromise;
    app(req, res);
  } catch (err) {
    logger.error({ err }, "falha inicializando o app na função serverless");
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "serviço temporariamente indisponível" }));
  }
}
