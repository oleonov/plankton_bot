import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";

/**
 * Runs the WAL checkpoint on its OWN connection, off the runtime's event loop.
 *
 * better-sqlite3 is synchronous: a checkpoint on the shared runtime connection blocks Node for as
 * long as it takes to copy and fsync every WAL frame — minutes on the multi-GB WAL this module
 * exists to reclaim — which is long enough to drop the established WSS connection and stall
 * reconciliation. No JavaScript deadline can interrupt a native synchronous call, so the only real
 * bound is to run it somewhere the event loop is not.
 *
 * Off-thread also buys patience: the wait for readers can be generous (see
 * `checkpointBusyTimeoutMs`) instead of the one second the shared connection could afford, which is
 * what a briefly-overlapping reader needs to stop starving the checkpoint.
 *
 * Deliberately minimal: open, checkpoint, report, close. It runs no migrations and sets no
 * connection pragmas beyond the busy timeout — the ledger's schema and journal mode are owned by
 * the process that created it.
 */
const { dbPath, busyTimeoutMs } = workerData as { dbPath: string; busyTimeoutMs: number };

type PragmaRow = Record<string, unknown>;

const firstRow = (rows: unknown): PragmaRow | null =>
  Array.isArray(rows) ? ((rows[0] as PragmaRow | undefined) ?? null) : null;

let db: Database.Database | null = null;
let message: { ok: boolean; result?: PragmaRow | null; error?: string };
try {
  // `fileMustExist` because better-sqlite3 otherwise CREATES the path it was handed. A typo'd or
  // moved ledger path would then open an empty non-WAL database, checkpoint it "successfully", and
  // leave the runtime's real WAL untouched while the log reports a truncate — verified: the fresh
  // file answers `{busy: 0, log: -1, checkpointed: -1}`. Failing to open is the honest outcome.
  db = new Database(dbPath, { fileMustExist: true });
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  // PASSIVE first, and it is not an optimisation — moving the frames off-thread is only half the
  // problem. TRUNCATE holds the exclusive WRITER lock for its whole duration, and the runtime's own
  // connection is synchronous with a 30 s busy timeout (packages/db/src/connection.ts): every
  // millisecond TRUNCATE spends copying frames is a millisecond the runtime's next ledger write
  // blocks INSIDE a native call, i.e. a frozen event loop, worker thread or not.
  //
  // PASSIVE takes no writer lock — it copies whatever frames it can and yields to anyone who wants
  // the file. Measured with the runtime connection writing continuously throughout, worst single
  // write stall / writes admitted:
  //
  //     413 MB WAL   TRUNCATE alone 361 ms / 615      PASSIVE→TRUNCATE  23 ms / 16 180
  //   1 239 MB WAL   TRUNCATE alone 1088 ms / 1 095   PASSIVE→TRUNCATE  38 ms / 32 916
  //
  // Both reclaim the same bytes (WAL → 0). The freeze scales with WAL size for TRUNCATE alone
  // (~0.9 ms/MB) but not for PASSIVE-first (~0.03 ms/MB), because the second TRUNCATE has nothing
  // left to copy — 17 ms and 37 ms respectively. Extrapolated to the 18.7 GB WAL production
  // actually reached, that is ~16 s of frozen event loop versus well under one.
  //
  // Do not go looking for a unit test of this line: there cannot be one. When the writer lock is
  // already taken SQLite downgrades TRUNCATE to PASSIVE internally (`sqlite3WalCheckpoint`), so both
  // shapes return an identical row and move identical bytes — verified. The difference lives only in
  // how long the lock is HELD on the uncontended path, i.e. in the numbers above.
  db.pragma("wal_checkpoint(PASSIVE)");
  const truncate = firstRow(db.pragma("wal_checkpoint(TRUNCATE)"));
  message = { ok: true, result: truncate };
} catch (err) {
  message = { ok: false, error: err instanceof Error ? err.message : String(err) };
}
// Reported only after the connection is closed. A parent that hears "done" while this thread still
// holds an open connection can start the next pass — or let the supervisor tear the ledger down —
// against a reader that is, briefly, still there.
db?.close();
parentPort?.postMessage(message);
