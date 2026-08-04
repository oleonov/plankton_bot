import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOTSTRAP_BUSY_TIMEOUT_MS,
  RUNTIME_BUSY_TIMEOUT_MS,
  SHUTDOWN_BUSY_TIMEOUT_MS,
  openDatabase,
  setRuntimeBusyTimeout,
  withShutdownBusyTimeout,
  disableAutoCheckpoint,
  type DbConnection,
} from "../connection.js";

function readBusyTimeout(db: import("better-sqlite3").Database): number {
  const row = db.pragma("busy_timeout") as Array<{ timeout: number }>;
  return row[0]!.timeout;
}

describe("openDatabase busy_timeout scoping", () => {
  it("defaults to runtime budget — does not stall the event loop for 10 minutes", () => {
    const conn = openDatabase(":memory:");
    expect(readBusyTimeout(conn.db)).toBe(RUNTIME_BUSY_TIMEOUT_MS);
    expect(RUNTIME_BUSY_TIMEOUT_MS).toBe(30_000);
    conn.close();
  });

  it("honors explicit bootstrap budget for the DDL window", () => {
    const conn = openDatabase(":memory:", { busyTimeoutMs: BOOTSTRAP_BUSY_TIMEOUT_MS });
    expect(readBusyTimeout(conn.db)).toBe(BOOTSTRAP_BUSY_TIMEOUT_MS);
    conn.close();
  });

  it("setRuntimeBusyTimeout drops a bootstrap connection back to the runtime budget", () => {
    const conn = openDatabase(":memory:", { busyTimeoutMs: BOOTSTRAP_BUSY_TIMEOUT_MS });
    expect(readBusyTimeout(conn.db)).toBe(BOOTSTRAP_BUSY_TIMEOUT_MS);
    setRuntimeBusyTimeout(conn);
    expect(readBusyTimeout(conn.db)).toBe(RUNTIME_BUSY_TIMEOUT_MS);
    conn.close();
  });

  it("withShutdownBusyTimeout applies the teardown budget to the wrapped write only", () => {
    // better-sqlite3 is synchronous: a teardown ledger write blocks INSIDE the native call for the
    // whole busy_timeout, so at the runtime budget one write stuck behind the retention checkpoint's
    // writer lock spends 30s of the grace period on a single telemetry row.
    const conn = openDatabase(":memory:");
    let insideTimeout = -1;
    withShutdownBusyTimeout(conn.db, () => {
      insideTimeout = readBusyTimeout(conn.db);
    });
    expect(insideTimeout).toBe(SHUTDOWN_BUSY_TIMEOUT_MS);
    // Cited by name in docker-compose.yml's stop_grace_period arithmetic.
    expect(SHUTDOWN_BUSY_TIMEOUT_MS).toBe(2_000);
    conn.close();
  });

  it("withShutdownBusyTimeout restores the connection so critical writes keep the full budget", () => {
    // The shared ledger connection also carries execution's drain. An order the exchange already
    // ACCEPTED must be persisted at the runtime budget — at 2s a five-second lock wave orphans it on
    // the exchange with no local row, and startup adoption fail-closes on it at the next boot.
    const conn = openDatabase(":memory:");
    withShutdownBusyTimeout(conn.db, () => undefined);
    expect(readBusyTimeout(conn.db)).toBe(RUNTIME_BUSY_TIMEOUT_MS);
    conn.close();
  });

  it("withShutdownBusyTimeout restores the previous budget even when the write throws", () => {
    const conn = openDatabase(":memory:");
    expect(() =>
      withShutdownBusyTimeout(conn.db, () => {
        throw new Error("SQLITE_BUSY");
      }),
    ).toThrow("SQLITE_BUSY");
    expect(readBusyTimeout(conn.db)).toBe(RUNTIME_BUSY_TIMEOUT_MS);
    conn.close();
  });

  it("withShutdownBusyTimeout restores the bootstrap budget, not a hardcoded runtime one", () => {
    // Bootstrap runs DDL on the same connection at 10 minutes; restoring a constant would silently
    // re-scope that window to 30s mid-migration.
    const conn = openDatabase(":memory:", { busyTimeoutMs: BOOTSTRAP_BUSY_TIMEOUT_MS });
    withShutdownBusyTimeout(conn.db, () => undefined);
    expect(readBusyTimeout(conn.db)).toBe(BOOTSTRAP_BUSY_TIMEOUT_MS);
    conn.close();
  });
});

describe("WAL auto-checkpoint scoping", () => {
  // On a REAL file, never `:memory:`. An in-memory database silently ignores `journal_mode = WAL`
  // and stays on `memory`, so `wal_autocheckpoint` there is a settable number attached to nothing:
  // the same reads pass even if `openDatabase` never entered WAL mode at all. The runtime's whole
  // shutdown-budget argument rests on what this pragma DOES, so assert the behaviour — how much WAL
  // a fixed write load leaves behind, and whether anything was copied into the main file.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "krabs-wal-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** ~16 MiB of payload — several times the 1000-page (~4 MiB) auto-checkpoint threshold. */
  function writeLoad(conn: DbConnection): void {
    conn.db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)");
    const insert = conn.db.prepare("INSERT INTO t (blob) VALUES (?)");
    const payload = "x".repeat(4_000);
    for (let i = 0; i < 4_000; i++) insert.run(payload);
  }

  const MIB = 1024 * 1024;

  it("openDatabase keeps the auto-checkpoint ON — it is what bounds the WAL in steady state", () => {
    // Turning it off outside teardown is what let the production WAL reach 15.7 GB and pause the bot
    // on the db-size guard. The commits themselves are the safety net whenever the retention
    // worker's explicit checkpoint is failing, so steady state must keep paying for it.
    const dbPath = join(dir, "on.db");
    const conn = openDatabase(dbPath);
    expect(conn.db.pragma("journal_mode", { simple: true })).toBe("wal");

    writeLoad(conn);

    expect(statSync(`${dbPath}-wal`).size).toBeLessThan(8 * MIB);
    expect(statSync(dbPath).size).toBeGreaterThan(8 * MIB);
    conn.close();
  });

  it("disableAutoCheckpoint keeps the committing thread out of the checkpoint entirely", () => {
    // The implicit PASSIVE checkpoint runs SYNCHRONOUSLY on the committing thread and copies the
    // whole WAL backlog. `busy_timeout` does not bound it — it is I/O, not lock contention — and the
    // JS shutdown ceiling cannot fire while a native call runs, so on a multi-GB WAL one teardown
    // telemetry commit outlasts the entire grace period. Nothing reaching the main file is the
    // proof: no commit here copied a single page. The unbounded WAL that buys is affordable only for
    // the seconds a shutdown lasts, which is why this stays off the steady-state path.
    const dbPath = join(dir, "off.db");
    const conn = openDatabase(dbPath);
    disableAutoCheckpoint(conn.db);

    writeLoad(conn);

    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(16 * MIB);
    expect(statSync(dbPath).size).toBeLessThan(MIB);
    conn.close();
  });
});
