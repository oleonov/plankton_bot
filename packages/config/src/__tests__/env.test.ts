import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadEnv } from "../env.js";

function setEnvVars(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
}

function clearEnvVars(keys: string[]): void {
  for (const key of keys) {
    delete process.env[key];
  }
}

const ALL_KEYS = [
  "RUNTIME_MODE",
  "LOG_LEVEL",
  "DB_PATH",
  "FAMILY_RULES_PATH",
  "POLY_API_KEY",
  "POLY_API_SECRET",
  "POLY_PASSPHRASE",
  "POLY_PRIVATE_KEY",
  "LIVE_LITE_CONFIRM",
  "LIVE_LITE_FAMILY_ALLOWLIST",
  "LIVE_LITE_MAX_FAMILIES",
  "LIVE_LITE_MAX_OPEN_VALUE_USDC",
  "LIVE_LITE_MAX_ORDER_USDC",
  "LIVE_LITE_MAX_ACTIVE_MARKETS",
];

const BASE_LIVE_LITE_VARS = {
  RUNTIME_MODE: "live-lite",
  LIVE_LITE_CONFIRM: "true",
  POLY_API_KEY: "key",
  POLY_API_SECRET: "secret",
  POLY_PASSPHRASE: "pass",
  POLY_PRIVATE_KEY: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  LIVE_LITE_FAMILY_ALLOWLIST: "familyA,familyB",
  LIVE_LITE_MAX_FAMILIES: "5",
  LIVE_LITE_MAX_OPEN_VALUE_USDC: "10000",
  LIVE_LITE_MAX_ORDER_USDC: "500",
  LIVE_LITE_MAX_ACTIVE_MARKETS: "20",
};

