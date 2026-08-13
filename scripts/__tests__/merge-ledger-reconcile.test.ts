import { describe, it, expect, beforeEach, vi } from "vitest";
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
  proveRecoveryFence,
  run,
  type FenceProof,
  type MergeLedgerRow,
} from "../merge-ledger-reconcile.js";

// `expect(proof.proven).toBe(false)` asserts but does not narrow the union, so the `reason` the
// refusal tests read stays invisible to the type checker. Assert through this instead.
function assertRefused(proof: FenceProof): asserts proof is { proven: false; reason: string } {
  expect(proof.proven).toBe(false);
}

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
    `INSERT INTO merge_ledger (merge_id, condition_id, merged_amount, spread_pnl, merged_at, created_at, status,
       yes_token_id, no_token_id, yes_position_id, no_position_id)
     VALUES (@merge_id, @condition_id, @merged_amount, @spread_pnl, @merged_at, @created_at, @status,
       @yes_token_id, @no_token_id, @yes_position_id, @no_position_id)`,
  ).run({
    condition_id: `c-${row.merge_id}`,
    merged_amount: 10,
    spread_pnl: 0,
    merged_at: "2026-07-01T00:00:00.000Z",
    created_at: "2026-07-01T00:00:00.000Z",
    status: "pending",
    yes_token_id: `yes-${row.merge_id}`,
    no_token_id: `no-${row.merge_id}`,
    yes_position_id: `p-yes-${row.merge_id}`,
    no_position_id: `p-no-${row.merge_id}`,
    ...row,
  });
}

// Minimal mutable-catalog fixture used to prove the exact-identity result is remap-invariant.
function insertMarket(
  db: Database.Database,
  market: Partial<{
    condition_id: string;
    slug: string;
    question: string;
    outcome: string;
    outcome_index: number | null;
    tick_size: number;
  }> & { token_id: string },
): void {
  db.prepare(
    `INSERT INTO markets (token_id, condition_id, slug, question, outcome, outcome_index, tick_size)
     VALUES (@token_id, @condition_id, @slug, @question, @outcome, @outcome_index, @tick_size)`,
  ).run({
    condition_id: `c-${market.token_id}`,
    slug: `slug-${market.token_id}`,
    question: `question-${market.token_id}`,
    outcome: "Yes",
    outcome_index: null,
    tick_size: 0.01,
    ...market,
  });
}

// Minimal fixture for a `positions` row. `opened_at` has a schema DEFAULT, but every test in this
// file sets it explicitly — its relationship to `merged_at` is exactly what proveRecoveryFence tests.
function insertPosition(
  db: Database.Database,
  position: Partial<{ status: string; opened_at: string; side: string; condition_id: string }> & {
    position_id: string;
    token_id: string;
  },
): void {
  // `condition_id` defaults to the condition the token's `markets` row names — which is exactly
  // how a real row gets it: `startup-position-adoption` copies `market.conditionId` into the
  // synthetic order and `inventory-handler.createNewPosition` persists `fill.conditionId`. An
  // unconditional "" default would be the pre-column legacy value, and seeding it everywhere would
  // let a test pass only because the ownership fence saw a value the live ledger cannot hold for a
  // freshly created row. Tests that exercise legacy or foreign ownership set it explicitly.
  db.prepare(
    `INSERT INTO positions (position_id, token_id, side, status, opened_at, condition_id)
     VALUES (@position_id, @token_id, @side, @status, @opened_at,
             COALESCE(@condition_id, (SELECT condition_id FROM markets WHERE token_id = @token_id), ''))`,
  ).run({
    side: "buy",
    status: "open",
    opened_at: "2026-07-01T00:00:00.000Z",
    condition_id: null,
    ...position,
  });
}

