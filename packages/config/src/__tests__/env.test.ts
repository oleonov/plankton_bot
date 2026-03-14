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
  "LIVE_LITE_CONFIRM",
];

describe("loadEnv", () => {
  const saved: Record<string, string | undefined> = {};

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
    const config = loadEnv();
    expect(config.runtimeMode).toBe("simulation");
    expect(config.logLevel).toBe("info");
    expect(config.dbPath).toContain("plankton.db");
    expect(config.familyRulesPath).toContain("family_rules.yaml");
    expect(config.polyApiKey).toBeUndefined();
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
    expect(() => loadEnv()).toThrow("POLY_API_KEY");
  });

  it("requires POLY_API_SECRET in paper mode", () => {
    setEnvVars({
      RUNTIME_MODE: "paper",
      POLY_API_KEY: "key",
      POLY_PASSPHRASE: "pass",
    });
    expect(() => loadEnv()).toThrow("POLY_API_SECRET");
  });

  it("requires POLY_PASSPHRASE in live-lite mode", () => {
    setEnvVars({
      RUNTIME_MODE: "live-lite",
      LIVE_LITE_CONFIRM: "true",
      POLY_API_KEY: "key",
      POLY_API_SECRET: "secret",
    });
    expect(() => loadEnv()).toThrow("POLY_PASSPHRASE");
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
});
