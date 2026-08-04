import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseArgs,
  listNonTerminal,
  findRow,
  markRowOnchain,
  discardRow,
  ageSeconds,
  parseLedgerTimestamp,
  run,
  type MergeLedgerRow,
} from "../merge-ledger-reconcile.js";

// The real schema, executed verbatim — a hand-rolled CREATE TABLE here would drift from
// migrations and could pass tests against a shape merge_ledger no longer has.
const LEDGER_SQL_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/db/src/schemas/ledger.sql",
);
const LEDGER_SQL = readFileSync(LEDGER_SQL_PATH, "utf8");

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(LEDGER_SQL);
  return db;
}

// Every row gets its OWN condition_id unless a test asks otherwise: migration 093 puts a partial
// unique index on merge_ledger(condition_id) WHERE status != 'applied', so a shared default would
// make any two-non-terminal-row fixture fail on the schema rather than on what it means to test.
function insertRow(
  db: Database.Database,
  row: Partial<MergeLedgerRow> & { merge_id: string },
): void {
  db.prepare(
    `INSERT INTO merge_ledger (merge_id, condition_id, merged_amount, spread_pnl, merged_at, created_at, status)
     VALUES (@merge_id, @condition_id, @merged_amount, @spread_pnl, @merged_at, @created_at, @status)`,
  ).run({
    condition_id: `c-${row.merge_id}`,
    merged_amount: 10,
    spread_pnl: 0,
    merged_at: "2026-07-01T00:00:00.000Z",
    created_at: "2026-07-01T00:00:00.000Z",
    status: "pending",
    ...row,
  });
}

// run() opens/closes its own connection per call, so end-to-end tests need a real file rather
// than ":memory:" (a fresh :memory: db per connection would not share state across calls).
function cleanupDbFiles(tmpPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(tmpPath + suffix);
    } catch {
      // best-effort cleanup
    }
  }
}

