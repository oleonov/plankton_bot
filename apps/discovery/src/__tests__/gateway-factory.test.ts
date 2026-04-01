import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getGammaTimeoutMs, getControlDbPath, loadDiscoveryEnv } from "../gateway-factory.js";

const ENV_KEYS = ["GAMMA_TIMEOUT_MS", "CONTROL_DB_PATH", "DB_PATH", "RUNTIME_MODE"] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
});

describe("getGammaTimeoutMs", () => {
  it("returns 60000 by default", () => {
    delete process.env["GAMMA_TIMEOUT_MS"];
    expect(getGammaTimeoutMs()).toBe(60_000);
  });

  it("reads GAMMA_TIMEOUT_MS env", () => {
    process.env["GAMMA_TIMEOUT_MS"] = "120000";
    expect(getGammaTimeoutMs()).toBe(120_000);
  });

  it("rejects negative/zero/NaN", () => {
    process.env["GAMMA_TIMEOUT_MS"] = "-1";
    expect(getGammaTimeoutMs()).toBe(60_000);
    process.env["GAMMA_TIMEOUT_MS"] = "0";
    expect(getGammaTimeoutMs()).toBe(60_000);
    process.env["GAMMA_TIMEOUT_MS"] = "abc";
    expect(getGammaTimeoutMs()).toBe(60_000);
  });
});

describe("getControlDbPath", () => {
  it("reads CONTROL_DB_PATH env", () => {
    process.env["CONTROL_DB_PATH"] = "/custom/control.db";
    expect(getControlDbPath()).toBe("/custom/control.db");
  });

  it("returns repo-root-based default when no env", () => {
    delete process.env["CONTROL_DB_PATH"];
    const result = getControlDbPath();
    expect(result).toContain("apps/runtime/data/control.db");
    expect(result).toMatch(/^\//);
  });
});

describe("loadDiscoveryEnv", () => {
  it("loads vars from root .env if present, does not crash if absent", () => {
    for (const key of ENV_KEYS) delete process.env[key];

    // Should not throw regardless of whether .env exists (e.g. CI)
    expect(() => loadDiscoveryEnv()).not.toThrow();

    const mode = process.env["RUNTIME_MODE"];
    if (mode) {
      expect(["simulation", "paper", "live-lite"]).toContain(mode);
    }
  });

  it("process env takes precedence over .env files", () => {
    process.env["RUNTIME_MODE"] = "live-lite";
    process.env["DB_PATH"] = "/explicit/path.db";

    loadDiscoveryEnv();

    expect(process.env["RUNTIME_MODE"]).toBe("live-lite");
    expect(process.env["DB_PATH"]).toBe("/explicit/path.db");
  });
});
