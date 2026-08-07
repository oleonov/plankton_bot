import Database from "better-sqlite3";

/**
 * Handle to a held ledger instance lock. The lock is tied to this connection's open file
 * descriptor and releases the moment it closes, whether via {@link release} or the OS reclaiming
 * it on process exit/crash. Dropping the handle does NOT release it — see {@link held}.
 */
export interface LedgerInstanceLockHandle {
  release(): void;
}

/** Thrown when another process already holds the lock for this ledger. */
export class LedgerInstanceLockError extends Error {
  constructor(
    readonly lockDbPath: string,
    cause: unknown,
  ) {
    super(
      `failed to acquire ledger instance lock at ${lockDbPath} — likely another runtime ` +
        `process is already running against this ledger`,
    );
    this.name = "LedgerInstanceLockError";
    this.cause = cause;
  }
}

/** How long a second boot waits before giving up (r8-M2). Nothing in this window resolves the
 *  contention — the holder keeps the OS-level file lock for its entire process lifetime, not
 *  momentarily — so this only bounds how long a doomed second boot hangs before reporting. */
const LOCK_TIMEOUT_MS = 2_000;

/** Closing only ever drops a lock nobody else can use yet, and the OS reclaims the descriptor on
 *  process exit regardless — so a failing close must never be able to strand a boot-failure or
 *  shutdown path. Swallowing here keeps that guarantee in one place instead of at every caller. */
function closeQuietly(db: Database.Database | undefined): void {
  try {
    db?.close();
  } catch {
    // intentionally ignored — see above
  }
}

/** better-sqlite3 closes the underlying descriptor when a `Database` becomes unreachable, and the
 *  OS lock goes with it — verified empirically: drop the only reference, force GC, and another
 *  process takes the lock while this one still believes it owns the ledger. Leaving that to the
 *  caller makes the guarantee depend on an incidental variable staying captured somewhere, so the
 *  module that promises process-lifetime exclusion holds the strong reference itself. */
const held = new Set<Database.Database>();

/**
 * Take an exclusive, process-scoped lock on `<ledgerDbPath>.lock.db` so at most one runtime
 * instance ever runs against a given ledger at a time (r8-M2 — concurrent runtimes race the
 * merge-ledger fence and other exclusive-owner invariants).
 *
 * A SEPARATE tiny file, not the ledger DB itself: `apps/api` also opens the ledger for reads, and
 * an exclusive lock on that connection would starve it. Semantically this is "one RUNTIME per
 * ledger", not "one connection per ledger".
 *
 * `PRAGMA locking_mode = EXCLUSIVE` only takes the OS-level file lock lazily, on the connection's
 * first read/write — so a trivial upsert forces it immediately, and acquisition fails HERE, at
 * boot, instead of silently on some later real ledger write. The lock is then held for the life of
 * the process: it lives on the OS file descriptor, so a killed or crashed process releases it for
 * free — no PID file, no staleness heuristic, and no false-positive from a container where every
 * restart's first process reuses PID 1.
 *
 * No `journal_mode = WAL`: this file exists purely to be locked, never queried, so the default
 * rollback journal is simpler and leaves no `-wal`/`-shm` siblings behind.
 */
export function acquireLedgerInstanceLock(ledgerDbPath: string): LedgerInstanceLockHandle {
  const lockDbPath = `${ledgerDbPath}.lock.db`;
  let db: Database.Database | undefined;
  try {
    db = new Database(lockDbPath, { timeout: LOCK_TIMEOUT_MS });
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec(
      "CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY CHECK (id = 1), acquired_at TEXT NOT NULL)",
    );
    // Upsert on a fixed row id — keeps the file at a single row across every restart instead of
    // growing without bound, and is itself the "trivial write" that forces the OS-level lock.
    db.prepare(
      "INSERT INTO lock (id, acquired_at) VALUES (1, ?) " +
        "ON CONFLICT(id) DO UPDATE SET acquired_at = excluded.acquired_at",
    ).run(new Date().toISOString());
  } catch (err) {
    // A failure after the file opened would otherwise keep the descriptor — and any lock already
    // granted on it — alive until GC, blocking the next legitimate acquisition.
    closeQuietly(db);
    throw new LedgerInstanceLockError(lockDbPath, err);
  }
  const acquired = db;
  held.add(acquired);
  return {
    release(): void {
      held.delete(acquired);
      closeQuietly(acquired);
    },
  };
}