describe("merge-ledger-reconcile: parseArgs", () => {
  it("requires --db (or LEDGER_PATH)", () => {
    expect(() => parseArgs([])).toThrow(/required: --db/);
  });

  it("defaults to list mode with no --apply", () => {
    const args = parseArgs(["--db", "x.db"]);
    expect(args).toEqual({ dbPath: "x.db", action: "list", mergeId: null, apply: false });
  });

  it("parses --mark-onchain with --apply", () => {
    const args = parseArgs(["--db", "x.db", "--mark-onchain", "m-1", "--apply"]);
    expect(args).toEqual({ dbPath: "x.db", action: "mark-onchain", mergeId: "m-1", apply: true });
  });

  it("parses --discard without --apply", () => {
    const args = parseArgs(["--db", "x.db", "--discard", "m-1"]);
    expect(args).toEqual({ dbPath: "x.db", action: "discard", mergeId: "m-1", apply: false });
  });

  it("rejects --mark-onchain and --discard together", () => {
    expect(() => parseArgs(["--db", "x.db", "--mark-onchain", "m-1", "--discard", "m-2"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("recognizes --help without requiring --db", () => {
    expect(parseArgs(["--help"])).toEqual({
      dbPath: "",
      action: "help",
      mergeId: null,
      apply: false,
    });
  });

  it("no longer offers --settle, so an operator cannot mark a row 'applied' from the CLI", () => {
    // The old flag manufactured an 'applied' row without consuming lots or booking P&L. It is now
    // parsed as nothing at all — falling through to the read-only list rather than writing.
    const args = parseArgs(["--db", "x.db", "--settle", "m-1", "--apply"]);
    expect(args.action).toBe("list");
  });
});

describe("merge-ledger-reconcile: list", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns nothing on an empty table", () => {
    expect(listNonTerminal(db)).toEqual([]);
  });

  it("returns only non-terminal rows, in created_at order", () => {
    insertRow(db, {
      merge_id: "m-applied",
      status: "applied",
      created_at: "2026-07-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-onchain",
      status: "onchain",
      created_at: "2026-07-02T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-pending",
      status: "pending",
      created_at: "2026-07-01T12:00:00.000Z",
    });

    const rows = listNonTerminal(db);
    expect(rows.map((r) => r.merge_id)).toEqual(["m-pending", "m-onchain"]);
  });
});

describe("merge-ledger-reconcile: row age", () => {
  it("reads SQLite's zone-less datetime('now') as UTC, not as local time", () => {
    // This is the format the column DEFAULT writes in production. Date.parse would read it as
    // local time, so on any non-UTC host a fresh row would print hours old. The assertion is
    // written against a fixed UTC instant so it holds in every TZ the suite runs in.
    const nowMs = Date.parse("2026-07-01T00:00:30.000Z");
    expect(ageSeconds("2026-07-01 00:00:00", nowMs)).toBe(30);
  });

  it("uses the real DEFAULT that SQLite writes, so the test cannot drift from the schema", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO merge_ledger (merge_id, condition_id, merged_amount, spread_pnl, merged_at, status)
       VALUES ('m-default', 'c-1', 10, 0, '2026-07-01T00:00:00.000Z', 'pending')`,
    ).run();
    const createdAt = findRow(db, "m-default")!.created_at;

    // Anything the schema writes must land within a few seconds of "now" once parsed as UTC.
    expect(Math.abs(ageSeconds(createdAt, Date.now()))).toBeLessThan(60);
  });

  it("leaves an explicit zone alone — the runtime writes ISO strings with a trailing Z", () => {
    expect(parseLedgerTimestamp("2026-07-01T00:00:00.000Z")).toBe(
      Date.parse("2026-07-01T00:00:00.000Z"),
    );
  });
});

describe("merge-ledger-reconcile: mark-onchain", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    insertRow(db, { merge_id: "m-1", status: "pending" });
    insertRow(db, { merge_id: "m-2", status: "onchain" });
  });

  it("promotes exactly the targeted row and leaves the sibling row untouched", () => {
    markRowOnchain(db, "m-1", "pending");
    expect(findRow(db, "m-1")?.status).toBe("onchain");
    expect(findRow(db, "m-2")?.status).toBe("onchain");
  });

  it("never marks a row 'applied' — settling stays with the runtime, which also moves the lots", () => {
    markRowOnchain(db, "m-1", "pending");
    expect(findRow(db, "m-1")?.status).not.toBe("applied");
  });

  it("throws for a mergeId that does not exist", () => {
    expect(() => markRowOnchain(db, "missing", "pending")).toThrow(/matched 0/);
  });

  it("aborts when the row moved out from under the read — the runtime, not this CLI, wins", () => {
    // The operator read 'pending'; a live runtime confirmed the merge and advanced it meanwhile.
    db.prepare(`UPDATE merge_ledger SET status = 'applied' WHERE merge_id = 'm-1'`).run();
    expect(() => markRowOnchain(db, "m-1", "pending")).toThrow(/row changed under this command/);
    expect(findRow(db, "m-1")?.status).toBe("applied");
  });
});

describe("merge-ledger-reconcile: discard", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    insertRow(db, { merge_id: "m-1", status: "pending" });
    insertRow(db, { merge_id: "m-2", status: "onchain" });
  });

  it("deletes exactly the targeted row and leaves the sibling row untouched", () => {
    discardRow(db, "m-1", "pending");
    expect(findRow(db, "m-1")).toBeUndefined();
    expect(findRow(db, "m-2")?.status).toBe("onchain");
  });

  it("throws for a mergeId that does not exist", () => {
    expect(() => discardRow(db, "missing", "pending")).toThrow(/matched 0/);
  });

  it("cannot delete a row the runtime advanced to 'onchain' after the read", () => {
    db.prepare(`UPDATE merge_ledger SET status = 'onchain' WHERE merge_id = 'm-1'`).run();
    expect(() => discardRow(db, "m-1", "pending")).toThrow(/row changed under this command/);
    expect(findRow(db, "m-1")?.status).toBe("onchain");
  });
});

describe("merge-ledger-reconcile: run() end-to-end against a file-backed db", () => {
  it("mark-onchain via run() with --apply promotes the row and refuses a second promotion", () => {
    const tmpPath = resolve(dirname(fileURLToPath(import.meta.url)), "__tmp-merge-ledger-run.db");
    const db = new Database(tmpPath);
    db.exec(LEDGER_SQL);
    insertRow(db, { merge_id: "m-run", status: "pending" });
    db.close();

    try {
      const dryRunExit = run({
        dbPath: tmpPath,
        action: "mark-onchain",
        mergeId: "m-run",
        apply: false,
      });
      expect(dryRunExit).toBe(0);

      const verifyDb = new Database(tmpPath, { readonly: true });
      expect(findRow(verifyDb, "m-run")?.status).toBe("pending");
      verifyDb.close();

      const applyExit = run({
        dbPath: tmpPath,
        action: "mark-onchain",
        mergeId: "m-run",
        apply: true,
      });
      expect(applyExit).toBe(0);

      const afterDb = new Database(tmpPath, { readonly: true });
      expect(findRow(afterDb, "m-run")?.status).toBe("onchain");
      afterDb.close();

      // The row is now the runtime's to settle; the CLI has nothing left to do with it.
      const secondExit = run({
        dbPath: tmpPath,
        action: "mark-onchain",
        mergeId: "m-run",
        apply: true,
      });
      expect(secondExit).toBe(1);
    } finally {
      cleanupDbFiles(tmpPath);
    }
  });

  it("run() refuses to discard an 'onchain' row and leaves it in place", () => {
    const tmpPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "__tmp-merge-ledger-onchain.db",
    );
    const db = new Database(tmpPath);
    db.exec(LEDGER_SQL);
    insertRow(db, { merge_id: "m-landed", status: "onchain" });
    db.close();

    try {
      const exitCode = run({
        dbPath: tmpPath,
        action: "discard",
        mergeId: "m-landed",
        apply: true,
      });
      expect(exitCode).toBe(1);

      const afterDb = new Database(tmpPath, { readonly: true });
      expect(findRow(afterDb, "m-landed")?.status).toBe("onchain");
      afterDb.close();
    } finally {
      cleanupDbFiles(tmpPath);
    }
  });

  it("run() refuses to touch an 'applied' row", () => {
    const tmpPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "__tmp-merge-ledger-applied.db",
    );
    const db = new Database(tmpPath);
    db.exec(LEDGER_SQL);
    insertRow(db, { merge_id: "m-done", status: "applied" });
    db.close();

    try {
      expect(run({ dbPath: tmpPath, action: "mark-onchain", mergeId: "m-done", apply: true })).toBe(
        1,
      );
      expect(run({ dbPath: tmpPath, action: "discard", mergeId: "m-done", apply: true })).toBe(1);

      const afterDb = new Database(tmpPath, { readonly: true });
      expect(findRow(afterDb, "m-done")?.status).toBe("applied");
      afterDb.close();
    } finally {
      cleanupDbFiles(tmpPath);
    }
  });

  it("run() reports a non-zero exit and touches nothing for an unknown mergeId", () => {
    const tmpPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "__tmp-merge-ledger-missing.db",
    );
    const db = new Database(tmpPath);
    db.exec(LEDGER_SQL);
    db.close();

    try {
      const exitCode = run({ dbPath: tmpPath, action: "discard", mergeId: "ghost", apply: true });
      expect(exitCode).toBe(1);
    } finally {
      cleanupDbFiles(tmpPath);
    }
  });
});
