/**
 * Plankton API — operator-facing REST + SSE server.
 *
 * Reads runtime state from shared SQLite database.
 * Writes operator commands via operator_commands table.
 * Does NOT import runtime modules or exchange SDK.
 */

import process from "node:process";
import { loadEnv } from "@plankton/config";
import { openDatabase } from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import { buildServer } from "./server.js";

const LATEST_MIGRATION = "006_effective_mode.sql";

async function waitForDatabase(
  dbPath: string,
  maxRetries = 10,
  delayMs = 2000,
): Promise<DbConnection> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let conn: DbConnection | undefined;
    try {
      conn = openDatabase(dbPath);
      const row = conn.db
        .prepare("SELECT name FROM schema_migrations WHERE name = ?")
        .get(LATEST_MIGRATION) as { name: string } | undefined;
      if (!row) throw new Error(`migration ${LATEST_MIGRATION} not yet applied`);
      return conn;
    } catch (err) {
      conn?.close();
      if (attempt === maxRetries) throw err;
      // eslint-disable-next-line no-console
      console.log(
        `database not ready (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms...`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("unreachable");
}

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

  const conn = await waitForDatabase(config.dbPath);

  const app = await buildServer({ config, conn });

  const port = config.planktonApiPort;

  await app.listen({ port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`plankton API listening on :${port}`);

  const shutdown = async () => {
    await app.close();
    conn.close();
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
