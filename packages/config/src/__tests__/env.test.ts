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
  "POLY_API_KEY",
  "POLY_API_SECRET",
  "POLY_PASSPHRASE",
  "POLY_BUILDER_API_KEY",
  "POLY_BUILDER_SECRET",
  "POLY_BUILDER_PASSPHRASE",
  "POLY_PRIVATE_KEY",
  "POLYGON_RPC_URL",
  "POLYGON_RPC_FALLBACK_URL",
  "PLANKTON_AUTH_USERNAME",
  "PLANKTON_AUTH_PASSWORD",
  "PLANKTON_SESSION_SECRET",
  "TRUST_PROXY",
];

// LIVE_LITE_* env vars removed in Phase 3 — envelope caps now come from profile_settings in control.db
const BASE_LIVE_LITE_VARS = {
  RUNTIME_MODE: "live-lite",
  POLY_API_KEY: "key",
  POLY_API_SECRET: "secret",
  POLY_PASSPHRASE: "pass",
  POLY_PRIVATE_KEY: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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
      expect(config.runtimeMode).toBeUndefined();
      expect(config.logLevel).toBe("info");
      expect(config.dbPath).toContain("plankton.db");
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
      POLY_API_KEY: "key123",
      POLY_API_SECRET: "secret456",
      POLY_PASSPHRASE: "pass789",
      POLY_BUILDER_API_KEY: "builder-key",
      POLY_BUILDER_SECRET: "builder-secret",
      POLY_BUILDER_PASSPHRASE: "builder-pass",
      POLYGON_RPC_URL: "https://polygon-mainnet.g.alchemy.com/v2/test",
      POLYGON_RPC_FALLBACK_URL: "https://polygon.drpc.org",
    });

    const config = loadEnv();
    expect(config.runtimeMode).toBe("paper");
    expect(config.logLevel).toBe("debug");
    expect(config.dbPath).toBe("/tmp/test.db");
    expect(config.polyApiKey).toBe("key123");
    expect(config.polyApiSecret).toBe("secret456");
    expect(config.polyPassphrase).toBe("pass789");
    expect(config.polyBuilderApiKey).toBe("builder-key");
    expect(config.polyBuilderSecret).toBe("builder-secret");
    expect(config.polyBuilderPassphrase).toBe("builder-pass");
    expect(config.polygonRpcUrl).toBe("https://polygon-mainnet.g.alchemy.com/v2/test");
    expect(config.polygonRpcFallbackUrl).toBe("https://polygon.drpc.org");
  });

  it("accepts live-lite mode without LIVE_LITE_* envelope vars", () => {
    setEnvVars(BASE_LIVE_LITE_VARS);
    const config = loadEnv();
    expect(config.runtimeMode).toBe("live-lite");
  });

  it("resolves relative DB_PATH to absolute", () => {
    setEnvVars({ DB_PATH: "./data/test.db" });
    const config = loadEnv();
    expect(config.dbPath).toMatch(/^\//);
    expect(config.dbPath).toContain("data/test.db");
  });

  it("requires POLY_API_KEY in live-lite mode", () => {
    setEnvVars({ RUNTIME_MODE: "live-lite" });
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

  // LIVE_LITE_* envelope tests removed — envelope caps moved to profile_settings in control.db

  it("parses TRUST_PROXY string to boolean", () => {
    setEnvVars({ TRUST_PROXY: "true" });
    const config = loadEnv(emptyEnvPath);
    expect(config.trustProxy).toBe(true);
  });

  it("defaults TRUST_PROXY to false", () => {
    const config = loadEnv(emptyEnvPath);
    expect(config.trustProxy).toBe(false);
  });
});