describe("loadEnv", () => {
  const saved: Record<string, string | undefined> = {};

  // Explicit empty .env file to prevent loadEnv() from loading the real root .env
  const emptyEnvDir = mkdtempSync(path.join(os.tmpdir(), "plankton-env-test-"));
  const emptyEnvPath = path.join(emptyEnvDir, "empty.env");
  writeFileSync(emptyEnvPath, "");

  beforeEach(() => {
    for (const key of ALL_KEYS) {
      saved[key] = process.env[key];
    }
    clearEnvVars(ALL_KEYS);
  });

  afterEach(() => {
    clearEnvVars(ALL_KEYS);
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  });

  it("returns defaults when no env vars are set", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "plankton-config-test-"));
    const envPath = path.join(tempDir, "empty.env");
    writeFileSync(envPath, "");

    try {
      const config = loadEnv(envPath);
      expect(config.runtimeMode).toBe("simulation");
      expect(config.logLevel).toBe("info");
      expect(config.dbPath).toContain("plankton.db");
      expect(config.familyRulesPath).toContain("family_rules.yaml");
      expect(config.polyApiKey).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reads env vars correctly", () => {
    setEnvVars({
      RUNTIME_MODE: "paper",
      LOG_LEVEL: "debug",
      DB_PATH: "/tmp/test.db",
      FAMILY_RULES_PATH: "/tmp/rules.yaml",
      POLY_API_KEY: "key123",
      POLY_API_SECRET: "secret456",
      POLY_PASSPHRASE: "pass789",
    });

    const config = loadEnv();
    expect(config.runtimeMode).toBe("paper");
    expect(config.logLevel).toBe("debug");
    expect(config.dbPath).toBe("/tmp/test.db");
    expect(config.familyRulesPath).toBe("/tmp/rules.yaml");
    expect(config.polyApiKey).toBe("key123");
    expect(config.polyApiSecret).toBe("secret456");
    expect(config.polyPassphrase).toBe("pass789");
  });

  it("resolves relative DB_PATH to absolute", () => {
    setEnvVars({ DB_PATH: "./data/test.db" });
    const config = loadEnv();
    expect(config.dbPath).toMatch(/^\//);
    expect(config.dbPath).toContain("data/test.db");
  });

  it("requires POLY_API_KEY in live-lite mode", () => {
    setEnvVars({ RUNTIME_MODE: "live-lite", LIVE_LITE_CONFIRM: "true" });
    expect(() => loadEnv(emptyEnvPath)).toThrow("POLY_API_KEY");
  });

  it("requires POLY_API_SECRET in paper mode", () => {
    setEnvVars({
      RUNTIME_MODE: "paper",
      POLY_API_KEY: "key",
      POLY_PASSPHRASE: "pass",
    });
    expect(() => loadEnv(emptyEnvPath)).toThrow("POLY_API_SECRET");
  });

  it("requires POLY_PASSPHRASE in live-lite mode", () => {
    setEnvVars({
      RUNTIME_MODE: "live-lite",
      LIVE_LITE_CONFIRM: "true",
      POLY_API_KEY: "key",
      POLY_API_SECRET: "secret",
    });
    expect(() => loadEnv(emptyEnvPath)).toThrow("POLY_PASSPHRASE");
  });

  it("does not require POLY_* in simulation mode", () => {
    setEnvVars({ RUNTIME_MODE: "simulation" });
    const config = loadEnv();
    expect(config.runtimeMode).toBe("simulation");
  });

  it("rejects invalid RUNTIME_MODE", () => {
    setEnvVars({ RUNTIME_MODE: "invalid" });
    expect(() => loadEnv()).toThrow("Invalid environment configuration");
  });

  it("rejects invalid LOG_LEVEL", () => {
    setEnvVars({ LOG_LEVEL: "verbose" });
    expect(() => loadEnv()).toThrow("Invalid environment configuration");
  });

  it("requires POLY_PRIVATE_KEY in live-lite mode", () => {
    setEnvVars({
      RUNTIME_MODE: "live-lite",
      LIVE_LITE_CONFIRM: "true",
      POLY_API_KEY: "key",
      POLY_API_SECRET: "secret",
      POLY_PASSPHRASE: "pass",
    });
    expect(() => loadEnv()).toThrow("POLY_PRIVATE_KEY");
  });

  it("rejects malformed POLY_PRIVATE_KEY in live-lite mode", () => {
    setEnvVars({
      ...BASE_LIVE_LITE_VARS,
      POLY_PRIVATE_KEY: "not-a-valid-key",
    });
    expect(() => loadEnv()).toThrow("0x-prefixed 32-byte hex");
  });

  it("requires live-lite envelope vars when RUNTIME_MODE=live-lite", () => {
    setEnvVars({
      RUNTIME_MODE: "live-lite",
      LIVE_LITE_CONFIRM: "true",
      POLY_API_KEY: "key",
      POLY_API_SECRET: "secret",
      POLY_PASSPHRASE: "pass",
      POLY_PRIVATE_KEY: "0xabc",
    });
    expect(() => loadEnv()).toThrow("LIVE_LITE_FAMILY_ALLOWLIST");
  });

  it("parses live-lite envelope vars correctly when all are present", () => {
    setEnvVars(BASE_LIVE_LITE_VARS);
    const config = loadEnv();
    expect(config.liveLite).toBeDefined();
    expect(config.liveLite?.familyAllowlist).toEqual(["familyA", "familyB"]);
    expect(config.liveLite?.maxFamilies).toBe(5);
    expect(config.liveLite?.maxOpenValueUsdc).toBe(10000);
    expect(config.liveLite?.maxOrderUsdc).toBe(500);
    expect(config.liveLite?.maxActiveMarkets).toBe(20);
  });

  it("rejects allowlist longer than maxFamilies", () => {
    setEnvVars({
      ...BASE_LIVE_LITE_VARS,
      LIVE_LITE_FAMILY_ALLOWLIST: "a,b,c,d",
      LIVE_LITE_MAX_FAMILIES: "2",
    });
    expect(() => loadEnv()).toThrow("allowlist length 4 exceeds maxFamilies 2");
  });

  it("returns undefined liveLite in simulation mode", () => {
    setEnvVars({ RUNTIME_MODE: "simulation" });
    const config = loadEnv();
    expect(config.liveLite).toBeUndefined();
  });
});
