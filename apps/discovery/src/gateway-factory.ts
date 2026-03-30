import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { GammaMarketDiscoveryGateway } from "@plankton/exchange";

const DEFAULT_TIMEOUT_MS = 60_000;

export function getRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

/**
 * Load .env files from repo root. Safe to call multiple times.
 *
 * Discovery only needs CONTROL_DB_PATH and GAMMA_TIMEOUT_MS.
 * Root .env is loaded for base vars. No mode-specific file is needed
 * since the runtime mode lives in control.db, not in env vars.
 */
export function loadDiscoveryEnv(): void {
  const root = getRepoRoot();
  loadDotenv({ path: join(root, ".env") });
}

export function getGammaTimeoutMs(): number {
  const raw = Number(process.env["GAMMA_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export function getControlDbPath(): string {
  const root = getRepoRoot();
  const raw =
    process.env["CONTROL_DB_PATH"] ??
    "./apps/runtime/data/control.db";
  return resolve(root, raw);
}

export function createDiscoveryGateway(): GammaMarketDiscoveryGateway {
  return new GammaMarketDiscoveryGateway({ timeoutMs: getGammaTimeoutMs() });
}
