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
  "POLY_BUILDER_CODE",
  "POLY_PRIVATE_KEY",
  "POLYGON_RPC_URL",
  "POLYGON_RPC_URLS",
  "POLYGON_RPC_FALLBACK_URL",
  "ALCHEMY_POLYGON_KEYS",
  "KRABS_AUTH_USERNAME",
  "KRABS_AUTH_PASSWORD",
  "KRABS_SESSION_SECRET",
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
  const emptyEnvDir = mkdtempSync(path.join(os.tmpdir(), "krabs-env-test-"));
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
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "krabs-config-test-"));
    const envPath = path.join(tempDir, "empty.env");
    writeFileSync(envPath, "");

    try {
      const config = loadEnv(envPath);
      expect(config.runtimeMode).toBeUndefined();
      expect(config.logLevel).toBe("info");
      expect(config.dbPath).toContain("krabs.db");
      expect(config.polyApiKey).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reads env vars correctly", () => {
    setEnvVars({
      RUNTIME_MODE: "live-lite",
      LOG_LEVEL: "debug",
      DB_PATH: "/tmp/test.db",
      POLY_API_KEY: "key123",
      POLY_API_SECRET: "secret456",
      POLY_PASSPHRASE: "pass789",
      POLY_PRIVATE_KEY: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      POLY_BUILDER_API_KEY: "builder-key",
      POLY_BUILDER_SECRET: "builder-secret",
      POLY_BUILDER_PASSPHRASE: "builder-pass",
      POLY_BUILDER_CODE: `0x${"a".repeat(64)}`,
      POLYGON_RPC_URL: "https://polygon-mainnet.g.alchemy.com/v2/test",
      POLYGON_RPC_URLS:
        "https://polygon-mainnet.g.alchemy.com/v2/test, https://polygon-mainnet.g.alchemy.com/v2/test2",
      POLYGON_RPC_FALLBACK_URL: "https://polygon.drpc.org",
    });

    const config = loadEnv(emptyEnvPath);
    expect(config.runtimeMode).toBe("live-lite");
    expect(config.logLevel).toBe("debug");
    expect(config.dbPath).toBe("/tmp/test.db");
    expect(config.polyApiKey).toBe("key123");
    expect(config.polyApiSecret).toBe("secret456");
    expect(config.polyPassphrase).toBe("pass789");
    expect(config.polyBuilderApiKey).toBe("builder-key");
    expect(config.polyBuilderSecret).toBe("builder-secret");
    expect(config.polyBuilderPassphrase).toBe("builder-pass");
    expect(config.polyBuilderCode).toBe(`0x${"a".repeat(64)}`);
    expect(config.polygonRpcUrl).toBe("https://polygon-mainnet.g.alchemy.com/v2/test");
    expect(config.polygonRpcUrls).toEqual([
      "https://polygon-mainnet.g.alchemy.com/v2/test",
      "https://polygon-mainnet.g.alchemy.com/v2/test2",
    ]);
    expect(config.polygonRpcFallbackUrl).toBe("https://polygon.drpc.org");
  });

  it("falls back to POLYGON_RPC_URL when POLYGON_RPC_URLS is omitted", () => {
    setEnvVars({
      POLYGON_RPC_URL: "https://polygon-mainnet.g.alchemy.com/v2/primary",
    });

    const config = loadEnv(emptyEnvPath);
    expect(config.polygonRpcUrls).toEqual(["https://polygon-mainnet.g.alchemy.com/v2/primary"]);
  });

  it("accepts live-lite mode without LIVE_LITE_* envelope vars", () => {
    setEnvVars(BASE_LIVE_LITE_VARS);
    const config = loadEnv(emptyEnvPath);
    expect(config.runtimeMode).toBe("live-lite");
  });

  it("resolves relative DB_PATH to absolute", () => {
    setEnvVars({ DB_PATH: "./data/test.db" });
    const config = loadEnv(emptyEnvPath);
    expect(config.dbPath).toMatch(/^\//);
    expect(config.dbPath).toContain("data/test.db");
  });

  it("requires POLY_API_KEY in live-lite mode", () => {
    setEnvVars({ RUNTIME_MODE: "live-lite" });
    expect(() => loadEnv(emptyEnvPath)).toThrow("POLY_API_KEY");
  });

  it("requires POLY_PASSPHRASE in live-lite mode", () => {
    setEnvVars({
      RUNTIME_MODE: "live-lite",
      POLY_API_KEY: "key",
      POLY_API_SECRET: "secret",
    });
    expect(() => loadEnv(emptyEnvPath)).toThrow("POLY_PASSPHRASE");
  });

  it("rejects simulation runtime mode", () => {
    setEnvVars({ RUNTIME_MODE: "simulation" });
    expect(() => loadEnv(emptyEnvPath)).toThrow("Invalid environment configuration");
  });

  it("rejects paper runtime mode", () => {
    setEnvVars({ RUNTIME_MODE: "paper" });
    expect(() => loadEnv(emptyEnvPath)).toThrow("Invalid environment configuration");
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

  it("rejects malformed POLY_BUILDER_CODE", () => {
    setEnvVars({ POLY_BUILDER_CODE: "not-bytes32" });
    expect(() => loadEnv(emptyEnvPath)).toThrow(
      "POLY_BUILDER_CODE must be a 0x-prefixed 32-byte hex value",
    );
  });

  it("accepts a valid POLY_BUILDER_CODE", () => {
    setEnvVars({ POLY_BUILDER_CODE: `0x${"f".repeat(64)}` });
    const config = loadEnv(emptyEnvPath);
    expect(config.polyBuilderCode).toBe(`0x${"f".repeat(64)}`);
  });

  it("treats empty POLY_BUILDER_CODE= as undefined (template default, not regex failure)", () => {
    // .env.example / .env.production.example ship the key with an empty value
    // so operators see it. Empty string must collapse to undefined so config
    // parse succeeds and the live-lite preflight gate handles the missing key.
    setEnvVars({ POLY_BUILDER_CODE: "" });
    expect(() => loadEnv(emptyEnvPath)).not.toThrow();
    const config = loadEnv(emptyEnvPath);
    expect(config.polyBuilderCode).toBeUndefined();
  });

  it("treats whitespace-only POLY_BUILDER_CODE as undefined", () => {
    setEnvVars({ POLY_BUILDER_CODE: "   " });
    expect(() => loadEnv(emptyEnvPath)).not.toThrow();
    const config = loadEnv(emptyEnvPath);
    expect(config.polyBuilderCode).toBeUndefined();
  });

  // LIVE_LITE_* envelope tests removed — envelope caps moved to profile_settings in control.db

  describe("ALCHEMY_POLYGON_KEYS parsing", () => {
    it("parses a comma-separated list of keys", () => {
      setEnvVars({ ALCHEMY_POLYGON_KEYS: "k1,k2,k3" });
      const config = loadEnv(emptyEnvPath);
      expect(config.alchemyPolygonKeys).toEqual(["k1", "k2", "k3"]);
    });

    it("trims whitespace around keys", () => {
      setEnvVars({ ALCHEMY_POLYGON_KEYS: " k1 , k2 " });
      const config = loadEnv(emptyEnvPath);
      expect(config.alchemyPolygonKeys).toEqual(["k1", "k2"]);
    });

    it("drops empty segments from the list", () => {
      setEnvVars({ ALCHEMY_POLYGON_KEYS: "k1,,k2," });
      const config = loadEnv(emptyEnvPath);
      expect(config.alchemyPolygonKeys).toEqual(["k1", "k2"]);
    });

    it("is undefined when the var is unset", () => {
      const config = loadEnv(emptyEnvPath);
      expect(config.alchemyPolygonKeys).toBeUndefined();
    });

    it("is undefined when the var is an empty string", () => {
      setEnvVars({ ALCHEMY_POLYGON_KEYS: "" });
      const config = loadEnv(emptyEnvPath);
      expect(config.alchemyPolygonKeys).toBeUndefined();
    });
  });

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
