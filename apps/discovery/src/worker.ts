import pino from "pino";
import { randomUUID } from "node:crypto";
import { bootstrapControlDb, SqliteDiscoveryRunRepository } from "@plankton/db";
import { ScanService } from "./scan-service.js";
import { ControlEvaluator } from "./control-evaluator.js";
import type { AutoAcceptorConfig } from "./auto-acceptor.js";
import { loadDiscoveryEnv, getControlDbPath, createDiscoveryGateway } from "./gateway-factory.js";
import {
  DISCOVERY_SCAN_INTERVAL_MS,
  PROMOTION_EVALUATION_INTERVAL_MS,
  SCORE_RECOMPUTE_FALLBACK_INTERVAL_MS,
} from "./promotion-policy.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_THRESHOLD_MS = 2 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const IDLE_HEARTBEAT_MS = 30_000;

const isDev = process.env.NODE_ENV !== "production";
const logger = pino(
  isDev ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {},
);
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
    Date.now() - new Date(lastSuccess.finishedAt!).getTime() > DISCOVERY_SCAN_INTERVAL_MS;
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
  }, DISCOVERY_SCAN_INTERVAL_MS);

  // Periodic stale check — catches runs orphaned by deploy restarts
  const staleCheckTimer = setInterval(() => {
    const recovered = runRepo.failStale(STALE_THRESHOLD_MS);
    if (recovered > 0) logger.warn({ recovered }, "Periodic stale check: recovered orphaned runs");
  }, STALE_THRESHOLD_MS); // check every 2 minutes

  // Control evaluator — scores candidates and proposes promotions
  const autoAcceptorConfig: AutoAcceptorConfig = {
    apiBaseUrl: process.env.PLANKTON_API_URL ?? "http://plankton-api:3100",
    apiKey: process.env.PLANKTON_API_KEY ?? "",
    enabled: process.env.AUTO_APPROVE_ENABLED === "true",
  };
  const controlEvaluator = new ControlEvaluator({
    db: conn.db,
    log: logger,
    autoAcceptorConfig,
  });

  const runRescore = (trigger: string): void => {
    controlEvaluator.recomputeScores().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg, trigger }, "Score recompute failed");
    });
  };
  const runPromotionCheck = (): void => {
    controlEvaluator.evaluatePromotions().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, "Promotion evaluation failed");
    });
  };
  const runFallbackIfStale = (): void => {
    const lastCompleted = controlEvaluator.getLastRescoreCompletedAt();
    const sinceMs = Date.now() - lastCompleted;
    if (sinceMs >= SCORE_RECOMPUTE_FALLBACK_INTERVAL_MS) {
      logger.warn({ sinceLastRescoreMs: sinceMs }, "rescore stale, triggering fallback");
      runRescore("fallback-stale");
    }
  };

  // Initial startup pass: rescore FIRST, then promotion check. Must be
  // sequential-awaited, not fire-and-forget, because evaluatePromotions
  // invokes autoAcceptAndPromote which reads family_candidates.gate_recommendation
  // directly (see auto-acceptor.ts:69-82). If the rescore were launched
  // fire-and-forget and later grew an await point (e.g. chunked processing),
  // the promotion check would race against it and auto-accept would see
  // stale gate values. Today recomputeScores happens to be fully synchronous
  // so the ordering works by accident; this await makes the invariant explicit.
  //
  // A startup rescore FAILURE should not block the worker from running
  // promotion checks (they still work off live scorecards), so errors
  // are logged and swallowed.
  try {
    await controlEvaluator.recomputeScores();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg, trigger: "startup" }, "Startup rescore failed, continuing");
  }
  runPromotionCheck();

  // Promotion check stays at 5 min — depends on scorecards which are
  // written by the runtime process on its own cadence.
  const promotionTimer = setInterval(runPromotionCheck, PROMOTION_EVALUATION_INTERVAL_MS);

  // Fallback poller: checks every 5 min whether a rescore has happened
  // within the fallback interval. Normal flow: executeScan() calls
  // runRescore("scan-complete") on success, which updates
  // controlEvaluator.lastRescoreCompletedAt and this poller becomes a
  // no-op. The poller only fires a rescore when scans have been failing
  // or skipped long enough that scores would otherwise grow stale.
  //
  // Critical: the getter returns the timestamp of the last ACTUAL
  // recompute completion, not the last runRescore() call. A rescore
  // that was dropped because the `rescoring` lock was held does NOT
  // update lastRescoreCompletedAt, so the fallback poller still catches
  // it on the next tick if the in-flight rescore eventually fails.
  const rescoreFallbackTimer = setInterval(runFallbackIfStale, PROMOTION_EVALUATION_INTERVAL_MS);

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
      // Scan refreshed observation data; recompute candidate scores.
      runRescore("scan-complete");
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
    clearInterval(promotionTimer);
    clearInterval(rescoreFallbackTimer);

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

  logger.info(
    "Worker running. Poll 5s, scan schedule 1h, promotion check 5m, score recompute on-scan + 1h fallback, idle heartbeat 30s.",
  );
}

main().catch((err) => {
  logger.error(err, "Worker failed");
  process.exitCode = 1;
});
