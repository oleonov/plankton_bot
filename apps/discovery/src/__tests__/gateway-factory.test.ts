import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getGammaTimeoutMs, getDbPath, loadDiscoveryEnv } from "../gateway-factory.js";

const ENV_KEYS = ["GAMMA_TIMEOUT_MS", "PLANKTON_DB_PATH", "DB_PATH", "RUNTIME_MODE"] as const;

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

describe("getDbPath", () => {
  it("returns PLANKTON_DB_PATH over DB_PATH", () => {
    process.env["PLANKTON_DB_PATH"] = "/custom/plankton.db";
    process.env["DB_PATH"] = "/other/path.db";
    expect(getDbPath()).toBe("/custom/plankton.db");
  });

  it("falls back to DB_PATH when PLANKTON_DB_PATH unset", () => {
    delete process.env["PLANKTON_DB_PATH"];
    process.env["DB_PATH"] = "/from/db-path.db";
    expect(getDbPath()).toBe("/from/db-path.db");
  });

  it("returns repo-root-based default when no env", () => {
    delete process.env["PLANKTON_DB_PATH"];
    delete process.env["DB_PATH"];
    const result = getDbPath();
    expect(result).toContain("apps/runtime/data/plankton-sim.db");
    expect(result).toMatch(/^\//);
  });
});

describe("loadDiscoveryEnv", () => {
  it("reads RUNTIME_MODE from root .env and uses it for mode-specific file", () => {
    // Clear all env vars that loadDiscoveryEnv touches
    for (const key of ENV_KEYS) delete process.env[key];

    loadDiscoveryEnv();

    // Root .env defines RUNTIME_MODE=paper — verify it was picked up
    // (not defaulted to "simulation")
    expect(process.env["RUNTIME_MODE"]).toBe("paper");
    // DB_PATH should come from root .env (paper path), not .env.simulation
    expect(process.env["DB_PATH"]).toContain("paper");
  });

  it("process env takes precedence over .env files", () => {
    // Set process env before loading — should not be overwritten
    process.env["RUNTIME_MODE"] = "live-lite";
    process.env["DB_PATH"] = "/explicit/path.db";

    loadDiscoveryEnv();

    expect(process.env["RUNTIME_MODE"]).toBe("live-lite");
    expect(process.env["DB_PATH"]).toBe("/explicit/path.db");
  });
});
