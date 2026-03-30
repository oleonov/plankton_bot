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
import { loadEnv } from "@plankton/config";
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

  // Read desired profile from control DB to determine ledger path
  const profileRow = controlConn.db
    .prepare("SELECT desired_profile FROM runtime_control_state WHERE id = 1")
    .get() as { desired_profile: string } | undefined;
  const activeProfile = profileRow?.desired_profile ?? "simulation";
  const ledgerDbPath = controlDbPath.replace("control.db", `ledger-${activeProfile}.db`);
  const ledgerConn = bootstrapLedgerDb(ledgerDbPath);

  const ledgerPool = new LedgerPool(controlDbPath);

  // eslint-disable-next-line no-console
  console.log(`databases opened — control: ${controlDbPath}, ledger: ${ledgerDbPath} (profile: ${activeProfile})`);

  const app = await buildServer({
    config,
    controlDb: controlConn.db,
    ledgerDb: ledgerConn.db,
    ledgerPool,
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
