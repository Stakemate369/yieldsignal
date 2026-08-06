/**
 * REFERÊNCIA NÃO TESTADA — ver integrations/README.md. Escrito a partir do
 * formato conhecido de Action Provider do Coinbase AgentKit (classe que
 * estende `ActionProvider`, método decorado com `@CreateAction`), sem o
 * pacote `@coinbase/agentkit` instalado pra confirmar contra a versão atual.
 * Confira a assinatura de `ActionProvider`/`CreateAction`/`Network` antes de
 * usar — é o ponto mais provável de ter mudado.
 *
 * npm install @coinbase/agentkit yieldsignal-client @coinbase/cdp-sdk zod
 */
import { ActionProvider, CreateAction } from "@coinbase/agentkit";
import type { Network } from "@coinbase/agentkit";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { createYieldSignalClient, YIELD_SIGNAL_ASSETS, LENDING_ASSETS } from "yieldsignal-client";
import { z } from "zod";

const GetYieldSignalSchema = z.object({
  asset: z.enum(YIELD_SIGNAL_ASSETS).optional().default("USDC"),
});

/**
 * Os quatro produtos analíticos só existem pra mercado de empréstimo, então o
 * schema recusa ETH_STAKING em vez de deixar o agente pagar por um 404.
 */
const LendingAssetSchema = z.object({
  asset: z.enum(LENDING_ASSETS).optional().default("USDC"),
});

const GetCapacitySchema = LendingAssetSchema.extend({
  amountUsd: z.number().optional(),
});

const GetExposureSchema = LendingAssetSchema.extend({
  positions: z.string(),
});

/**
 * Paga $0.01 (x402, Base) por chamada via uma carteira CDP PRÓPRIA desta
 * action provider (CDP_API_KEY_ID/SECRET/WALLET_SECRET no ambiente do
 * agente) — não reaproveita o wallet provider do próprio AgentKit, porque
 * adaptar o signer nativo do AgentKit pro formato que `@x402/evm` espera é
 * específico da versão instalada e não dava pra verificar aqui sem o pacote.
 * Se o agente já tem uma carteira CDP funded, é a via mais direta.
 */
class YieldSignalActionProvider extends ActionProvider {
  constructor() {
    super("yieldsignal", []);
  }

  @CreateAction({
    name: "get_yield_signal",
    description:
      "Real-time risk-weighted yield signal: USDC/WETH lending APY on Base, or ETH_STAKING liquid staking APY on Ethereum mainnet. Costs $0.01 USDC per call via x402.",
    schema: GetYieldSignalSchema,
  })
  async getYieldSignal(args: z.infer<typeof GetYieldSignalSchema>): Promise<string> {
    const client = new CdpX402Client();
    const yieldSignal = createYieldSignalClient(client);
    const signal = await yieldSignal.getSignal(args.asset);
    return JSON.stringify(signal);
  }

  @CreateAction({
    name: "get_yield_durability",
    description:
      "How much of the current APY survives if incentives stop: base-vs-reward split per protocol, the post-incentive floor, and whether the leader changes without incentives. Sources that do not itemize the reward are listed as undecomposable, never assumed incentive-free. Base lending only. Costs $0.01 USDC per call via x402.",
    schema: LendingAssetSchema,
  })
  async getYieldDurability(args: z.infer<typeof LendingAssetSchema>): Promise<string> {
    const yieldSignal = createYieldSignalClient(new CdpX402Client());
    return JSON.stringify(await yieldSignal.getDurability(args.asset));
  }

  @CreateAction({
    name: "get_exit_capacity",
    description:
      "Can you actually withdraw? Per-protocol utilization and free liquidity read from the protocol's own books, plus whether your size can exit right now. A market at 99% utilization pays well and will not let you out. Protocols that do not expose borrowed-vs-supplied are marked unmeasured, never assumed liquid. Costs $0.01 USDC per call via x402.",
    schema: GetCapacitySchema,
  })
  async getExitCapacity(args: z.infer<typeof GetCapacitySchema>): Promise<string> {
    const yieldSignal = createYieldSignalClient(new CdpX402Client());
    return JSON.stringify(await yieldSignal.getCapacity(args.asset, args.amountUsd));
  }

  @CreateAction({
    name: "get_rate_sensitivity",
    description:
      "How close the market is to the kink where borrow rates explode: current utilization, the kink read from the protocol's own rate curve, headroom in bps, and how many times the borrow cost multiplies just past it. Aave and Compound only; others are marked unmeasured. Costs $0.01 USDC per call via x402.",
    schema: LendingAssetSchema,
  })
  async getRateSensitivity(args: z.infer<typeof LendingAssetSchema>): Promise<string> {
    const yieldSignal = createYieldSignalClient(new CdpX402Client());
    return JSON.stringify(await yieldSignal.getSensitivity(args.asset));
  }

  @CreateAction({
    name: "get_shared_exposure",
    description:
      "How much of a portfolio sits behind the same collateral, oracle or vault curator, and via which venues. Pass positions as protocol:usd pairs, e.g. 'aave:200000,morpho:150000'. Answers the question depeg and hack alerts do not: am I exposed, and through what path. Costs $0.01 USDC per call via x402.",
    schema: GetExposureSchema,
  })
  async getSharedExposure(args: z.infer<typeof GetExposureSchema>): Promise<string> {
    const yieldSignal = createYieldSignalClient(new CdpX402Client());
    return JSON.stringify(await yieldSignal.getExposure(args.asset, args.positions));
  }

  supportsNetwork = (_network: Network): boolean => true;
}

export const yieldSignalActionProvider = (): YieldSignalActionProvider => new YieldSignalActionProvider();
