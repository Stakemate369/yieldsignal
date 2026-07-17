import { describe, it, expect, beforeEach, vi } from "vitest";
import type { consumeFreeTrial as ConsumeFreeTrial } from "../src/freeTrial.js";

// Módulo tem um Map em escopo de módulo (contador por dia/IP) — cada teste
// precisa de uma instância nova, senão a cota de um teste vaza pro próximo.
let consumeFreeTrial: typeof ConsumeFreeTrial;

beforeEach(async () => {
  vi.resetModules();
  ({ consumeFreeTrial } = await import("../src/freeTrial.js"));
});

describe("consumeFreeTrial", () => {
  it("permite as primeiras 3 chamadas do dia pro mesmo IP", () => {
    expect(consumeFreeTrial("1.2.3.4")).toBe(true);
    expect(consumeFreeTrial("1.2.3.4")).toBe(true);
    expect(consumeFreeTrial("1.2.3.4")).toBe(true);
  });

  it("bloqueia a 4ª chamada do mesmo IP no mesmo dia", () => {
    consumeFreeTrial("1.2.3.4");
    consumeFreeTrial("1.2.3.4");
    consumeFreeTrial("1.2.3.4");
    expect(consumeFreeTrial("1.2.3.4")).toBe(false);
  });

  it("mantém cotas independentes por IP", () => {
    consumeFreeTrial("1.1.1.1");
    consumeFreeTrial("1.1.1.1");
    consumeFreeTrial("1.1.1.1");
    expect(consumeFreeTrial("1.1.1.1")).toBe(false);
    // IP diferente ainda tem cota cheia
    expect(consumeFreeTrial("2.2.2.2")).toBe(true);
  });
});
