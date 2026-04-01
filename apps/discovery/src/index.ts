import pino from "pino";
import { bootstrapControlDb } from "@plankton/db";
import { ScanService } from "./scan-service.js";
import { loadDiscoveryEnv, getControlDbPath, createDiscoveryGateway } from "./gateway-factory.js";

const logger = pino({
  transport: { target: "pino-pretty", options: { colorize: true } },
});

async function main(): Promise<void> {
  loadDiscoveryEnv();
  const controlDbPath = getControlDbPath();
  logger.info({ dbPath: controlDbPath }, "CLI scan starting");
  const conn = bootstrapControlDb(controlDbPath);
  try {
    const service = new ScanService({
      db: conn.db,
      log: logger,
      gateway: createDiscoveryGateway(),
    });
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
