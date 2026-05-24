import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { RuntimeControl, RuntimeModule } from "@krabs/domain";
import type { Logger } from "../../logger.js";

/**
 * Safety net for the v063 ledger disk-fill failure mode. Retention bounds
 * steady-state growth, but a runaway producer (e.g. the same-price-cooldown
 * busy-loop, see krabs_russia_ticker_rate_investigation_2026-05-24.md) can
 * still outrun the 5-min retention sweep. This guard polls the ledger file
 * size and, once it crosses a hard ceiling, pauses the bot via the normal
 * operator-pause path. There is NO automatic resume: an operator must act
 * (shrink the DB, then resume) so the breach can never silently recur.
 */
export interface DbSizeGuardConfig {
  enabled: boolean;
  thresholdBytes: number;
  checkIntervalMs: number;
}

const GIB = 1024 * 1024 * 1024;

export const DEFAULT_DB_SIZE_GUARD_CONFIG: DbSizeGuardConfig = {
  enabled: true,
  // 30 GB on the ~100 GB ledger disk — well below the ~84 GB disk-full crash
  // observed in v062/v063, with headroom for the operator DB-copy procedure.
  thresholdBytes: 30 * GIB,
  checkIntervalMs: 60_000,
};

export interface DbSizeGuardModuleDeps {
  /** Path to the ledger DB file; `-wal`/`-shm` siblings are summed in too. */
  dbPath: string;
  log: Logger;
  /** Operator-pause mechanism (same path as the API /actions/pause command). */
  pause: (reason: string) => void;
  config?: Partial<DbSizeGuardConfig>;
  /** Optional — used only for the best-effort top-tables-by-rows diagnostic. */
  db?: Database.Database;
  /** When paused (by this guard or an operator) the guard stays quiet. */
  runtimeControl?: RuntimeControl;
  /** Increments the `db_size_guard_triggered_total` counter. */
  recordTrigger?: (sizeBytes: number) => void;
  /** Override for tests; defaults to summing the on-disk DB files. */
  measureSizeBytes?: (dbPath: string) => number;
}

export interface DbSizeGuardResult {
  ranAt: string;
  sizeBytes: number;
  thresholdBytes: number;
  overThreshold: boolean;
  triggered: boolean;
}

interface TableRowCount {
  table: string;
  approxRows: number;
}

function formatGb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

function defaultMeasureSizeBytes(dbPath: string): number {
  let total = 0;
  // WAL-mode disk footprint = main + write-ahead log + shared-memory index.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(`${dbPath}${suffix}`).size;
    } catch {
      // Sibling may not exist (e.g. checkpointed away) — skip it.
    }
  }
  return total;
}

export class DbSizeGuardModule implements RuntimeModule {
  private readonly config: DbSizeGuardConfig;
  private readonly log: Logger;
  private readonly measureSizeBytes: (dbPath: string) => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSizeBytes = 0;
  private lastRunAt: string | null = null;
  // Fallback de-dupe for the (production never hits this) no-runtimeControl
  // case: prevents re-pausing every interval while still over threshold.
  private latched = false;

  constructor(private readonly deps: DbSizeGuardModuleDeps) {
    this.config = { ...DEFAULT_DB_SIZE_GUARD_CONFIG, ...(deps.config ?? {}) };
    this.measureSizeBytes = deps.measureSizeBytes ?? defaultMeasureSizeBytes;
    this.log = deps.log.child({ module: "db-size-guard" });
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.log.info("db size guard disabled");
      return;
    }
    this.runOnce();
    this.timer = setInterval(() => {
      try {
        this.runOnce();
      } catch (err) {
        this.log.warn({ err }, "db size guard check failed");
      }
    }, this.config.checkIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.log.info(
      { thresholdBytes: this.config.thresholdBytes, checkIntervalMs: this.config.checkIntervalMs },
      "db size guard started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info("db size guard stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: !this.config.enabled || this.timer !== null,
      detail: this.lastRunAt
        ? `lastRunAt=${this.lastRunAt} size=${formatGb(this.lastSizeBytes)}`
        : "not run yet",
    };
  }

  runOnce(nowMs = Date.now()): DbSizeGuardResult {
    const ranAt = new Date(nowMs).toISOString();
    this.lastRunAt = ranAt;
    const base = { ranAt, thresholdBytes: this.config.thresholdBytes };

    if (!this.config.enabled) {
      return { ...base, sizeBytes: 0, overThreshold: false, triggered: false };
    }

    const sizeBytes = this.measureSizeBytes(this.deps.dbPath);
    this.lastSizeBytes = sizeBytes;

    if (sizeBytes <= this.config.thresholdBytes) {
      // Re-arm so a future breach (e.g. after an operator resume) fires again.
      this.latched = false;
      this.log.debug({ sizeBytes, thresholdBytes: this.config.thresholdBytes }, "db size guard ok");
      return { ...base, sizeBytes, overThreshold: false, triggered: false };
    }

    // Over threshold. Stay quiet while already paused (by us or an operator),
    // so the guard pauses + logs exactly once per breach episode.
    const alreadyPaused = this.deps.runtimeControl?.isPaused() ?? this.latched;
    if (alreadyPaused) {
      return { ...base, sizeBytes, overThreshold: true, triggered: false };
    }
    this.latched = true;

    const topTables = this.topTablesByRows();
    this.log.error(
      {
        sizeBytes,
        thresholdBytes: this.config.thresholdBytes,
        sizeGb: formatGb(sizeBytes),
        thresholdGb: formatGb(this.config.thresholdBytes),
        topTables,
      },
      `DB size guard triggered: ${formatGb(sizeBytes)} exceeds threshold ` +
        `${formatGb(this.config.thresholdBytes)}. Bot paused. Operator action required.`,
    );
    this.deps.recordTrigger?.(sizeBytes);
    this.deps.pause(
      `db-size-guard: ledger ${formatGb(sizeBytes)} exceeds ${formatGb(this.config.thresholdBytes)}`,
    );
    return { ...base, sizeBytes, overThreshold: true, triggered: true };
  }

  /**
   * Best-effort "which table is the offender" diagnostic. Uses `MAX(rowid)`
   * (a single B-tree edge read, O(log n)) instead of `COUNT(*)` — a full scan
   * over a 27 M-row table on an 84 GB DB takes minutes and would stall the
   * synchronous better-sqlite3 thread. The count is approximate (deletes leave
   * rowid gaps) and purely informational, so any failure degrades to `[]`.
   */
  private topTablesByRows(limit = 5): TableRowCount[] {
    const db = this.deps.db;
    if (!db) return [];
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      const counts: TableRowCount[] = tables.map(({ name }) => {
        try {
          const row = db.prepare(`SELECT MAX(rowid) AS n FROM "${name}"`).get() as
            | { n: number | null }
            | undefined;
          return { table: name, approxRows: row?.n ?? 0 };
        } catch {
          return { table: name, approxRows: 0 };
        }
      });
      return counts.sort((a, b) => b.approxRows - a.approxRows).slice(0, limit);
    } catch {
      return [];
    }
  }
}
