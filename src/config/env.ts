import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  // Credenciais CDP PRÓPRIAS deste projeto — nunca as mesmas do YieldPilot.
  // createX402Server() usa estas 3 pra provisionar automaticamente a carteira
  // que recebe os pagamentos (não existe endereço configurado à mão aqui).
  CDP_API_KEY_ID: z.string().min(1, "CDP_API_KEY_ID ausente"),
  CDP_API_KEY_SECRET: z.string().min(1, "CDP_API_KEY_SECRET ausente"),
  CDP_WALLET_SECRET: z.string().min(1, "CDP_WALLET_SECRET ausente"),
  // "development" liquida em base-sepolia (dinheiro de teste); "production" em
  // base mainnet (dinheiro real) — nomenclatura do próprio createX402Server.
  X402_ENVIRONMENT: z.enum(["development", "production"]).default("development"),
  // Carteira pessoal do usuário — único destino permitido pro comando de saque.
  // Vazio bloqueia o saque com erro claro, nunca manda pra outro lugar.
  OWNER_WALLET_ADDRESS: z
    .union([z.literal(""), z.string().regex(/^0x[a-fA-F0-9]{40}$/)])
    .default(""),
  // Endereço esperado da carteira receptora, pra travar a segurança sem
  // precisar de um arquivo local gravável (não existe disco persistente em
  // serverless/Vercel). Se vazio, cai pra trava por arquivo local (útil só
  // em desenvolvimento na própria máquina, antes de saber qual vai ser o
  // endereço). Ver wallet/walletLock.ts.
  EXPECTED_WALLET_ADDRESS: z
    .union([z.literal(""), z.string().regex(/^0x[a-fA-F0-9]{40}$/)])
    .default(""),
  // Preenchido depois de rodar `npm run register-schema` uma vez (ver
  // cli/registerSchema.ts) — vazio desliga `npm run attest`, resto do
  // produto funciona normalmente sem essa variável.
  EAS_SCHEMA_UID: z
    .union([z.literal(""), z.string().regex(/^0x[a-fA-F0-9]{64}$/)])
    .default(""),
  // Protege POST /internal/auto-attest (gasta ETH real de gas quando dispara)
  // — DIFERENTE do padrão usado em checks read-only: aqui vazio significa
  // NEGAR sempre (fail-closed), nunca "endpoint aberto por falta de config",
  // porque a rota pode gastar fundo real. Configurado no cron-job.org como
  // header `Authorization: Bearer <valor>`.
  CRON_TRIGGER_SECRET: z.string().default(""),
  // Piso de saldo de ETH abaixo do qual auto-attest se recusa a gastar mais
  // gas (pra nunca zerar o saldo sozinho) — resto do saque manual continua
  // funcionando normalmente mesmo abaixo desse piso.
  MIN_GAS_RESERVE_ETH: z.coerce.number().nonnegative().default(0.0005),
  PORT: z.coerce.number().int().positive().default(4021),
  // Formato "Money" do x402: "$" + valor decimal. Validado aqui pra falhar
  // com uma mensagem clara no boot, em vez de um erro opaco de dentro do
  // createX402Server/@x402/express (ver comentário em server.ts).
  PRICE_USD: z
    .string()
    .regex(/^\$\d+(\.\d{1,6})?$/, 'PRICE_USD precisa seguir o formato "$0.01" (cifrão + valor decimal)')
    .default("$0.01"),
  // Preço das rotas de DECISÃO (Camada 1 premium) — a decisão MOVE/HOLD vale
  // mais que o dado bruto, então cobra mais que PRICE_USD por padrão. Mesmo
  // formato "Money" do x402. Aplicado tanto nas rotas REST /decision/* quanto
  // na tool MCP get_yield_decision.
  DECISION_PRICE_USD: z
    .string()
    .regex(/^\$\d+(\.\d{1,6})?$/, 'DECISION_PRICE_USD precisa seguir o formato "$0.05" (cifrão + valor decimal)')
    .default("$0.05"),
  // Alerta operacional opcional pro dono (mesmo padrão do YieldPilot). Ambos
  // vazios = notificação desligada (no-op silencioso, ver notify/telegram.ts);
  // o resto do produto funciona normalmente sem isso. Usado hoje pra avisar
  // quando o auto-attest falha (ex.: saldo de gas abaixo do piso).
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),
  // Carteiras compradoras do PRÓPRIO dono (smoke/e-2-e/testes) — pagamentos
  // vindos delas NÃO contam como venda real e não disparam o alerta de
  // "pagador externo" (ver notify/paymentLog.ts). Lista separada por vírgula.
  // A carteira compradora conhecida já entra como default no código; some as
  // suas outras aqui se tiver mais de uma.
  SELF_PAYER_ADDRESSES: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Configuração inválida:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
