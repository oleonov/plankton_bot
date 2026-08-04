import type Database from "better-sqlite3";
import type { TimerRegistry } from "./periodic-timers.js";

export interface RuntimeStatePublisherConfig {
  profile: string;
  instanceId: string;
  runId: string;
  /** Callback to get execution queue pending count for drain detection. */
  getExecutionPendingCount?: () => number;
}

export class RuntimeStatePublisher {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly config: RuntimeStatePublisherConfig,
  ) {}

  publishStartup(): void {
    this.db
      .prepare(
        `UPDATE runtime_control_state SET
        current_profile = ?, current_run_id = ?, current_instance_id = ?,
        runtime_status = 'ready_paused', paused = 1, updated_at = datetime('now')
      WHERE id = 1`,
      )
      .run(this.config.profile, this.config.runId, this.config.instanceId);
  }

  publishRunning(): void {
    this.db
      .prepare(
        "UPDATE runtime_control_state SET runtime_status = 'running', paused = 0, updated_at = datetime('now') WHERE id = 1",
      )
      .run();
  }

  publishPaused(): void {
    this.db
      .prepare(
        "UPDATE runtime_control_state SET runtime_status = 'ready_paused', paused = 1, updated_at = datetime('now') WHERE id = 1",
      )
      .run();
  }

  publishShutdown(): void {
    this.db
      .prepare(
        `UPDATE runtime_control_state SET
          runtime_status = 'stopped', current_run_id = NULL, current_instance_id = NULL,
          updated_at = datetime('now')
        WHERE id = 1`,
      )
      .run();
  }

  publishFailed(): void {
    this.db
      .prepare(
        `UPDATE runtime_control_state SET
          runtime_status = 'failed', updated_at = datetime('now')
        WHERE id = 1`,
      )
      .run();
  }

  publishHeartbeat(runtimeStatus: string): void {
    const executionPending = this.config.getExecutionPendingCount?.() ?? 0;
    this.db
      .prepare(
        `INSERT INTO service_heartbeats (service_name, instance_id, profile, run_id, last_heartbeat_at, status_json)
       VALUES ('runtime', ?, ?, ?, datetime('now'), ?)
       ON CONFLICT(service_name, instance_id) DO UPDATE SET
         last_heartbeat_at = excluded.last_heartbeat_at,
         status_json = excluded.status_json`,
      )
      .run(
        this.config.instanceId,
        this.config.profile,
        this.config.runId,
        JSON.stringify({
          status: runtimeStatus,
          executionQueueSize: executionPending,
          inFlightTasks: executionPending,
        }),
      );
  }

  /**
   * `timers` rather than a bare `setInterval`: both halves of this tick touch the control DB and
   * rethrow everything that is not `SQLITE_BUSY` — `SQLITE_FULL` under disk pressure, or a closed
   * connection during teardown. With no handler above the interval that escape terminates Node, and
   * at 15 s it fires ~9 times across the supervisor wait, so it would land squarely in the window
   * where the final flush, the shutdown publish and `process.exit(0)` have not run yet. Registering
   * it means `stopAll()` cancels it BEFORE that wait instead of `stopHeartbeatLoop()` after it.
   */
  startHeartbeatLoop(intervalMs: number, timers: TimerRegistry): void {
    // First heartbeat is best-effort — SQLITE_BUSY at startup is not fatal
    this.tryHeartbeat("ready_paused");
    this.heartbeatTimer = timers.every("runtime_heartbeat", intervalMs, () => {
      const state = this.tryQuery<{ runtime_status: string }>(
        "SELECT runtime_status FROM runtime_control_state WHERE id = 1",
      );
      this.tryHeartbeat(state?.runtime_status ?? "unknown");
    });
  }

  /** Attempt a heartbeat write, swallowing only SQLITE_BUSY. */
  private tryHeartbeat(status: string): void {
    try {
      this.publishHeartbeat(status);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as { code: string }).code === "SQLITE_BUSY"
      ) {
        return; // contention — skip, retry next interval
      }
      throw err; // unexpected error — propagate
    }
  }

  /** Attempt a read query, returning null on SQLITE_BUSY. */
  private tryQuery<T>(sql: string): T | null {
    try {
      return (this.db.prepare(sql).get() as T) ?? null;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as { code: string }).code === "SQLITE_BUSY"
      ) {
        return null;
      }
      throw err;
    }
  }

  stopHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
