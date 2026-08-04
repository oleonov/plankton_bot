import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase, type DbConnection } from "../connection.js";
import { runMigrations } from "../migrations/runner.js";

/**
 * Two bootstraps racing on the same ledger — the runtime and the API start together, so this is the
 * normal deploy, not an edge case.
 *
 * `safe_add_column` is a check-then-ALTER macro, not atomic `IF NOT EXISTS` DDL, so the whole
 * migration must be indivisible against every other connection. These tests pin both halves of what
 * makes that true: `BEGIN IMMEDIATE` (the writer lock is held from the start, before the PRAGMA
 * read) and the marker re-read INSIDE that lock (a loser that waited on the lock must SKIP the
 * body, not re-run it — the last test uses a raw, non-idempotent `ALTER` because an idempotent
 * `safe_add_column` body cannot tell the two apart).
 */

const MIGRATION = "010_add_column.sql";
const RAW_MIGRATION = "020_raw_alter.sql";

let tmpDir: string;
let migrationsDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-migrate-race-"));
  migrationsDir = path.join(tmpDir, "migrations");
  mkdirSync(migrationsDir);
  dbPath = path.join(tmpDir, "race.db");
  // The trailing CREATE keeps the post-substitution SQL non-empty, exactly like a real migration:
  // `safe_add_column` lines are stripped out of the string before it reaches db.exec.
  writeFileSync(
    path.join(migrationsDir, MIGRATION),
    "SELECT safe_add_column('race_target', 'added_col', 'TEXT');\n" +
      "CREATE TABLE IF NOT EXISTS race_marker (id INTEGER PRIMARY KEY);\n",
  );
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function openLedger(busyTimeoutMs?: number): DbConnection {
  return openDatabase(dbPath, busyTimeoutMs === undefined ? {} : { busyTimeoutMs });
}

function columnCount(conn: DbConnection, table: string, column: string): number {
  const columns = conn.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.filter((c) => c.name === column).length;
}

/**
 * Models the loser having read `applied` (once, before the loop) while the winner's transaction was
 * still open. Returns the original `prepare` so the caller can restore it.
 *
 * Deliberately narrow: it intercepts only the bulk `applied` read, NOT the per-file marker re-read
 * the runner does inside its transaction — stubbing that one out would defeat the very guard these
 * tests exist to pin.
 */
function stubEmptyAppliedSet(conn: DbConnection): DbConnection["db"]["prepare"] {
  const originalPrepare = conn.db.prepare.bind(conn.db);
  conn.db.prepare = ((sql: string) => {
    if (sql.startsWith("SELECT name FROM schema_migrations")) {
      return { all: () => [] } as unknown as ReturnType<typeof originalPrepare>;
    }
    return originalPrepare(sql);
  }) as typeof conn.db.prepare;
  return originalPrepare;
}

function appliedMigrations(conn: DbConnection): string[] {
  return (
    conn.db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

describe("runMigrations under a concurrent bootstrap", () => {
  it("holds the writer lock across the check-then-ALTER, so a racing bootstrap cannot interleave", () => {
    const runner = openLedger();
    // busy_timeout 0: the racer must report the contention instead of silently waiting it out.
    const racer = openLedger(0);
    runner.db.exec("CREATE TABLE race_target (id INTEGER PRIMARY KEY)");

    // The interleave point the DEFERRED version loses: after `PRAGMA table_info` has opened this
    // transaction's read snapshot, before its own ALTER runs. Under DEFERRED the racer commits here
    // and the runner's write upgrade then fails on a stale snapshot (SQLITE_BUSY_SNAPSHOT is NOT
    // retried by busy_timeout) or trips "duplicate column name" — either way the bootstrap crashes.
    let interleaveReached = false;
    let racerError = "";
    const originalExec = runner.db.exec.bind(runner.db);
    runner.db.exec = ((sql: string) => {
      if (!interleaveReached && sql.trimStart().startsWith("ALTER TABLE")) {
        interleaveReached = true;
        try {
          racer.db.exec("ALTER TABLE race_target ADD COLUMN added_col TEXT");
        } catch (e) {
          racerError = String(e);
        }
      }
      return originalExec(sql);
    }) as typeof runner.db.exec;

    try {
      expect(() => runMigrations(runner.db, migrationsDir)).not.toThrow();

      // Guards the guard: without this the test would still pass if the ALTER were never reached.
      expect(interleaveReached).toBe(true);
      // Serialized out by the lock IMMEDIATE took up front — it never got to commit into the gap.
      expect(racerError).toMatch(/lock|busy/i);
      expect(columnCount(runner, "race_target", "added_col")).toBe(1);
      expect(appliedMigrations(runner)).toEqual([MIGRATION]);
    } finally {
      runner.db.exec = originalExec;
      racer.close();
      runner.close();
    }
  });

  it("tolerates a winner that committed the same migration after this process read its applied set", () => {
    const winner = openLedger();
    winner.db.exec("CREATE TABLE race_target (id INTEGER PRIMARY KEY)");
    runMigrations(winner.db, migrationsDir);

    const loser = openLedger();
    const originalPrepare = stubEmptyAppliedSet(loser);

    try {
      expect(() => runMigrations(loser.db, migrationsDir)).not.toThrow();

      // The column is added once, not twice, and the marker stays a single row.
      expect(columnCount(loser, "race_target", "added_col")).toBe(1);
      // Asserted on the winner: the loser's `prepare` is still stubbed inside this block.
      expect(appliedMigrations(winner)).toEqual([MIGRATION]);
    } finally {
      loser.db.prepare = originalPrepare;
      loser.close();
      winner.close();
    }
  });

  it("skips a migration body another bootstrap already committed, even when the body is not idempotent", () => {
    // The `safe_add_column` migration above cannot expose this: re-running its body is a no-op by
    // construction, so serializing the two runs looks identical to skipping the second. A RAW
    // `ALTER TABLE` — the shape of migrations-control/038_execution_policy.sql — is where the
    // difference shows: the loser takes the IMMEDIATE lock the winner released, and without the
    // marker re-read inside that lock it executes the body and dies on "duplicate column name",
    // never reaching the marker insert.
    const rawDir = path.join(tmpDir, "migrations-raw");
    mkdirSync(rawDir);
    writeFileSync(
      path.join(rawDir, RAW_MIGRATION),
      "ALTER TABLE race_target ADD COLUMN raw_col TEXT;\n",
    );

    const winner = openLedger();
    winner.db.exec("CREATE TABLE race_target (id INTEGER PRIMARY KEY)");
    runMigrations(winner.db, rawDir);

    const loser = openLedger();
    const originalPrepare = stubEmptyAppliedSet(loser);

    try {
      expect(() => runMigrations(loser.db, rawDir)).not.toThrow();

      expect(columnCount(loser, "race_target", "raw_col")).toBe(1);
      expect(appliedMigrations(winner)).toEqual([RAW_MIGRATION]);
    } finally {
      loser.db.prepare = originalPrepare;
      loser.close();
      winner.close();
    }
  });
});
