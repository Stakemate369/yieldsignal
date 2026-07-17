import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assertWalletAddressLock } from "../src/wallet/walletLock.js";

const ADDRESS_A = "0x33C2a0F991b06d9C1F4456D60cda923a2378E8d9";
const ADDRESS_B = "0x5BC1793F7D9536087788e8E981fA8868ff966ea7";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yieldsignal-wallet-lock-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("assertWalletAddressLock", () => {
  it("na primeira verificação, trava o endereço e não lança", () => {
    expect(() => assertWalletAddressLock("production", ADDRESS_A, tmpDir)).not.toThrow();
    const lockPath = path.join(tmpDir, "state", "production-wallet.lock.json");
    expect(fs.existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    expect(lock.address).toBe(ADDRESS_A);
  });

  it("em verificações seguintes com o MESMO endereço, não lança", () => {
    assertWalletAddressLock("production", ADDRESS_A, tmpDir);
    expect(() => assertWalletAddressLock("production", ADDRESS_A, tmpDir)).not.toThrow();
  });

  it("é case-insensitive na comparação de endereço (checksum pode variar)", () => {
    assertWalletAddressLock("production", ADDRESS_A, tmpDir);
    expect(() => assertWalletAddressLock("production", ADDRESS_A.toLowerCase(), tmpDir)).not.toThrow();
  });

  it("lança se o endereço mudar depois de travado — mesma classe de bug do incidente do YieldPilot (2026-07-16)", () => {
    assertWalletAddressLock("production", ADDRESS_A, tmpDir);
    expect(() => assertWalletAddressLock("production", ADDRESS_B, tmpDir)).toThrow(/TRAVA DE SEGURANÇA/);
  });

  it("mantém locks de development e production independentes um do outro", () => {
    assertWalletAddressLock("production", ADDRESS_A, tmpDir);
    expect(() => assertWalletAddressLock("development", ADDRESS_B, tmpDir)).not.toThrow();
    expect(() => assertWalletAddressLock("production", ADDRESS_B, tmpDir)).toThrow(/TRAVA DE SEGURANÇA/);
    expect(() => assertWalletAddressLock("development", ADDRESS_A, tmpDir)).toThrow(/TRAVA DE SEGURANÇA/);
  });
});
