import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireLedgerInstanceLock, LedgerInstanceLockError } from "../ledger-instance-lock.js";

/** Takes the same lock this module takes, then stays alive until killed. Deliberately duplicates
 *  the acquire sequence rather than importing it: node cannot strip the module's TypeScript, and
 *  the role being played here is "some other runtime process", not this function. */
const CHILD_HOLDS_LOCK = `
const Database = require(process.argv[2]);
const db = new Database(process.argv[1], { timeout: 2000 });
db.pragma("locking_mode = EXCLUSIVE");
db.exec("CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY CHECK (id = 1), acquired_at TEXT NOT NULL)");
db.prepare("INSERT INTO lock (id, acquired_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET acquired_at = excluded.acquired_at").run(new Date().toISOString());
process.stdout.write("LOCKED\\n");
setInterval(() => {}, 1000);
`;

/** Same sequence, but reports whether it got in and exits — the probe for "is the lock still held
 *  over there?". Short timeout: a held lock must refuse immediately, not stall the suite. */
const CHILD_PROBES_LOCK = `
const Database = require(process.argv[2]);
try {
  const db = new Database(process.argv[1], { timeout: 500 });
  db.pragma("locking_mode = EXCLUSIVE");
  db.exec("CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY CHECK (id = 1), acquired_at TEXT NOT NULL)");
  db.prepare("INSERT INTO lock (id, acquired_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET acquired_at = excluded.acquired_at").run(new Date().toISOString());
  process.stdout.write("ACQUIRED");
} catch {
  process.stdout.write("REFUSED");
}
`;

/**
 * A real lock-db file per test, deliberately — the whole claim under test is an OS-level
 * exclusive file lock, which neither an in-memory DB nor a mock can exhibit.
 */
describe("acquireLedgerInstanceLock", () => {
  let dir: string;
  let ledgerDbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "krabs-ledger-lock-"));
    ledgerDbPath = path.join(dir, "ledger-live-lite.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires the lock and creates <ledgerDbPath>.lock.db", () => {
    const handle = acquireLedgerInstanceLock(ledgerDbPath);
    expect(existsSync(`${ledgerDbPath}.lock.db`)).toBe(true);
    handle.release();
  });

  it("refuses a second acquisition while the first is still held", () => {
    const first = acquireLedgerInstanceLock(ledgerDbPath);
    try {
      expect(() => acquireLedgerInstanceLock(ledgerDbPath)).toThrow(LedgerInstanceLockError);
    } finally {
      first.release();
    }
  });

  it("names the lock file in the thrown error", () => {
    const first = acquireLedgerInstanceLock(ledgerDbPath);
    try {
      expect(() => acquireLedgerInstanceLock(ledgerDbPath)).toThrow(`${ledgerDbPath}.lock.db`);
    } finally {
      first.release();
    }
  });

  it("allows re-acquisition once the previous holder releases", () => {
    const first = acquireLedgerInstanceLock(ledgerDbPath);
    first.release();

    const second = acquireLedgerInstanceLock(ledgerDbPath);
    expect(() => second.release()).not.toThrow();
  });

  it("does not leave -wal/-shm siblings (no WAL mode on the lock file)", () => {
    const handle = acquireLedgerInstanceLock(ledgerDbPath);
    handle.release();

    expect(existsSync(`${ledgerDbPath}.lock.db-wal`)).toBe(false);
    expect(existsSync(`${ledgerDbPath}.lock.db-shm`)).toBe(false);
  });

  it("excludes a holder in another process, and the lock frees when that process is killed", async () => {
    // POSIX advisory locks are scoped to a PROCESS: two connections inside one process are
    // arbitrated by SQLite's own in-process layer — a different mechanism from the cross-process
    // one production actually depends on. Only a real second process exercises the guarantee.
    const child = spawn(
      process.execPath,
      [
        "-e",
        CHILD_HOLDS_LOCK,
        `${ledgerDbPath}.lock.db`,
        createRequire(import.meta.url).resolve("better-sqlite3"),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );

    try {
      const stdout = child.stdout;
      if (!stdout) throw new Error("child stdout unavailable");
      await new Promise<void>((resolve, reject) => {
        let seen = "";
        stdout.on("data", (chunk: Buffer) => {
          seen += String(chunk);
          if (seen.includes("LOCKED")) resolve();
        });
        child.on("exit", (code) => reject(new Error(`child exited before locking: ${code}`)));
      });

      expect(() => acquireLedgerInstanceLock(ledgerDbPath)).toThrow(LedgerInstanceLockError);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
        child.kill("SIGKILL");
        await exited;
      }
    }

    // SIGKILL leaves no chance to clean up, which is the whole point: the OS reclaims the
    // descriptor, so the next boot succeeds with no PID file and no staleness heuristic.
    acquireLedgerInstanceLock(ledgerDbPath).release();
  }, 20_000);

  it("stays held after the handle becomes unreachable and is garbage-collected", () => {
    // better-sqlite3 closes the descriptor when a `Database` is collected, and the OS lock goes
    // with it. If the module ever stops holding its own reference, a long-running runtime silently
    // loses the lock mid-flight and a second one can boot on the same ledger.
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as unknown;
    // Asserted, not skipped: without a real gc() this test would pass for the wrong reason.
    expect(typeof gc).toBe("function");

    // No binding survives this call — the only reference the caller ever had is discarded.
    acquireLedgerInstanceLock(ledgerDbPath);
    for (let i = 0; i < 3; i += 1) (gc as () => void)();

    const verdict = execFileSync(
      process.execPath,
      [
        "-e",
        CHILD_PROBES_LOCK,
        `${ledgerDbPath}.lock.db`,
        createRequire(import.meta.url).resolve("better-sqlite3"),
      ],
      { encoding: "utf8" },
    );
    expect(verdict).toBe("REFUSED");
  });

  it("keeps the lock file at a single row across repeated restarts (bounded growth)", () => {
    for (let i = 0; i < 5; i += 1) {
      acquireLedgerInstanceLock(ledgerDbPath).release();
    }

    const inspect = new Database(`${ledgerDbPath}.lock.db`);
    try {
      const row = inspect.prepare("SELECT COUNT(*) AS n FROM lock").get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      inspect.close();
    }
  });
});
