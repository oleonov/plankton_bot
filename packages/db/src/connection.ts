import Database from "better-sqlite3";

export interface DbConnection {
  db: Database.Database;
  close(): void;
}

export interface OpenDatabaseOptions {
  /**
   * SQLite `busy_timeout` in ms. Default 30s — long enough to ride out a
   * transient writer wave, short enough that a stuck write lock surfaces as a
   * timeout error instead of stalling the Node event loop for ten minutes.
   * Bootstrap raises this to {@link BOOTSTRAP_BUSY_TIMEOUT_MS} for the
   * duration of DDL, then drops it back via {@link setRuntimeBusyTimeout}.
   */
  busyTimeoutMs?: number;
}

/** Default runtime/API busy_timeout — short enough not to stall the event loop. */
export const RUNTIME_BUSY_TIMEOUT_MS = 30_000;

/**
 * Bootstrap DDL on multi-GB ledgers can take minutes (CREATE INDEX, schema
 * repair, WAL checkpoint). Two processes contend for the write lock at start;
 * the loser must wait, not crash. 10 min is "patience exceeded → real bug".
 * Lifted only for the bootstrap window, never for steady-state queries.
 */
export const BOOTSTRAP_BUSY_TIMEOUT_MS = 600_000;

/**
 * busy_timeout for a single teardown TELEMETRY write — see {@link withShutdownBusyTimeout}.
 *
 * Two seconds is "let a normal write wave finish" and nothing more. It is a term of the shutdown
 * budget in `docker-compose.yml`'s `stop_grace_period`; raising it means redoing that arithmetic.
 */
export const SHUTDOWN_BUSY_TIMEOUT_MS = 2_000;

/**
 * Run ONE teardown telemetry write under a short busy_timeout, then restore the connection's own.
 *
 * better-sqlite3 is synchronous: a final ledger write blocks INSIDE a native call for the whole
 * busy_timeout when someone else holds the write lock, freezing the event loop with it. The
 * runtime's own retention checkpoint is exactly such a holder — its worker takes the writer lock and
 * may wait a full minute for a reader — so one final metric write can burn 30 s of a 60 s grace
 * period on its own, and the databases are never closed at all.
 *
 * The bound is per-WRITE, never per-connection, and that distinction is the whole point. Lowering
 * the shared connection for the duration of the shutdown also lowers it for the writes execution is
 * still draining: an order the exchange has already ACCEPTED must be persisted or the position is
 * invisible to us, and startup adoption fail-closes on it at the next boot. Trading state gets the
 * full runtime timeout; telemetry — where a lost row costs one row and a lost shutdown costs the
 * whole close — gets two seconds.
 *
 * The previous value is read back rather than assumed: bootstrap runs at
 * {@link BOOTSTRAP_BUSY_TIMEOUT_MS} on the same connection, so restoring a constant would silently
 * re-scope an unrelated window.
 */
export function withShutdownBusyTimeout<T>(db: Database.Database, write: () => T): T {
  const previous = db.pragma("busy_timeout", { simple: true }) as number;
  db.pragma(`busy_timeout = ${SHUTDOWN_BUSY_TIMEOUT_MS}`);
  try {
    return write();
  } finally {
    db.pragma(`busy_timeout = ${previous}`);
  }
}

/**
 * Stop SQLite from checkpointing on this connection's own commits.
 *
 * `wal_autocheckpoint` defaults to 1000 pages, and the PASSIVE checkpoint it triggers runs
 * SYNCHRONOUSLY on the committing thread — copying and fsyncing whatever WAL backlog has
 * accumulated. `busy_timeout` does not bound that work (it is not lock contention, it is I/O), and
 * the JS shutdown ceiling cannot fire while the native call runs. On a multi-GB WAL a single
 * teardown telemetry commit can therefore outlast the entire grace period.
 *
 * Called on the shutdown path only, and the steady-state reason is narrower than "safety net": the
 * auto-checkpoint bounds the WAL while the explicit checkpoint is not RUNNING — worker crashed,
 * module stopped, an abandoned worker making the next attempt skip itself — which is how a freshly
 * deployed ledger reached 642 MB. It is NOT a defense against that checkpoint being STARVED: it is
 * the same PASSIVE checkpoint, and the reader that holds one back holds the other back identically.
 * Starvation is answered by the retention module's own alert instead — three consecutive failures
 * raise `wal checkpoint starved by a persistent reader — WAL cannot shrink` at ERROR with the WAL's
 * byte size — because the fix there is to find the reader, which no pragma can do.
 *
 * What leaving it on costs is the copy above landing on an ORDINARY commit, sized by whatever
 * backlog accumulated while it could not run, and before any signal handler exists to disable it.
 * Nothing bounds that — not here, not in the shutdown budget; see `docker-compose.yml`.
 */
export function disableAutoCheckpoint(db: Database.Database): void {
  db.pragma("wal_autocheckpoint = 0");
}

export function openDatabase(dbPath: string, options: OpenDatabaseOptions = {}): DbConnection {
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // SQLite skips DELETE/INSERT triggers fired by ON CONFLICT REPLACE conflict
  // resolution unless recursive_triggers is ON. Without this, the append-only
  // BEFORE DELETE trigger on profile_settings_history can be silently bypassed
  // by `INSERT OR REPLACE`. Per-connection pragma — set on every open.
  db.pragma("recursive_triggers = ON");
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? RUNTIME_BUSY_TIMEOUT_MS}`);
  db.pragma("synchronous = NORMAL");
  // -2048 = 2 MiB per connection (negative = KiB). Default is 2000 pages ≈ 8 MiB.
  // Runtime + API each open this DB, so the default adds ~16 MiB of resident
  // RSS that the working set doesn't need. 2 MiB is plenty for our query shape.
  db.pragma("cache_size = -2048");

  return {
    db,
    close() {
      db.close();
    },
  };
}

/**
 * Drop a connection back to the runtime busy_timeout after bootstrap DDL.
 * Bootstrap opens the connection with a 10-minute timeout to ride out long
 * CREATE INDEX / schema-repair waves, but that connection is then re-used
 * for the rest of the process lifetime — leaving 600s in place would let any
 * runtime/API query block the event loop for 10 minutes behind a write lock.
 */
export function setRuntimeBusyTimeout(conn: DbConnection): void {
  conn.db.pragma(`busy_timeout = ${RUNTIME_BUSY_TIMEOUT_MS}`);
}

export function openDatabaseWithSchema(
  dbPath: string,
  schemaSql: string,
  options: OpenDatabaseOptions = {},
): DbConnection {
  const conn = openDatabase(dbPath, options);
  conn.db.exec(schemaSql);
  return conn;
}
