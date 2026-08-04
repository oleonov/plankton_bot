import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWalCheckpointOffThread } from "../wal-checkpoint.js";

/**
 * A real file and a real worker thread, deliberately — the whole claim under test is about what
 * happens to a THREAD wedged inside a synchronous native call, and neither a mock worker nor an
 * in-memory database can be in that state. `:memory:` never enters WAL at all, so a checkpoint
 * against it is a no-op that would let every assertion below pass while proving nothing.
 */
describe("runWalCheckpointOffThread", () => {
  let dir: string;
  let dbPath: string;
  let walPath: string;
  let writer: Database.Database;
  let reader: Database.Database;

  /** Resolves to true only if `promise` settles before the current macrotask queue drains. */
  const settledImmediately = (promise: Promise<unknown>): Promise<boolean> =>
    Promise.race([
      promise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 0)),
    ]);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "krabs-wal-checkpoint-"));
    dbPath = path.join(dir, "ledger.db");
    walPath = `${dbPath}-wal`;
    writer = new Database(dbPath);
    writer.pragma("journal_mode = WAL");
    writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)");
    const insert = writer.prepare("INSERT INTO t (blob) VALUES (?)");
    const fill = writer.transaction(() => {
      for (let i = 0; i < 2000; i += 1) insert.run("x".repeat(1024));
    });
    fill();
    reader = new Database(dbPath, { readonly: true });
    // Guard the fixture itself: with an empty WAL the truncate assertions below are vacuous.
    expect(statSync(walPath).size).toBeGreaterThan(0);
  });

  afterEach(() => {
    reader.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("truncates the WAL and reports the pragma's own row on the uncontended path", async () => {
    const outcome = await runWalCheckpointOffThread(dbPath, 10_000, 30_000);

    expect(outcome.error).toBeNull();
    expect(outcome.abandoned).toBe(false);
    expect(outcome.result).toMatchObject({ busy: 0 });
    // The WAL is already reclaimed at the moment the verdict exists — the worker closes its
    // connection BEFORE it posts. Asserting the bytes rather than the thread's exit is deliberate:
    // the exit event lands later, and what a caller actually needs to know is that no second reader
    // is left on the ledger, not that the thread finished its own bookkeeping.
    expect(statSync(walPath).size).toBe(0);
    // It does still exit on its own, promptly and without anyone joining it.
    await outcome.workerExit;
  });

  it("abandons a wedged worker instead of terminating it, and the thread still finishes its work", async () => {
    // An open read transaction pins the WAL frames, so `wal_checkpoint(TRUNCATE)` inside the worker
    // parks on its busy timeout — a SYNCHRONOUS native call, which is the only state a wedged
    // checkpoint is ever really in. The busy timeout is generous and the parent's deadline is tiny,
    // so the ordering is fixed by construction rather than by racing two wall-clock durations: the
    // deadline is guaranteed to fire first, and the worker still has seconds of budget left.
    reader.exec("BEGIN");
    reader.prepare("SELECT id FROM t LIMIT 1").all();

    const outcome = await runWalCheckpointOffThread(dbPath, 20_000, 50);

    expect(outcome.abandoned).toBe(true);
    expect(outcome.result).toBeNull();
    expect(outcome.error).toMatch(/did not finish within 50ms/);

    // The parent stopped WAITING; the thread has not reported and the WAL is untouched.
    expect(await settledImmediately(outcome.workerExit)).toBe(false);
    expect(statSync(walPath).size).toBeGreaterThan(0);

    // Let the contention clear. Nothing re-drives the worker — if it survived, it finishes on its
    // own, and the proof is on disk rather than in a status field the parent invented.
    reader.exec("ROLLBACK");
    const exitCode = await outcome.workerExit;

    expect(statSync(walPath).size).toBe(0);
    // The exit CODE is what separates abandoning from terminating, and nothing else here does.
    // A `terminate()` lands only once the pragma returns, and sqlite has already truncated by then,
    // so the WAL bytes, the outcome object and even the timing above are identical under both
    // spellings. Only the thread's own exit differs: abandoned it runs off the end of its script
    // and exits 0; terminated it is torn down mid-flight and exits 1.
    expect(exitCode).toBe(0);
  });

  it("reports a missing ledger as an error rather than creating one", async () => {
    // `fileMustExist` in the worker: a typo'd path must not open an empty non-WAL database and
    // answer "truncated" while the real WAL keeps growing.
    const missing = path.join(dir, "absent.db");

    const outcome = await runWalCheckpointOffThread(missing, 1_000, 30_000);

    expect(outcome.result).toBeNull();
    expect(outcome.error).toBeTruthy();
    expect(outcome.abandoned).toBe(false);
  });
});