// Minimal fixture for a live FIFO lot. `inventory_lots.fill_id` is `NOT NULL REFERENCES
// fills(fill_id)` and better-sqlite3 enables `PRAGMA foreign_keys` by default, so a lot cannot
// exist without its fill — and a fill cannot exist without its order. The parent chain is created
// here rather than switched off, so the fixture stays a shape the real ledger can actually hold.
function insertLot(
  db: Database.Database,
  lot: Partial<{ remaining_size: number; created_at: string }> & {
    lot_id: string;
    position_id: string;
    token_id: string;
  },
): void {
  const fillId = `f-${lot.lot_id}`;
  const orderId = `o-${lot.lot_id}`;
  db.prepare(
    `INSERT INTO orders (order_id, client_order_id, token_id, side, order_type, price, size, size_usdc, bot_run_id)
     VALUES (?, ?, ?, 'buy', 'GTC', 0.5, 10, 5, 'run-test')`,
  ).run(orderId, `coid-${lot.lot_id}`, lot.token_id);
  db.prepare(
    `INSERT INTO fills (fill_id, order_id, token_id, side, price, size, size_usdc)
     VALUES (?, ?, ?, 'buy', 0.5, 10, 5)`,
  ).run(fillId, orderId, lot.token_id);
  // COALESCE keeps the schema's own `datetime('now')` DEFAULT for every fixture that does not care
  // about lot age — that default renders in the space form, which is exactly what the `lot-after`
  // mirror must treat as unprovable.
  db.prepare(
    `INSERT INTO inventory_lots (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
     VALUES (@lot_id, @position_id, @token_id, 'buy', 10, @remaining_size, 0.5, 5, @fill_id, COALESCE(@created_at, datetime('now')))`,
  ).run({ remaining_size: 10, ...lot, fill_id: fillId, created_at: lot.created_at ?? null });
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
    expect(args).toEqual({
      dbPath: "x.db",
      action: "list",
      mergeId: null,
      apply: false,
      fenced: false,
    });
  });

  it("parses --mark-onchain with --apply", () => {
    const args = parseArgs(["--db", "x.db", "--mark-onchain", "m-1", "--apply"]);
    expect(args).toEqual({
      dbPath: "x.db",
      action: "mark-onchain",
      mergeId: "m-1",
      apply: true,
      fenced: false,
    });
  });

  it("parses --discard without --apply", () => {
    const args = parseArgs(["--db", "x.db", "--discard", "m-1"]);
    expect(args).toEqual({
      dbPath: "x.db",
      action: "discard",
      mergeId: "m-1",
      apply: false,
      fenced: false,
    });
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
      fenced: false,
    });
  });

  it("parses --discard with --fenced", () => {
    const args = parseArgs(["--db", "x.db", "--discard", "m-1", "--fenced", "--apply"]);
    expect(args).toEqual({
      dbPath: "x.db",
      action: "discard",
      mergeId: "m-1",
      apply: true,
      fenced: true,
    });
  });

  it("rejects --fenced combined with --mark-onchain", () => {
    expect(() =>
      parseArgs(["--db", "x.db", "--mark-onchain", "m-1", "--fenced", "--apply"]),
    ).toThrow(/--fenced is only valid together with --discard/);
  });

  it("rejects --fenced with no action at all", () => {
    expect(() => parseArgs(["--db", "x.db", "--fenced"])).toThrow(
      /--fenced is only valid together with --discard/,
    );
  });

  it("rejects the removed --settle instead of silently listing", () => {
    // The old flag manufactured an 'applied' row without consuming lots or booking P&L. Falling
    // through to the read-only list would be the worse failure: operator automation still calling
    // `--settle <id> --apply` would exit 0 having reconciled nothing, and the row would look healed.
    expect(() => parseArgs(["--db", "x.db", "--settle", "m-1", "--apply"])).toThrow(
      /--settle was removed/,
    );
  });

  it("rejects an unknown flag rather than treating it as list mode", () => {
    expect(() => parseArgs(["--db", "x.db", "--force"])).toThrow(/unknown flag --force/);
  });

  it("still answers --help even alongside a removed flag", () => {
    expect(parseArgs(["--settle", "m-1", "--help"]).action).toBe("help");
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
      `INSERT INTO merge_ledger (
         merge_id, condition_id, merged_amount, spread_pnl, merged_at, status,
         yes_token_id, no_token_id, yes_position_id, no_position_id
       ) VALUES (
         'm-default', 'c-1', 10, 0, '2026-07-01T00:00:00.000Z', 'pending',
         't-yes', 't-no', 'p-yes', 'p-no'
       )`,
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

  it("a fenced discard's CAS still refuses once the runtime settled the row to 'applied'", () => {
    // Mirrors the pending->onchain race above, but for the --fenced escape hatch: the operator read
    // 'onchain' and passed --fenced, then the runtime settled the row (onchain -> applied) before
    // this write landed. discardRow does not know about --fenced at all — it only ever compares
    // against the status actually read — so this exercises the same CAS path with 'onchain' as the
    // expected status instead of 'pending'.
    insertRow(db, { merge_id: "m-fenced-race", status: "onchain" });
    db.prepare(`UPDATE merge_ledger SET status = 'applied' WHERE merge_id = 'm-fenced-race'`).run();
    expect(() => discardRow(db, "m-fenced-race", "onchain")).toThrow(
      /row changed under this command/,
    );
    expect(findRow(db, "m-fenced-race")?.status).toBe("applied");
  });
});

