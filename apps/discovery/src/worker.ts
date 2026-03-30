import pino from "pino";
import { randomUUID } from "node:crypto";
import { bootstrapControlDb, SqliteDiscoveryRunRepository } from "@plankton/db";
import { ScanService } from "./scan-service.js";
import { ControlEvaluator } from "./control-evaluator.js";
import { loadDiscoveryEnv, getControlDbPath, createDiscoveryGateway } from "./gateway-factory.js";

const SCHEDULE_INTERVAL_MS = 60 * 60 * 1000;
const EVAL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour, offset from scan
const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_THRESHOLD_MS = 2 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const IDLE_HEARTBEAT_MS = 30_000;

const logger = pino({
  transport: { target: "pino-pretty", options: { colorize: true } },
});
const workerId = randomUUID();

async function main(): Promise<void> {
  loadDiscoveryEnv();
  const controlDbPath = getControlDbPath();
  logger.info({ dbPath: controlDbPath, workerId }, "Discovery worker starting");
  const conn = bootstrapControlDb(controlDbPath);
  const runRepo = new SqliteDiscoveryRunRepository(conn.db);

  // Recover stale runs
  const staleCount = runRepo.failStale(STALE_THRESHOLD_MS);
  if (staleCount > 0) logger.warn({ staleCount }, "Recovered stale running jobs");

  // Initial scan if no recent success
  const lastSuccess = runRepo.findLastSuccessful();
  const needsInitial =
    !lastSuccess ||
    Date.now() - new Date(lastSuccess.finishedAt!).getTime() > SCHEDULE_INTERVAL_MS;
  if (needsInitial) {
    try {
      runRepo.enqueue("startup", "worker");
      logger.info("Enqueued initial scan");
    } catch {
      /* active run already exists */
    }
  }

  // Idle heartbeat — upsert into service_heartbeats proving worker is alive between scans
  const writeHeartbeat = (): void => {
    conn.db
      .prepare(
        `INSERT INTO service_heartbeats (service_name, instance_id, last_heartbeat_at, status_json)
         VALUES ('discovery', ?, datetime('now'), ?)
         ON CONFLICT(service_name, instance_id) DO UPDATE SET
           last_heartbeat_at = excluded.last_heartbeat_at,
           status_json = excluded.status_json`,
      )
      .run(workerId, JSON.stringify({ workerId }));
  };
  writeHeartbeat();
  const idleTimer = setInterval(writeHeartbeat, IDLE_HEARTBEAT_MS);

  // Scheduler — enqueue hourly scan
  const schedulerTimer = setInterval(() => {
    try {
      runRepo.enqueue("schedule", "worker");
      logger.info("Enqueued scheduled scan");
    } catch {
      /* active run already exists */
    }
  }, SCHEDULE_INTERVAL_MS);

  // Periodic stale check — catches runs orphaned by deploy restarts
  const staleCheckTimer = setInterval(() => {
    const recovered = runRepo.failStale(STALE_THRESHOLD_MS);
    if (recovered > 0) logger.warn({ recovered }, "Periodic stale check: recovered orphaned runs");
  }, STALE_THRESHOLD_MS); // check every 2 minutes

  // Control evaluator — scores candidates and proposes promotions
  const controlEvaluator = new ControlEvaluator({ db: conn.db, log: logger });

  const runEvaluation = (): void => {
    try {
      controlEvaluator.run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, "Control evaluation failed");
    }
  };

  // Run initial evaluation, then on a timer
  runEvaluation();
  const evalTimer = setInterval(runEvaluation, EVAL_INTERVAL_MS);

  // Poll loop
  let executing = false;
  let shuttingDown = false;

  const pollTimer = setInterval(() => {
    if (executing || shuttingDown) return;
    void executeScan();
  }, POLL_INTERVAL_MS);

  async function executeScan(): Promise<void> {
    const run = runRepo.claim(workerId);
    if (!run) return;
    executing = true;

    logger.info({ runId: run.id, trigger: run.triggerType }, "Claimed scan job");
    const hbTimer = setInterval(() => runRepo.heartbeat(run.id), HEARTBEAT_INTERVAL_MS);

    try {
      const service = new ScanService({
        db: conn.db,
        log: logger,
        gateway: createDiscoveryGateway(),
        onProgress: () => runRepo.heartbeat(run.id),
      });
      const stats = await service.run();
      runRepo.succeed(run.id, stats);
      logger.info({ runId: run.id, ...stats }, "Scan succeeded");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runRepo.fail(run.id, msg);
      logger.error({ runId: run.id, error: msg }, "Scan failed");
    } finally {
      clearInterval(hbTimer);
      executing = false;
    }
  }

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.info("Shutting down");
    shuttingDown = true;
    clearInterval(schedulerTimer);
    clearInterval(pollTimer);
    clearInterval(idleTimer);
    clearInterval(staleCheckTimer);
    clearInterval(evalTimer);

    const deadline = Date.now() + 5 * 60_000;
    while (executing && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (executing) logger.warn("Shutdown timeout — scan still running");

    conn.db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  logger.info("Worker running. Poll 5s, scan schedule 1h, eval 1h, idle heartbeat 30s.");
}

main().catch((err) => {
  logger.error(err, "Worker failed");
  process.exitCode = 1;
});
