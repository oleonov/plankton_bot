import type Database from "better-sqlite3";
import type {
  DiscoveryRun,
  DiscoveryRunRepository,
  DiscoveryScanStats,
} from "@plankton/domain";

interface RunRow {
  id: number;
  trigger_type: string;
  status: string;
  requested_by: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  stats_json: string | null;
  error: string | null;
  worker_id: string | null;
}

function rowToRun(row: RunRow): DiscoveryRun {
  return {
    id: row.id,
    triggerType: row.trigger_type as DiscoveryRun["triggerType"],
    status: row.status as DiscoveryRun["status"],
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    heartbeatAt: row.heartbeat_at,
    stats: row.stats_json ? (JSON.parse(row.stats_json) as DiscoveryScanStats) : null,
    error: row.error,
    workerId: row.worker_id,
  };
}

export class SqliteDiscoveryRunRepository implements DiscoveryRunRepository {
  constructor(private readonly db: Database.Database) {}

  enqueue(triggerType: DiscoveryRun["triggerType"], requestedBy: string | null): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db
        .prepare("SELECT id FROM discovery_runs WHERE status IN ('queued', 'running')")
        .get();
      if (active) {
        this.db.exec("ROLLBACK");
        throw new Error("Active discovery run already exists");
      }
      const info = this.db
        .prepare("INSERT INTO discovery_runs (trigger_type, requested_by) VALUES (?, ?)")
        .run(triggerType, requestedBy);
      this.db.exec("COMMIT");
      return Number(info.lastInsertRowid);
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  claim(workerId: string): DiscoveryRun | null {
    return this.db.transaction(() => {
      const queued = this.db
        .prepare(
          "SELECT id FROM discovery_runs WHERE status = 'queued' ORDER BY requested_at ASC LIMIT 1",
        )
        .get() as { id: number } | undefined;
      if (!queued) return null;

      this.db
        .prepare(
          `UPDATE discovery_runs
           SET status = 'running', worker_id = ?, started_at = datetime('now'), heartbeat_at = datetime('now')
           WHERE id = ?`,
        )
        .run(workerId, queued.id);

      return rowToRun(
        this.db.prepare("SELECT * FROM discovery_runs WHERE id = ?").get(queued.id) as RunRow,
      );
    })();
  }

  heartbeat(id: number): void {
    this.db
      .prepare("UPDATE discovery_runs SET heartbeat_at = datetime('now') WHERE id = ?")
      .run(id);
  }

  succeed(id: number, stats: DiscoveryScanStats): void {
    this.db
      .prepare(
        `UPDATE discovery_runs
         SET status = 'succeeded', stats_json = ?, finished_at = datetime('now')
         WHERE id = ?`,
      )
      .run(JSON.stringify(stats), id);
  }

  fail(id: number, error: string): void {
    this.db
      .prepare(
        `UPDATE discovery_runs
         SET status = 'failed', error = ?, finished_at = datetime('now')
         WHERE id = ?`,
      )
      .run(error, id);
  }

  findActive(): DiscoveryRun | null {
    const row = this.db
      .prepare(
        "SELECT * FROM discovery_runs WHERE status IN ('queued', 'running') ORDER BY requested_at ASC LIMIT 1",
      )
      .get() as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  findLastSuccessful(): DiscoveryRun | null {
    const row = this.db
      .prepare(
        "SELECT * FROM discovery_runs WHERE status = 'succeeded' ORDER BY id DESC LIMIT 1",
      )
      .get() as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  findRecent(limit: number): DiscoveryRun[] {
    const rows = this.db
      .prepare("SELECT * FROM discovery_runs ORDER BY id DESC LIMIT ?")
      .all(limit) as RunRow[];
    return rows.map(rowToRun);
  }

  failStale(staleThresholdMs: number): number {
    const seconds = Math.floor(staleThresholdMs / 1000);
    const result = this.db
      .prepare(
        `UPDATE discovery_runs
         SET status = 'failed', error = 'stale: worker heartbeat timeout', finished_at = datetime('now')
         WHERE status = 'running' AND heartbeat_at < datetime('now', '-' || ? || ' seconds')`,
      )
      .run(seconds);
    return result.changes;
  }
}
