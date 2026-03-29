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
 * Precedence (highest → lowest): process env > root .env > .env.{mode}
 * Root .env is loaded first so RUNTIME_MODE is available for mode selection.
 * Mode-specific file only fills remaining gaps.
 */
export function loadDiscoveryEnv(): void {
  const root = getRepoRoot();
  // 1. Root .env first — establishes RUNTIME_MODE and base vars (never overrides process env)
  loadDotenv({ path: join(root, ".env") });
  // 2. Read mode (now available from either process env or root .env)
  const mode = process.env["RUNTIME_MODE"] ?? "simulation";
  // 3. Mode-specific file fills remaining gaps (never overrides process env or root .env)
  loadDotenv({ path: join(root, `.env.${mode}`) });
}

export function getGammaTimeoutMs(): number {
  const raw = Number(process.env["GAMMA_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export function getDbPath(): string {
  const root = getRepoRoot();
  const raw =
    process.env["PLANKTON_DB_PATH"] ??
    process.env["DB_PATH"] ??
    "./apps/runtime/data/plankton-sim.db";
  return resolve(root, raw);
}

export function createDiscoveryGateway(): GammaMarketDiscoveryGateway {
  return new GammaMarketDiscoveryGateway({ timeoutMs: getGammaTimeoutMs() });
}
