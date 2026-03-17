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