describe("merge-ledger-reconcile: proveRecoveryFence", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  function insertExactPair(mergeId: string): void {
    insertPosition(db, {
      position_id: `p-yes-${mergeId}`,
      token_id: `yes-${mergeId}`,
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: `p-no-${mergeId}`,
      token_id: `no-${mergeId}`,
      opened_at: "2026-06-01T00:00:00.000Z",
    });
  }

  it("refuses a recoverable exact pair", () => {
    insertExactPair("m-recoverable");
    insertRow(db, { merge_id: "m-recoverable", status: "onchain" });

    const proof = proveRecoveryFence(db, findRow(db, "m-recoverable")!);

    assertRefused(proof);
    expect(proof.reason).toBe("both exact recorded legs remain recoverable");
  });

  it("is invariant under mutable market catalog remaps", () => {
    insertExactPair("m-remap");
    insertRow(db, { merge_id: "m-remap", condition_id: "c-original", status: "onchain" });
    insertMarket(db, {
      token_id: "yes-m-remap",
      condition_id: "c-original",
      outcome: "Yes",
      outcome_index: 0,
    });
    const before = proveRecoveryFence(db, findRow(db, "m-remap")!);
    db.prepare(
      `UPDATE markets SET condition_id = 'c-replacement', outcome = 'No', outcome_index = 1
       WHERE token_id = 'yes-m-remap'`,
    ).run();

    const after = proveRecoveryFence(db, findRow(db, "m-remap")!);

    expect(after).toEqual(before);
    assertRefused(after);
  });

  it("proves a missing exact leg only when its token has no live lots", () => {
    insertPosition(db, {
      position_id: "p-no-m-missing",
      token_id: "no-m-missing",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, { merge_id: "m-missing", status: "onchain" });

    expect(proveRecoveryFence(db, findRow(db, "m-missing")!)).toEqual({ proven: true });
  });

  it("proves a closed exact leg only when its token has no live lots", () => {
    insertExactPair("m-closed");
    db.prepare(`UPDATE positions SET status = 'closed' WHERE position_id = 'p-yes-m-closed'`).run();
    insertRow(db, { merge_id: "m-closed", status: "onchain" });

    expect(proveRecoveryFence(db, findRow(db, "m-closed")!)).toEqual({ proven: true });
  });

  it.each([
    ["YES", "yes", "no", "no-token-mismatch"],
    ["NO", "no", "yes", "yes-token-mismatch"],
  ])(
    "refuses an exhausted %s leg when the other exact position has a mismatched token",
    (_label, exhausted, mismatched, expectedReason) => {
      const mergeId = `m-exhausted-${exhausted}`;
      insertPosition(db, {
        position_id: `p-${mismatched}-${mergeId}`,
        token_id: "wrong-token",
        opened_at: "2026-06-01T00:00:00.000Z",
      });
      insertRow(db, { merge_id: mergeId, status: "onchain" });

      const proof = proveRecoveryFence(db, findRow(db, mergeId)!);

      assertRefused(proof);
      expect(proof.reason).toContain(expectedReason);
    },
  );

  it("refuses a missing exact leg while any live lot for its recorded token remains", () => {
    insertPosition(db, {
      position_id: "p-yes-replacement",
      token_id: "yes-m-resurrectable",
      opened_at: "2026-08-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no-m-resurrectable",
      token_id: "no-m-resurrectable",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertLot(db, {
      lot_id: "l-resurrectable",
      position_id: "p-yes-replacement",
      token_id: "yes-m-resurrectable",
      created_at: "2026-08-01T00:00:00.000Z",
    });
    insertRow(db, { merge_id: "m-resurrectable", status: "onchain" });

    const proof = proveRecoveryFence(db, findRow(db, "m-resurrectable")!);

    assertRefused(proof);
    expect(proof.reason).toMatch(/yes-resurrectable/);
  });

  it("refuses an exact position whose token differs from the recorded token", () => {
    insertPosition(db, {
      position_id: "p-yes-m-mismatch",
      token_id: "wrong-token",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no-m-mismatch",
      token_id: "no-m-mismatch",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, { merge_id: "m-mismatch", status: "onchain" });

    const proof = proveRecoveryFence(db, findRow(db, "m-mismatch")!);

    assertRefused(proof);
    expect(proof.reason).toMatch(/yes-token-mismatch/);
  });

  it.each([
    ["the YES position opened at the intent", "position", "yes"],
    ["the NO position opened at the intent", "position", "no"],
    ["a YES live lot from the intent second", "lot", "yes"],
    ["a NO live lot from the intent second", "lot", "no"],
  ])("refuses %s", (_label, kind, side) => {
    insertExactPair("m-freshness");
    insertRow(db, {
      merge_id: "m-freshness",
      merged_at: "2026-07-01T00:00:00.750Z",
      status: "onchain",
    });
    if (kind === "position") {
      db.prepare(
        `UPDATE positions SET opened_at = '2026-07-01T00:00:00.750Z'
         WHERE position_id = ?`,
      ).run(`p-${side}-m-freshness`);
    } else {
      insertLot(db, {
        lot_id: `l-${side}-freshness`,
        position_id: `p-${side}-m-freshness`,
        token_id: `${side}-m-freshness`,
        created_at: "2026-07-01 00:00:00",
      });
    }

    const proof = proveRecoveryFence(db, findRow(db, "m-freshness")!);

    assertRefused(proof);
    expect(proof.reason).toContain(`${side}-${kind === "position" ? "opened-after" : "lot-after"}`);
  });

  it.each([
    ["missing YES token", { yes_token_id: null }],
    ["missing NO token", { no_token_id: null }],
    ["missing YES position", { yes_position_id: null }],
    ["missing NO position", { no_position_id: null }],
    ["blank YES token", { yes_token_id: " " }],
    ["blank NO token", { no_token_id: "\t" }],
    ["blank YES position", { yes_position_id: "" }],
    ["blank NO position", { no_position_id: "  " }],
    ["duplicate tokens", { no_token_id: "yes-m-invalid" }],
    ["duplicate positions", { no_position_id: "p-yes-m-invalid" }],
    ["YES token/YES position cross-bound", { yes_token_id: "p-yes-m-invalid" }],
    ["YES token/NO position cross-bound", { yes_token_id: "p-no-m-invalid" }],
    ["NO token/YES position cross-bound", { no_token_id: "p-yes-m-invalid" }],
    ["NO token/NO position cross-bound", { no_token_id: "p-no-m-invalid" }],
  ])("refuses %s recorded identity", (_label, mutation) => {
    insertRow(db, { merge_id: "m-invalid", status: "onchain" });
    const row = { ...findRow(db, "m-invalid")!, ...mutation };

    const proof = proveRecoveryFence(db, row);

    assertRefused(proof);
    expect(proof.reason).toMatch(/invalid recorded leg identity/);
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
        fenced: false,
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
        fenced: false,
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
        fenced: false,
      });
      expect(secondExit).toBe(1);
    } finally {
      cleanupDbFiles(tmpPath);
    }
  });

  it("run() refuses to discard an 'onchain' row without --fenced, and no longer promises the runtime will settle it", () => {
    const tmpPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "__tmp-merge-ledger-onchain.db",
    );
    const db = new Database(tmpPath);
    db.exec(LEDGER_SQL);
    insertRow(db, { merge_id: "m-landed", status: "onchain" });
    db.close();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const exitCode = run({
        dbPath: tmpPath,
        action: "discard",
        mergeId: "m-landed",
        apply: true,
        fenced: false,
      });
      expect(exitCode).toBe(1);

      // The old promise ("Start the runtime instead — it settles the row.") is false once boot
      // Recovery may fence the exact recorded legs. The refusal must point at the bounded
      // --fenced escape hatch rather than claiming a restart necessarily settles it.
      const message = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(message).not.toMatch(/Start the runtime instead — it settles the row\./);
      expect(message).toMatch(/--discard m-landed --fenced --apply/);

      const afterDb = new Database(tmpPath, { readonly: true });
      expect(findRow(afterDb, "m-landed")?.status).toBe("onchain");
      afterDb.close();
    } finally {
      errorSpy.mockRestore();
      cleanupDbFiles(tmpPath);
    }
  });

  it("run() still refuses --mark-onchain on an 'onchain' row, and points at the --fenced escape path", () => {
    const tmpPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "__tmp-merge-ledger-markonchain-onchain.db",
    );
    const db = new Database(tmpPath);
    db.exec(LEDGER_SQL);
    insertRow(db, { merge_id: "m-already", status: "onchain" });
    db.close();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const exitCode = run({
        dbPath: tmpPath,
        action: "mark-onchain",
        mergeId: "m-already",
        apply: true,
        fenced: false,
      });
      expect(exitCode).toBe(1);

      const message = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(message).toMatch(/--discard m-already --fenced --apply/);

      const afterDb = new Database(tmpPath, { readonly: true });
      expect(findRow(afterDb, "m-already")?.status).toBe("onchain");
      afterDb.close();
    } finally {
      errorSpy.mockRestore();
      cleanupDbFiles(tmpPath);
    }
  });

  it("run() with --discard --fenced --apply deletes an 'onchain' row proveRecoveryFence confirms is fenced", () => {
    const tmpPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "__tmp-merge-ledger-fenced-discard.db",
    );
    const db = new Database(tmpPath);
    db.exec(LEDGER_SQL);
    // The exact recorded YES leg is closed. A newer same-token row must never replace it.
    insertMarket(db, {
      token_id: "t-yes-fenced",
      condition_id: "c-m-fenced",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no-fenced",
      condition_id: "c-m-fenced",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes-fenced-v1",
      token_id: "t-yes-fenced",
      status: "closed",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-yes-fenced-v2",
      token_id: "t-yes-fenced",
      status: "open",
      opened_at: "2026-07-02T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no-fenced",
      token_id: "t-no-fenced",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-fenced",
      condition_id: "c-m-fenced",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
      yes_token_id: "t-yes-fenced",
      no_token_id: "t-no-fenced",
      yes_position_id: "p-yes-fenced-v1",
      no_position_id: "p-no-fenced",
    });
    db.close();

    try {
      const exitCode = run({
        dbPath: tmpPath,
        action: "discard",
        mergeId: "m-fenced",
        apply: true,
        fenced: true,
      });
      expect(exitCode).toBe(0);

      const afterDb = new Database(tmpPath, { readonly: true });
      expect(findRow(afterDb, "m-fenced")).toBeUndefined();
      afterDb.close();
    } finally {
      cleanupDbFiles(tmpPath);
    }
  });

  it("run() with --discard --fenced but no --apply is a dry run that still prints the fenced warning", () => {
    const tmpPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "__tmp-merge-ledger-fenced-dryrun.db",
    );
    const db = new Database(tmpPath);
    db.exec(LEDGER_SQL);
    // Same replaced-YES-leg scenario as the --apply test above, so the dry run also passes
    // proveRecoveryFence and reaches the fenced-discard warning before hitting the dry-run branch.
    insertMarket(db, {
      token_id: "t-yes-fenced-dry",
      condition_id: "c-m-fenced-dry",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no-fenced-dry",
      condition_id: "c-m-fenced-dry",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes-fenced-dry-v1",
      token_id: "t-yes-fenced-dry",
      status: "closed",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-yes-fenced-dry-v2",
      token_id: "t-yes-fenced-dry",
      status: "open",
      opened_at: "2026-07-02T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no-fenced-dry",
      token_id: "t-no-fenced-dry",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-fenced-dry",
      condition_id: "c-m-fenced-dry",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
      yes_token_id: "t-yes-fenced-dry",
      no_token_id: "t-no-fenced-dry",
      yes_position_id: "p-yes-fenced-dry-v1",
      no_position_id: "p-no-fenced-dry",
    });
    db.close();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exitCode = run({
        dbPath: tmpPath,
        action: "discard",
        mergeId: "m-fenced-dry",
        apply: false,
        fenced: true,
      });
      expect(exitCode).toBe(0);

      // The dry run must show the operator exactly what a real --apply would give up, before they
      // commit to it.
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toMatch(/FENCED DISCARD WARNING/);
      expect(output).toMatch(/DRY RUN/);

      const afterDb = new Database(tmpPath, { readonly: true });
      expect(findRow(afterDb, "m-fenced-dry")?.status).toBe("onchain");
      afterDb.close();
    } finally {
      logSpy.mockRestore();
      cleanupDbFiles(tmpPath);
    }
  });

  it("run() refuses --discard --fenced --apply when proveRecoveryFence finds a settleable pair, and never deletes the row", () => {
    const tmpPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "__tmp-merge-ledger-fenced-refused-apply.db",
    );
    const db = new Database(tmpPath);
    db.exec(LEDGER_SQL);
    // Settleable-pair scenario: both legs are still open and predate merged_at, so boot recovery
    // can settle this row normally — --fenced must not be able to force the delete through.
    insertMarket(db, {
      token_id: "t-yes-settleable",
      condition_id: "c-m-settleable-apply",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no-settleable",
      condition_id: "c-m-settleable-apply",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes-settleable",
      token_id: "t-yes-settleable",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no-settleable",
      token_id: "t-no-settleable",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-settleable-apply",
      condition_id: "c-m-settleable-apply",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
      yes_token_id: "t-yes-settleable",
      no_token_id: "t-no-settleable",
      yes_position_id: "p-yes-settleable",
      no_position_id: "p-no-settleable",
    });
    db.close();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const exitCode = run({
        dbPath: tmpPath,
        action: "discard",
        mergeId: "m-settleable-apply",
        apply: true,
        fenced: true,
      });
      expect(exitCode).toBe(1);

      const afterDb = new Database(tmpPath, { readonly: true });
      expect(findRow(afterDb, "m-settleable-apply")?.status).toBe("onchain");
      afterDb.close();
    } finally {
      errorSpy.mockRestore();
      cleanupDbFiles(tmpPath);
    }
  });

  it("run() refuses --discard --fenced (dry run) when proveRecoveryFence finds a settleable pair — refusal precedes both the fenced warning and the dry-run branch", () => {
    const tmpPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "__tmp-merge-ledger-fenced-refused-dryrun.db",
    );
    const db = new Database(tmpPath);
    db.exec(LEDGER_SQL);
    insertMarket(db, {
      token_id: "t-yes-settleable-dry",
      condition_id: "c-m-settleable-dry",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no-settleable-dry",
      condition_id: "c-m-settleable-dry",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes-settleable-dry",
      token_id: "t-yes-settleable-dry",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no-settleable-dry",
      token_id: "t-no-settleable-dry",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-settleable-dry",
      condition_id: "c-m-settleable-dry",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
      yes_token_id: "t-yes-settleable-dry",
      no_token_id: "t-no-settleable-dry",
      yes_position_id: "p-yes-settleable-dry",
      no_position_id: "p-no-settleable-dry",
    });
    db.close();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const exitCode = run({
        dbPath: tmpPath,
        action: "discard",
        mergeId: "m-settleable-dry",
        apply: false,
        fenced: true,
      });
      expect(exitCode).toBe(1);

      const errorMessage = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(errorMessage).toMatch(/refusing --discard m-settleable-dry --fenced/);

      // The refusal must land before both the fenced-discard warning and the dry-run branch — a
      // dry run that reported "would delete" for a row this command will in fact refuse would send
      // the operator back with --apply on a row the runtime can still settle.
      const logOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logOutput).not.toMatch(/DRY RUN/);
      expect(logOutput).not.toMatch(/FENCED DISCARD WARNING/);

      const afterDb = new Database(tmpPath, { readonly: true });
      expect(findRow(afterDb, "m-settleable-dry")?.status).toBe("onchain");
      afterDb.close();
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      cleanupDbFiles(tmpPath);
    }
  });

  it("run() allows --fenced alongside --discard on a 'pending' row (inert acknowledgment)", () => {
    // Design choice: --fenced only relaxes the onchain -> deleted transition (rejectIllegalTransition
    // never inspects it for a 'pending' row, which was always legal to discard on its own). Refusing
    // --fenced here would force the operator to already know the row's status before deciding
    // whether the acknowledgment flag is "allowed" — a needless usage trap for a flag that simply
    // does nothing on a row it doesn't apply to. So 'pending' + --fenced behaves exactly like a
    // plain discard.
    const tmpPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "__tmp-merge-ledger-pending-fenced.db",
    );
    const db = new Database(tmpPath);
    db.exec(LEDGER_SQL);
    insertRow(db, { merge_id: "m-pending-fenced", status: "pending" });
    db.close();

    try {
      const exitCode = run({
        dbPath: tmpPath,
        action: "discard",
        mergeId: "m-pending-fenced",
        apply: true,
        fenced: true,
      });
      expect(exitCode).toBe(0);

      const afterDb = new Database(tmpPath, { readonly: true });
      expect(findRow(afterDb, "m-pending-fenced")).toBeUndefined();
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
    insertRow(db, {
      merge_id: "m-done",
      status: "applied",
      yes_token_id: null,
      no_token_id: null,
      yes_position_id: null,
      no_position_id: null,
    });
    db.close();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(
        run({
          dbPath: tmpPath,
          action: "mark-onchain",
          mergeId: "m-done",
          apply: true,
          fenced: false,
        }),
      ).toBe(1);
      expect(
        run({ dbPath: tmpPath, action: "discard", mergeId: "m-done", apply: true, fenced: false }),
      ).toBe(1);
      // Even the acknowledgment flag cannot revive a terminal row — 'applied' stays terminal.
      expect(
        run({ dbPath: tmpPath, action: "discard", mergeId: "m-done", apply: true, fenced: true }),
      ).toBe(1);

      const afterDb = new Database(tmpPath, { readonly: true });
      expect(findRow(afterDb, "m-done")?.status).toBe("applied");
      afterDb.close();
      expect(errorSpy).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledWith(
        "mergeId=m-done is already 'applied' — nothing to reconcile",
      );
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("invalid recorded leg identity"),
      );
    } finally {
      errorSpy.mockRestore();
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
      const exitCode = run({
        dbPath: tmpPath,
        action: "discard",
        mergeId: "ghost",
        apply: true,
        fenced: false,
      });
      expect(exitCode).toBe(1);
    } finally {
      cleanupDbFiles(tmpPath);
    }
  });
});
