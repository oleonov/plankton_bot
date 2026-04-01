import type Database from "better-sqlite3";

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

  startHeartbeatLoop(intervalMs: number): void {
    this.publishHeartbeat("ready_paused");
    this.heartbeatTimer = setInterval(() => {
      try {
        const state = this.db
          .prepare("SELECT runtime_status FROM runtime_control_state WHERE id = 1")
          .get() as { runtime_status: string } | undefined;
        this.publishHeartbeat(state?.runtime_status ?? "unknown");
      } catch {
        // SQLITE_BUSY is expected under contention — skip this heartbeat, retry next interval
      }
    }, intervalMs);
  }

  stopHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
