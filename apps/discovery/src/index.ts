import pino from "pino";
import { bootstrapDatabase } from "@plankton/db";
import { ScanService } from "./scan-service.js";
import { loadDiscoveryEnv, getDbPath, createDiscoveryGateway } from "./gateway-factory.js";

const logger = pino({
  transport: { target: "pino-pretty", options: { colorize: true } },
});

async function main(): Promise<void> {
  loadDiscoveryEnv();
  const dbPath = getDbPath();
  logger.info({ dbPath }, "CLI scan starting");
  const conn = bootstrapDatabase(dbPath);
  try {
    const service = new ScanService({ db: conn.db, log: logger, gateway: createDiscoveryGateway() });
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
