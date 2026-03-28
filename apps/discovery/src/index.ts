import pino from "pino";
import { bootstrapDatabase } from "@plankton/db";
import { ScanService } from "./scan-service.js";

const logger = pino({
  transport: { target: "pino-pretty", options: { colorize: true } },
});

async function main(): Promise<void> {
  const dbPath = process.env["PLANKTON_DB_PATH"] ?? process.env["DB_PATH"] ?? "data/plankton-sim.db";
  logger.info({ dbPath }, "CLI scan starting");
  const conn = bootstrapDatabase(dbPath);
  try {
    const service = new ScanService({ db: conn.db, log: logger });
    const stats = await service.run();
    logger.info(stats, "Scan complete");
  } finally {
    conn.db.close();
  }
}

main().catch((err) => {
  logger.error(err, "Scan failed");
  process.exitCode = 1;
});
