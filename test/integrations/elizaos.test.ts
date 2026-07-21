import { describe, it, expect } from "vitest";
import { yieldSignalPlugin, parseAsset } from "../../integrations/elizaos/yieldSignalPlugin.js";

describe("yieldSignalPlugin (ElizaOS)", () => {
  it("expõe a action GET_YIELD_SIGNAL com similes e descrição corretos", () => {
    expect(yieldSignalPlugin.name).toBe("yieldsignal");
    expect(yieldSignalPlugin.actions).toHaveLength(1);

    const action = yieldSignalPlugin.actions![0];
    expect(action.name).toBe("GET_YIELD_SIGNAL");
    expect(action.similes).toContain("BEST_LENDING_RATE");
    expect(action.similes).toContain("ETH_STAKING_APY");
    expect(action.description).toMatch(/USDC\/WETH lending APY on Base/);
    expect(action.description).toMatch(/ETH staking APY on Ethereum mainnet/);
  });

  describe("parseAsset", () => {
    it("default é USDC quando o texto não menciona nada específico", () => {
      expect(parseAsset("what's the best rate right now?")).toBe("USDC");
    });

    it("detecta WETH por menção a 'weth' ou 'eth' isolado", () => {
      expect(parseAsset("what's the best WETH lending rate?")).toBe("WETH");
      expect(parseAsset("best rate for eth on base")).toBe("WETH");
    });

    it("detecta ETH_STAKING antes do fallback genérico de WETH — 'ETH staking' não pode virar WETH lending", () => {
      expect(parseAsset("what's the best ETH staking rate?")).toBe("ETH_STAKING");
      expect(parseAsset("should I stake my eth?")).toBe("ETH_STAKING");
      expect(parseAsset("what does Lido pay right now?")).toBe("ETH_STAKING");
    });
  });

  it("validate sempre resolve true — não depende de wallet configurada pra ser oferecida como ação", async () => {
    const action = yieldSignalPlugin.actions![0];
    await expect(action.validate({} as never, {} as never)).resolves.toBe(true);
  });

  it("handler retorna ActionResult com success:false (não boolean) quando a chamada paga falha", async () => {
    const action = yieldSignalPlugin.actions![0];
    const message = { content: { text: "what's the best USDC rate?" } } as never;

    const result = await action.handler({} as never, message, undefined, undefined, undefined);
    expect(typeof result).toBe("object");
    expect((result as { success: boolean }).success).toBe(false);
  });
});
