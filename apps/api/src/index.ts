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
import { buildServer } from "./server.js";

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
    throw new Error(
      "PLANKTON_SESSION_SECRET must be exactly 64 hex characters (32 bytes).",
    );
  }

  if (!config.planktonAuthPassword) {
    // eslint-disable-next-line no-console
    console.log("PLANKTON_AUTH_PASSWORD not set — web login disabled, API key auth only");
  } else if (!config.planktonAuthUsername) {
    // eslint-disable-next-line no-console
    console.log("PLANKTON_AUTH_USERNAME not set — password-only login (username recommended)");
  }

  const conn = openDatabase(config.dbPath);

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
