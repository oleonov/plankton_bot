/**
 * Plankton API — operator-facing REST + SSE server.
 *
 * Reads from two databases:
 *   control.db  — family catalog, rules, candidates, operator commands
 *   ledger-{profile}.db — positions, orders, fills, metrics, market data
 *
 * Does NOT import runtime modules or exchange SDK.
 */

import process from "node:process";
import { loadEnv, loadFamilyRulesYaml } from "@plankton/config";
import { bootstrapControlDb, bootstrapLedgerDb } from "@plankton/db";
import { buildServer } from "./server.js";
import { LedgerPool } from "./ledger-pool.js";

async function main(): Promise<void> {
  const config = loadEnv();

  // Validate session auth configuration
  if (config.planktonAuthPassword && !config.planktonSessionSecret) {
    throw new Error(
      "PLANKTON_SESSION_SECRET is required when PLANKTON_AUTH_PASSWORD is set. " +
        "Generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  if (config.planktonSessionSecret && !/^[0-9a-f]{64}$/i.test(config.planktonSessionSecret)) {
    throw new Error("PLANKTON_SESSION_SECRET must be exactly 64 hex characters (32 bytes).");
  }

  if (!config.planktonAuthPassword) {
    // eslint-disable-next-line no-console
    console.log("PLANKTON_AUTH_PASSWORD not set — web login disabled, API key auth only");
  } else if (!config.planktonAuthUsername) {
    // eslint-disable-next-line no-console
    console.log("PLANKTON_AUTH_USERNAME not set — password-only login (username recommended)");
  }

  // Derive control DB path from legacy dbPath
  const controlDbPath =
    process.env["CONTROL_DB_PATH"] ?? config.dbPath.replace(/[^/]+\.db$/, "control.db");
  const controlConn = bootstrapControlDb(controlDbPath);
  let defaultInitialBalanceUsdc: number | null = null;
  try {
    defaultInitialBalanceUsdc = loadFamilyRulesYaml(config.familyRulesPath).global
      .initialBalanceUsdc;
  } catch {
    // Keep null — API can still serve from profile_settings only.
  }

  // Prefer current_profile for startup-fixed ledger fallback. If runtime has not
  // published one yet, fall back to desired_profile.
  const profileRow = controlConn.db
    .prepare("SELECT desired_profile, current_profile FROM runtime_control_state WHERE id = 1")
    .get() as { desired_profile: string | null; current_profile: string | null } | undefined;
  const startupLedgerProfile =
    profileRow?.current_profile ??
    profileRow?.desired_profile ??
    config.runtimeMode ??
    "simulation";
  const ledgerDbPath = controlDbPath.replace("control.db", `ledger-${startupLedgerProfile}.db`);
  const ledgerConn = bootstrapLedgerDb(ledgerDbPath);

  const ledgerPool = new LedgerPool(controlDbPath);

  // eslint-disable-next-line no-console
  console.log(
    `databases opened — control: ${controlDbPath}, ledger: ${ledgerDbPath} ` +
      `(env: ${config.runtimeMode}, desired: ${profileRow?.desired_profile ?? "null"}, ` +
      `current: ${profileRow?.current_profile ?? "null"}, startup-ledger: ${startupLedgerProfile})`,
  );

  const app = await buildServer({
    config,
    controlDb: controlConn.db,
    ledgerDb: ledgerConn.db,
    ledgerPool,
    defaultInitialBalanceUsdc,
  });

  const port = config.planktonApiPort;

  await app.listen({ port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`plankton API listening on :${port}`);

  const shutdown = async () => {
    await app.close();
    ledgerPool.closeAll();
    ledgerConn.close();
    controlConn.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("api startup error", err);
  process.exit(1);
});
