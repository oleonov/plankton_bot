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

// Minimal fixture for the `markets` row a token lives on. Only the columns `proveRecoveryFence`
// reads (outcome, outcome_index) vary per test; the rest are NOT NULL columns with no DEFAULT.
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

  it("refuses a settleable pair — both legs still open and predate merged_at", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-settleable",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-settleable",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-settleable",
      condition_id: "c-settleable",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    const proof = proveRecoveryFence(db, findRow(db, "m-settleable")!);
    assertRefused(proof);
    expect(proof.proven === false && proof.reason).toMatch(/p-yes/);
    expect(proof.proven === false && proof.reason).toMatch(/p-no/);
  });

  it("proves a replaced YES leg — the original closed, its replacement opened after merged_at", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-replaced",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-replaced",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes-v1",
      token_id: "t-yes",
      status: "closed",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-yes-v2",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-07-02T00:00:00.000Z", // after merged_at — the r3/r4 replacement scenario
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-replaced",
      condition_id: "c-replaced",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    const proof = proveRecoveryFence(db, findRow(db, "m-replaced")!);
    expect(proof).toEqual({ proven: true });
  });

  it("proves the fence for a sole YES leg carrying the legacy empty condition_id", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-legacy",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-legacy",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z", // old enough to pass the freshness test
      condition_id: "", // what a row written before the column existed carries
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-legacy",
      condition_id: "c-legacy",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    // findStaleMergeLeg fences this leg — it cannot show the row belongs to the condition.
    // Counting it as usable here would leave the merge with no reachable exit: the runtime
    // refuses to settle it while this command refuses to discard it.
    expect(proveRecoveryFence(db, findRow(db, "m-legacy")!)).toEqual({ proven: true });
  });

  it("proves the fence for a sole YES leg owned by a different condition", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-foreign",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-foreign",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
      condition_id: "c-somewhere-else",
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-foreign",
      condition_id: "c-foreign",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    expect(proveRecoveryFence(db, findRow(db, "m-foreign")!)).toEqual({ proven: true });
  });

  it("judges ambiguity on the owned rows — two foreign rows on a token supply no leg at all", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-two-foreign",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-two-foreign",
      outcome: "No",
      outcome_index: 1,
    });
    // Closing one of these leaves the other, which the runtime fences exactly as it fenced the
    // first — so this is not the "ambiguous now, settleable after one closes" shape.
    insertPosition(db, {
      position_id: "p-yes-a",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
      condition_id: "",
    });
    // 'dust', not a second 'open': index 032 (idx_positions_unique_open_per_token) allows only one
    // open row per token, so two open siblings would model a state the real ledger cannot hold.
    // 'dust' is still non-closed, which is what `activeLegs` selects — the raw ambiguity survives.
    insertPosition(db, {
      position_id: "p-yes-b",
      token_id: "t-yes",
      status: "dust",
      opened_at: "2026-06-02T00:00:00.000Z",
      condition_id: "c-somewhere-else",
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-two-foreign",
      condition_id: "c-two-foreign",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    expect(proveRecoveryFence(db, findRow(db, "m-two-foreign")!)).toEqual({ proven: true });
  });

  it("keeps a foreign non-closed row's live lots out of the resurrectable set", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-foreign-lots",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-foreign-lots",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes-foreign",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
      condition_id: "c-somewhere-else",
    });
    insertLot(db, { lot_id: "l-foreign", position_id: "p-yes-foreign", token_id: "t-yes" });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-foreign-lots",
      condition_id: "c-foreign-lots",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    // The resurrection branch only covers lots hanging off rows OUTSIDE the non-closed set. Moving
    // the ownership predicate into the activeLegs SQL would drop this row from that set, turn its
    // own live lot into a "resurrectable" one, and flip the proof back to a refusal.
    expect(proveRecoveryFence(db, findRow(db, "m-foreign-lots")!)).toEqual({ proven: true });
  });

  it("proves both legs consumed — only closed rows remain on either token", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-consumed",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-consumed",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes",
      token_id: "t-yes",
      status: "closed",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "closed",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-consumed",
      condition_id: "c-consumed",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    const proof = proveRecoveryFence(db, findRow(db, "m-consumed")!);
    expect(proof).toEqual({ proven: true });
  });

  it("refuses a token whose rows are all closed while a live lot still hangs off one of them", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-lots",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, { token_id: "t-no", condition_id: "c-lots", outcome: "No", outcome_index: 1 });
    insertPosition(db, {
      position_id: "p-yes",
      token_id: "t-yes",
      status: "closed",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    // A fenced discard is exactly the case where the ORIGINAL legs' lots were never consumed, so a
    // live lot under a closed row is the expected state, not a corrupt one.
    insertLot(db, { lot_id: "l-yes", position_id: "p-yes", token_id: "t-yes", remaining_size: 7 });
    insertRow(db, {
      merge_id: "m-lots",
      condition_id: "c-lots",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    // "Every row is closed" is not durable: rebuildTokenPosition picks the live lot's owner even
    // when that owner is closed, reopens it and BACKDATES opened_at past merged_at — so the token
    // comes back as an un-fenced settleable leg after this command already deleted its ledger row.
    const proof = proveRecoveryFence(db, findRow(db, "m-lots")!);
    assertRefused(proof);
    expect(proof.reason).toContain("p-yes=7");
    expect(proof.reason).toContain("rebuildTokenPosition");
  });

  it("still proves the fence when the only live lots belong to the fenced replacement itself", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-own-lots",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-own-lots",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes-v2",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-07-02T00:00:00.000Z", // the replacement findStaleMergeLeg fences
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertLot(db, {
      lot_id: "l-yes-v2",
      position_id: "p-yes-v2",
      token_id: "t-yes",
      remaining_size: 12,
    });
    insertRow(db, {
      merge_id: "m-own-lots",
      condition_id: "c-own-lots",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    // A replacement always owns live lots. Counting them would make every genuinely fenced row
    // refuse, leaving the escape hatch with no reachable use at all — the lot check is scoped to
    // owners OUTSIDE the token's non-closed set precisely so this case still passes.
    expect(proveRecoveryFence(db, findRow(db, "m-own-lots")!)).toEqual({ proven: true });
  });

  // The `lot-after` mirror. These three cover the same ground as the runtime's own fence tests in
  // apps/runtime/src/modules/inventory-auto-merge/__tests__/merge-ledger-write-ahead.test.ts, from
  // the opposite side: there the fence must FIRE, here the proof must SEE that it fires.
  it("proves the fence when a leg old enough by opened_at carries a live lot created at the merge", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-lot-after",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-lot-after",
      outcome: "No",
      outcome_index: 1,
    });
    // Exactly the consolidation aftermath: adoption backdated the replacement's opened_at to an
    // absorbed sibling's, so the freshness check above reads it as old. The lot it bought is the
    // provenance that survived, and the runtime refuses to debit it.
    insertPosition(db, {
      position_id: "p-yes",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertLot(db, {
      lot_id: "l-yes-post",
      position_id: "p-yes",
      token_id: "t-yes",
      created_at: "2026-07-01T00:00:00.000Z", // `>=`, same as the runtime
    });
    insertRow(db, {
      merge_id: "m-lot-after",
      condition_id: "c-lot-after",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    expect(proveRecoveryFence(db, findRow(db, "m-lot-after")!)).toEqual({ proven: true });
  });

  it("proves the fence for a lot second-truncated into merged_at's own second", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-lot-floor",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-lot-floor",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    // 250 ms BEFORE merged_at in wall-clock, yet the runtime fences it: `created_at` defaults to
    // `datetime('now')`, whose second resolution can only render an instant EARLIER than the one it
    // records. Both sides floor merged_at to its own second so a truncated lot still compares as
    // post-merge — without that floor this proof would say "settleable" about a fenced row.
    insertLot(db, {
      lot_id: "l-yes-floor",
      position_id: "p-yes",
      token_id: "t-yes",
      created_at: "2026-07-01T00:00:00.500Z",
    });
    insertRow(db, {
      merge_id: "m-lot-floor",
      condition_id: "c-lot-floor",
      merged_at: "2026-07-01T00:00:00.750Z",
      status: "onchain",
    });

    expect(proveRecoveryFence(db, findRow(db, "m-lot-floor")!)).toEqual({ proven: true });
  });

  it("refuses to prove the fence on a lot whose created_at it cannot read, even though the runtime fences it", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-lot-unreadable",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-lot-unreadable",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    // The space form the `datetime('now')` column DEFAULT actually writes. The runtime's reader is
    // tolerant of it and fails CLOSED anyway, so it fences this leg; canonicalIsoMs rejects it
    // outright. The asymmetry is deliberate and must stay in THIS direction: an unreadable lot costs
    // one operator escalation, while accepting it as proof would delete a settleable ledger row.
    insertLot(db, {
      lot_id: "l-yes-space",
      position_id: "p-yes",
      token_id: "t-yes",
      created_at: "2026-07-01 00:00:02",
    });
    insertRow(db, {
      merge_id: "m-lot-unreadable",
      condition_id: "c-lot-unreadable",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    const proof = proveRecoveryFence(db, findRow(db, "m-lot-unreadable")!);
    assertRefused(proof);
    expect(proof.reason).toContain("t-yes (p-yes, opened_at=2026-06-01T00:00:00.000Z)");
  });

  it("refuses a usable leg on a token it cannot map to YES or NO — a later upsert makes it settleable", () => {
    insertMarket(db, {
      token_id: "t-dem",
      condition_id: "c-unclassified",
      outcome: "Democrat",
      outcome_index: null,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-unclassified",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-dem",
      token_id: "t-dem",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-unclassified",
      condition_id: "c-unclassified",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    // Dropping the unmapped leg would silently empty the YES side and read as proof. An ordinary
    // market upsert filling outcome_index turns that very row into a leg findMergeCandidates derives.
    const proof = proveRecoveryFence(db, findRow(db, "m-unclassified")!);
    assertRefused(proof);
    expect(proof.reason).toContain("t-dem");
    expect(proof.reason).toContain('"Democrat"');
    expect(proof.reason).toContain("outcome_index");
  });

  it("proves a replacement opened in merged_at's own millisecond — the mirror of findStaleMergeLeg's >=", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-same-ms",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-same-ms",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes-v2",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-07-01T00:00:00.000Z", // EQUAL to merged_at
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-same-ms",
      condition_id: "c-same-ms",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    // The runtime fences an equal instant too, so reporting this leg usable would refuse the exact
    // stuck row --fenced exists for. The CLI's one-sidedness applies to UNCERTAINTY, not to
    // reproducing a predicate it knows.
    expect(proveRecoveryFence(db, findRow(db, "m-same-ms")!)).toEqual({ proven: true });
  });

  it("refuses an ambiguous YES token — ambiguousTokens() skips it only until one row closes", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-ambiguous",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-ambiguous",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes-open",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-yes-dust",
      token_id: "t-yes",
      status: "dust",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-ambiguous",
      condition_id: "c-ambiguous",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    // Both rows predate merged_at, so neither is a replacement findStaleMergeLeg would fence.
    // Recovery skips the token TODAY, but startup adoption or dust abandonment closes one of the two
    // and the survivor becomes a settleable leg — proving the fence off a transient state is exactly
    // the delete-wins race the proof exists to prevent.
    const proof = proveRecoveryFence(db, findRow(db, "m-ambiguous")!);
    assertRefused(proof);
    expect(proof.proven === false && proof.reason).toContain("p-yes-open + p-yes-dust");
  });

  it("refuses symmetrically when it is the NO token that carries the two non-closed rows", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-ambiguous-no",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-ambiguous-no",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes-open",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no-open",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no-dust",
      token_id: "t-no",
      status: "dust",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-ambiguous-no",
      condition_id: "c-ambiguous-no",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    const proof = proveRecoveryFence(db, findRow(db, "m-ambiguous-no")!);
    assertRefused(proof);
    expect(proof.proven === false && proof.reason).toContain("p-no-open + p-no-dust");
  });

  it("refuses a non-canonical opened_at — uncertainty resolves toward usable, not toward the delete", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-noncanonical-opened",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-noncanonical-opened",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes",
      token_id: "t-yes",
      status: "open",
      // SQLite space form, later in wall-clock terms than merged_at — but canonicalIsoMs cannot
      // parse it, so the proof cannot reproduce the runtime's freshness comparison for this leg.
      opened_at: "2026-07-01 00:00:00",
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-noncanonical-opened",
      condition_id: "c-noncanonical-opened",
      merged_at: "2026-06-15T00:00:00.000Z",
      status: "onchain",
    });

    const proof = proveRecoveryFence(db, findRow(db, "m-noncanonical-opened")!);
    assertRefused(proof);
  });

  it("refuses a non-canonical merged_at even when both legs are otherwise fully fenced", () => {
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-noncanonical-merged",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-noncanonical-merged",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-yes",
      token_id: "t-yes",
      status: "closed",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "closed",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-noncanonical-merged",
      condition_id: "c-noncanonical-merged",
      merged_at: "2026-07-01 00:00:00", // SQLite space form, not the runtime's canonical ISO
      status: "onchain",
    });

    const proof = proveRecoveryFence(db, findRow(db, "m-noncanonical-merged")!);
    assertRefused(proof);
    expect(proof.proven === false && proof.reason).toMatch(/merged_at/);
  });

  it("refuses when the condition has no markets rows — an ingestion gap is not proof of a fence", () => {
    // A position exists, but on a token that is not linked to this condition_id via `markets` — the
    // proof must still refuse, since it cannot identify which legs the merge moved.
    insertPosition(db, {
      position_id: "p-orphan",
      token_id: "t-orphan",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-no-markets",
      condition_id: "c-no-markets",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    const proof = proveRecoveryFence(db, findRow(db, "m-no-markets")!);
    assertRefused(proof);
  });

  it("refuses when markets names only the YES side — the empty NO side is a catalog gap, not a fence", () => {
    // The dangerous shape, and an ordinary one: on the live ledger 2026-08-11, 33 of the 72
    // conditions holding an open position have `markets` rows for one side only. The YES leg here
    // is live and predates merged_at, so the moment a scanner upsert supplies the NO row the pair
    // findMergeCandidates derives is the ORIGINAL pair the on-chain merge already moved.
    insertMarket(db, {
      token_id: "t-yes",
      condition_id: "c-one-sided",
      outcome: "Yes",
      outcome_index: 0,
    });
    insertPosition(db, {
      position_id: "p-yes",
      token_id: "t-yes",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-one-sided",
      condition_id: "c-one-sided",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    const proof = proveRecoveryFence(db, findRow(db, "m-one-sided")!);
    assertRefused(proof);
    expect(proof.reason).toContain("NO: none");
    expect(proof.reason).toContain("t-yes");
  });

  it("refuses symmetrically when it is the YES side that markets does not name", () => {
    insertMarket(db, {
      token_id: "t-no",
      condition_id: "c-no-only",
      outcome: "No",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-no",
      token_id: "t-no",
      status: "closed",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-no-only",
      condition_id: "c-no-only",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    // Every row on the named side is closed, so the old shape read "no usable NO leg" as proof even
    // though the side that could supply one was simply absent from the catalog.
    const proof = proveRecoveryFence(db, findRow(db, "m-no-only")!);
    assertRefused(proof);
    expect(proof.reason).toContain("YES: none");
  });

  // The three tests below share one shape: `markets` names BOTH sides of the condition (so the
  // catalog refusal above does not fire), the NO side holds no position at all, and the YES side
  // holds a usable leg — the exact state the proof reads as "one side is empty, so recovery can
  // never pair them" and returns proven. What varies is whether the condition ALSO owns a position
  // whose token is currently mapped somewhere else.
  function seedBothSidedCondition(conditionId: string, mergeId: string): void {
    insertMarket(db, { token_id: `${conditionId}-yes`, condition_id: conditionId, outcome: "Yes" });
    insertMarket(db, { token_id: `${conditionId}-no`, condition_id: conditionId, outcome: "No" });
    insertPosition(db, {
      position_id: `p-${conditionId}-yes`,
      token_id: `${conditionId}-yes`,
      condition_id: conditionId,
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: mergeId,
      condition_id: conditionId,
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });
  }

  it("refuses when the condition owns a non-closed position whose token markets no longer names", () => {
    // A scanner upsert moved the NO leg's token to another condition (UPSERT_MARKET_SQL rewrites
    // markets.condition_id wholesale), so the empty NO side is an artifact of the catalog, not of
    // the ledger. Deleting here would leave nothing to fence the pair once the token is mapped
    // back — findMergeCandidates would re-derive the ORIGINAL pair and merge it a second time on
    // chain. positions.condition_id is the anchor because no market upsert rewrites it.
    seedBothSidedCondition("c-displaced", "m-displaced");
    insertPosition(db, {
      position_id: "p-moved",
      token_id: "t-moved",
      condition_id: "c-displaced",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertMarket(db, { token_id: "t-moved", condition_id: "c-elsewhere", outcome: "No" });

    const proof = proveRecoveryFence(db, findRow(db, "m-displaced")!);
    assertRefused(proof);
    expect(proof.reason).toContain("t-moved");
    expect(proof.reason).toContain("p-moved");
  });

  it("refuses a displaced leg that is closed but still holds live FIFO lots", () => {
    // Same durability notion describeUsableLeg applies to non-displaced tokens: startup adoption
    // reopens a closed owner that still has remaining_size > 0, so "closed" is not the end state.
    seedBothSidedCondition("c-displaced-lots", "m-displaced-lots");
    insertPosition(db, {
      position_id: "p-moved-closed",
      token_id: "t-moved-closed",
      condition_id: "c-displaced-lots",
      status: "closed",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertLot(db, {
      lot_id: "l-moved-closed",
      position_id: "p-moved-closed",
      token_id: "t-moved-closed",
    });

    const proof = proveRecoveryFence(db, findRow(db, "m-displaced-lots")!);
    assertRefused(proof);
    expect(proof.reason).toContain("t-moved-closed");
  });

  it("still refuses a displaced leg when the condition also owns a markets row with a NULL token_id", () => {
    // final5-P1-4. `markets.token_id` is a bare `TEXT PRIMARY KEY` (packages/db/src/schemas/
    // ledger.sql:11) and SQLite's legacy rowid-table quirk lets a non-INTEGER PRIMARY KEY hold NULL.
    // With `NOT IN`, one such row makes every comparison in the subquery UNKNOWN instead of TRUE —
    // the displaced query returns zero rows and the refusal silently disables itself, which is
    // exactly the failure mode a fail-closed proof must not have. This command runs against an
    // arbitrary on-disk ledger, so the schema's own permissiveness is the reachability argument.
    seedBothSidedCondition("c-null-token", "m-null-token");
    insertPosition(db, {
      position_id: "p-moved-null",
      token_id: "t-moved-null",
      condition_id: "c-null-token",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertMarket(db, { token_id: "t-moved-null", condition_id: "c-elsewhere-null", outcome: "No" });
    db.prepare(
      `INSERT INTO markets (token_id, condition_id, slug, question, outcome, outcome_index, tick_size)
       VALUES (NULL, 'c-null-token', 'slug-null', 'question-null', 'Yes', NULL, 0.01)`,
    ).run();

    const proof = proveRecoveryFence(db, findRow(db, "m-null-token")!);
    assertRefused(proof);
    expect(proof.reason).toContain("t-moved-null");
  });

  it("still proves the fence when nothing is displaced — the check must not refuse the normal shape", () => {
    // The escape hatch has to stay reachable: every position anchored to the condition sits on a
    // token markets still names, and the legacy row below carries the schema's default empty
    // condition_id, which never equals a real condition and so cannot make this refuse.
    seedBothSidedCondition("c-not-displaced", "m-not-displaced");
    insertPosition(db, {
      position_id: "p-legacy",
      token_id: "t-legacy",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });

    expect(proveRecoveryFence(db, findRow(db, "m-not-displaced")!).proven).toBe(true);
  });

  it("classifies by outcome_index when the outcome text itself is not YES/NO", () => {
    insertMarket(db, {
      token_id: "t-dem",
      condition_id: "c-index-based",
      outcome: "Democrat",
      outcome_index: 0,
    });
    insertMarket(db, {
      token_id: "t-rep",
      condition_id: "c-index-based",
      outcome: "Republican",
      outcome_index: 1,
    });
    insertPosition(db, {
      position_id: "p-dem",
      token_id: "t-dem",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertPosition(db, {
      position_id: "p-rep",
      token_id: "t-rep",
      status: "open",
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    insertRow(db, {
      merge_id: "m-index-based",
      condition_id: "c-index-based",
      merged_at: "2026-07-01T00:00:00.000Z",
      status: "onchain",
    });

    const proof = proveRecoveryFence(db, findRow(db, "m-index-based")!);
    assertRefused(proof);
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
      // recovery has fenced the row: the runtime refuses it on every boot that re-derives the same
      // legs. The refusal must instead point at the --fenced escape hatch.
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
    // Replaced-YES-leg scenario: the original YES leg closed and was replaced by one opened AFTER
    // merged_at — exactly the state findStaleMergeLeg fences on, so this row must never be settled.
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
    insertRow(db, { merge_id: "m-done", status: "applied" });
    db.close();

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
