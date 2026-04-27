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

export function openDatabase(dbPath: string, options: OpenDatabaseOptions = {}): DbConnection {
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
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
