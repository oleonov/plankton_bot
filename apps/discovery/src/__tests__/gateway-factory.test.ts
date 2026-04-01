import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getGammaTimeoutMs, getControlDbPath, loadDiscoveryEnv } from "../gateway-factory.js";

function getRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

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
  const root = getRepoRoot();
  const testEnvPath = resolve(root, ".env.test-discovery");
  // Use a temp file to avoid polluting real .env
  // loadDiscoveryEnv reads from root .env — we create it if missing, clean up after

  it("loads vars from .env file at repo root", () => {
    const realEnvPath = resolve(root, ".env");
    const realEnvExists = existsSync(realEnvPath);
    const backupContent = realEnvExists ? undefined : null;

    // If no .env exists (CI), create a temporary one
    if (!realEnvExists) {
      writeFileSync(
        realEnvPath,
        "RUNTIME_MODE=simulation\nDB_PATH=./apps/runtime/data/plankton-sim.db\n",
      );
    }

    try {
      for (const key of ENV_KEYS) delete process.env[key];
      loadDiscoveryEnv();

      // Verify .env was actually loaded — RUNTIME_MODE must be set
      expect(process.env["RUNTIME_MODE"]).toBeDefined();
      expect(["simulation", "paper", "live-lite"]).toContain(process.env["RUNTIME_MODE"]);
    } finally {
      // Only remove if we created it
      if (backupContent === null) {
        try {
          unlinkSync(realEnvPath);
        } catch {
          /* ignore */
        }
      }
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
