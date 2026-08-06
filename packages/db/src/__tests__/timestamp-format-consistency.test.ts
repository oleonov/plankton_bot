import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { bootstrapDatabase, bootstrapLedgerDb } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { ledgerInstant, parseLedgerInstantMs, toSqliteDateTime } from "../db-timestamp.js";
import { runMigrations } from "../migrations/runner.js";
import { SqliteOrderRepository } from "../repositories/order-repository.js";
import { SqliteRedeemQuarantineRepository } from "../repositories/redeem-quarantine-repository.js";
import { createOrderId, createTokenId, createConditionId, createBotRunId } from "@krabs/domain";
import type { Order, ClientOrderId } from "@krabs/domain";

/**
 * `orders.updated_at` / `positions.updated_at` must be written in ONE format.
 * The SSE change-feed (apps/api/src/routes/events.ts) polls `MAX(updated_at)` and
 * then re-reads `WHERE updated_at > ?`, so a partial UPDATE that falls back to
 * SQLite's `datetime('now')` space format is invisible to it: within a calendar
 * day `' '` (0x20) sorts below `'T'` (0x54), so an ISO row always wins the max.
 */

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let conn: DbConnection;
let tmpDir: string;
let orders: SqliteOrderRepository;
let quarantine: SqliteRedeemQuarantineRepository;

function makeOrder(overrides?: Partial<Order>): Order {
  const now = new Date().toISOString();
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "cloid-1" as ClientOrderId,
    tokenId: createTokenId("tok-1"),
    conditionId: createConditionId("cond-1"),
    side: "buy",
    orderType: "GTC",
    price: 0.55,
    size: 100,
    sizeUsdc: 55,
    status: "pending",
    exchangeOrderId: null,
    signalId: null,
    signalReason: null,
    botRunId: createBotRunId("run-1"),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** The SSE snapshot: newest `updated_at` by SQLite's own lexical ordering. */
function maxUpdatedAt(table: "orders" | "positions"): string {
  const row = conn.db.prepare(`SELECT MAX(updated_at) AS ts FROM ${table}`).get() as {
    ts: string | null;
  };
  return row.ts ?? "";
}

/** The SSE delta read that turns a snapshot change into an emitted event. */
function changedSince(table: "orders" | "positions", snapshot: string): string[] {
  const idColumn = table === "orders" ? "order_id" : "position_id";
  return (
    conn.db
      .prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE updated_at > ? ORDER BY updated_at`)
      .all(snapshot) as { id: string }[]
  ).map((r) => r.id);
}

function insertPosition(positionId: string, conditionId: string, at: string): void {
  conn.db
    .prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, current_value_usdc, status, opened_at, updated_at)
       VALUES (?, ?, ?, 'buy', 1, 1.25, 1.25, 1.25, 'open', ?, ?)`,
    )
    .run(positionId, `tok-${positionId}`, conditionId, at, at);
}

function readPositionUpdatedAt(positionId: string): string {
  const row = conn.db
    .prepare("SELECT updated_at FROM positions WHERE position_id = ?")
    .get(positionId) as { updated_at: string };
  return row.updated_at;
}

/**
 * A seed stamp guaranteed to be on the SAME UTC day as the write under test.
 * A plain `now - 1s` opens a hole: run in the first second after UTC midnight, the
 * seed lands on the PREVIOUS day, and a cross-day comparison is correct in both
 * renderings — so the ordering assertions would pass even with the writer fix
 * reverted. Clamping to the start of the current UTC day keeps the assertion about
 * FORMAT, which is the only thing it is meant to prove.
 */
function seedStampSameUtcDay(): string {
  const now = Date.now();
  const startOfUtcDay = new Date(now).setUTCHours(0, 0, 0, 0);
  return new Date(Math.max(startOfUtcDay, now - 1_000)).toISOString();
}

function readUpdatedAt(orderId: string): string {
  const row = conn.db.prepare("SELECT updated_at FROM orders WHERE order_id = ?").get(orderId) as {
    updated_at: string;
  };
  return row.updated_at;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-ts-format-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  orders = new SqliteOrderRepository(conn.db);
  quarantine = new SqliteRedeemQuarantineRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ledger timestamp format is single-valued", () => {
  it("updateStatus stamps orders.updated_at in ISO, like the insert path", () => {
    orders.save(makeOrder());
    orders.updateStatus(createOrderId("ord-1"), "cancelled");

    expect(readUpdatedAt("ord-1")).toMatch(ISO_MS);
  });

  it("updateMetadata stamps orders.updated_at in ISO, like the insert path", () => {
    orders.save(makeOrder());
    orders.updateMetadata(createOrderId("ord-1"), { note: "reconciled" });

    expect(readUpdatedAt("ord-1")).toMatch(ISO_MS);
  });

  it("a cancelled order outranks same-day ISO rows, so the SSE delta sees it", () => {
    // Production shape: `rejected` rows are written straight through the ISO insert
    // path thousands of times a day, so they pin MAX(updated_at). A cancel that
    // stamped the space format could never climb above them.
    // Both rows are stamped shortly in the past so the snapshot is strictly
    // older than the cancel — the assertion then turns on FORMAT, not on two
    // writes landing in the same millisecond.
    const justBefore = seedStampSameUtcDay();
    orders.save(
      makeOrder({
        orderId: createOrderId("ord-live"),
        clientOrderId: "cloid-live" as ClientOrderId,
        updatedAt: justBefore,
      }),
    );
    orders.save(
      makeOrder({
        orderId: createOrderId("ord-rejected"),
        clientOrderId: "cloid-rejected" as ClientOrderId,
        status: "rejected",
        updatedAt: justBefore,
      }),
    );

    const snapshot = maxUpdatedAt("orders");
    orders.updateStatus(createOrderId("ord-live"), "cancelled");

    expect(maxUpdatedAt("orders")).toBe(readUpdatedAt("ord-live"));
    expect(changedSince("orders", snapshot)).toEqual(["ord-live"]);
  });

  it("a quarantine write outranks same-day ISO rows, so the SSE delta sees it", () => {
    const justBefore = seedStampSameUtcDay();
    conn.db
      .prepare(
        `INSERT INTO positions
           (position_id, token_id, condition_id, side, size, avg_entry_price,
            cost_basis_usdc, current_value_usdc, status, opened_at, updated_at)
         VALUES (?, ?, ?, 'buy', 1, 1.25, 1.25, 1.25, 'open', ?, ?)`,
      )
      .run("pos-1", "tok-1", "cond-1", justBefore, justBefore);

    const snapshot = maxUpdatedAt("positions");
    quarantine.recordStateFailed({
      conditionId: "cond-1",
      nowTs: Date.now(),
      threshold: 2,
      ttlMs: 86_400_000,
    });

    expect(maxUpdatedAt("positions")).toMatch(ISO_MS);
    expect(changedSince("positions", snapshot)).toEqual(["pos-1"]);
  });

  it("recordBenignZeroBalanceSkip stamps positions.updated_at in ISO", () => {
    insertPosition("pos-benign", "cond-benign", new Date(Date.now() - 1_000).toISOString());

    quarantine.recordBenignZeroBalanceSkip({
      conditionId: "cond-benign",
      nowTs: Date.now(),
      ttlMs: 86_400_000,
    });

    expect(readPositionUpdatedAt("pos-benign")).toMatch(ISO_MS);
  });

  it("the shared quarantine reset writer stamps positions.updated_at in ISO", () => {
    insertPosition("pos-reset", "cond-reset", new Date(Date.now() - 1_000).toISOString());

    // clearAfterSuccess and clearExpired both delegate to the same private writer.
    quarantine.clearAfterSuccess("cond-reset");

    expect(readPositionUpdatedAt("pos-reset")).toMatch(ISO_MS);
  });
});

// Both bootstrap paths are asserted because they build these tables from DIFFERENT
// sources: `bootstrapLedgerDb` from schemas/ledger.sql, `bootstrapDatabase` from the
// migrations (029 recreates orders/fills/positions). Fixing one leaves the other.
describe.each([
  ["bootstrapLedgerDb (schemas/ledger.sql)", bootstrapLedgerDb],
  ["bootstrapDatabase (migrations)", bootstrapDatabase],
])("schema defaults cannot re-introduce the split — %s", (_label, bootstrap) => {
  // The repositories always bind the timestamp explicitly, so these DEFAULTs are
  // reachable only from a fresh DB, a manual INSERT or a future migration — which
  // is exactly how a space-format row would silently re-enter a fixed column.
  let fresh: DbConnection;
  let freshDir: string;

  beforeEach(() => {
    freshDir = mkdtempSync(path.join(tmpdir(), "krabs-ts-defaults-"));
    fresh = bootstrap(path.join(freshDir, "defaults.db"));
  });

  afterEach(() => {
    fresh.close();
    rmSync(freshDir, { recursive: true, force: true });
  });

  function insertOrder(orderId: string): void {
    fresh.db
      .prepare(
        `INSERT INTO orders
           (order_id, client_order_id, token_id, condition_id, side, order_type,
            price, size, size_usdc, status, bot_run_id)
         VALUES (?, ?, 'tok-def', 'cond-def', 'buy', 'GTC', 0.5, 10, 5, 'pending', 'run-def')`,
      )
      .run(orderId, `cloid-${orderId}`);
  }

  it("emits ISO for orders.created_at / orders.updated_at", () => {
    insertOrder("ord-def");

    const row = fresh.db
      .prepare("SELECT created_at, updated_at FROM orders WHERE order_id = 'ord-def'")
      .get() as { created_at: string; updated_at: string };

    expect(row.created_at).toMatch(ISO_MS);
    expect(row.updated_at).toMatch(ISO_MS);
  });

  it("emits ISO for fills.filled_at", () => {
    insertOrder("ord-fill");
    // No `bot_run_id`: the migration-built `fills` has no such column, so the insert
    // is restricted to the columns both schema sources agree on.
    fresh.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc)
         VALUES ('fill-def', 'ord-fill', 'tok-def', 'cond-def', 'buy', 0.5, 10, 5)`,
      )
      .run();

    const row = fresh.db
      .prepare("SELECT filled_at FROM fills WHERE fill_id = 'fill-def'")
      .get() as { filled_at: string };

    expect(row.filled_at).toMatch(ISO_MS);
  });

  it("emits ISO for positions.opened_at / positions.updated_at", () => {
    fresh.db
      .prepare(
        `INSERT INTO positions
           (position_id, token_id, condition_id, side, size, avg_entry_price,
            cost_basis_usdc, status)
         VALUES ('pos-def', 'tok-def', 'cond-def', 'buy', 1, 0.5, 0.5, 'open')`,
      )
      .run();

    const row = fresh.db
      .prepare("SELECT opened_at, updated_at FROM positions WHERE position_id = 'pos-def'")
      .get() as { opened_at: string; updated_at: string };

    expect(row.opened_at).toMatch(ISO_MS);
    expect(row.updated_at).toMatch(ISO_MS);
  });
});

describe("ledgerInstant spans every rendering the ledger carries", () => {
  const RENDERINGS = {
    iso: "2026-08-05T05:53:26.000Z",
    sqlite: "2026-08-05 05:53:26",
    gamma: "2026-08-05 05:53:26+00",
  };

  function instantOf(value: string): number | null {
    const row = conn.db.prepare(`SELECT ${ledgerInstant("?")} AS jd`).get(value) as {
      jd: number | null;
    };
    return row.jd;
  }

  it("maps all three renderings of one instant to the same value", () => {
    const iso = instantOf(RENDERINGS.iso);
    expect(iso).not.toBeNull();
    expect(instantOf(RENDERINGS.sqlite)).toBe(iso);
    expect(instantOf(RENDERINGS.gamma)).toBe(iso);
  });

  it("bare julianday() drops the Gamma rendering entirely — the reason for the wrapper", () => {
    const row = conn.db.prepare("SELECT julianday(?) AS jd").get(RENDERINGS.gamma) as {
      jd: number | null;
    };
    expect(row.jd).toBeNull();
  });

  it("keeps millisecond resolution instead of truncating to whole seconds", () => {
    expect(instantOf("2026-08-05T05:53:26.500Z")).not.toBe(instantOf(RENDERINGS.iso));
  });

  it("handles Gamma's microsecond rendering, which production actually carries", () => {
    // Census of `positions.closed_at` on the live ledger: 314 ISO-ms-Z, 300 `+00` at whole-second
    // precision, and 2 rows at SIX fractional digits (`2026-06-29 20:42:28.075833+00`). The blind
    // `replace(col,'+00','')` leaves the sub-second digits intact, and SQLite parses them, so the
    // row lands strictly between its own second and the next — asserted as an ordering rather than
    // a float equality because truncation to ms leaves ~1e-8 days of noise in the julianday value.
    const micro = instantOf("2026-08-05 05:53:26.075833+00");
    expect(micro).not.toBeNull();
    expect(micro!).toBeGreaterThan(instantOf(RENDERINGS.iso)!);
    expect(micro!).toBeLessThan(instantOf("2026-08-05T05:53:27.000Z")!);
  });
});

describe("parseLedgerInstantMs mirrors ledgerInstant on the TypeScript side", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const ISO = "2026-08-05T05:53:26.000Z";
  const SQLITE_SPACE = "2026-08-05 05:53:26";
  const GAMMA = "2026-08-05 05:53:26+00";

  it("pins the SQLite space rendering to UTC instead of the host-local timezone", () => {
    // On a UTC+7 host, bare `Date.parse` reads this zone-less shape as LOCAL time
    // (its legacy fallback parser accepts it rather than returning NaN) — asserting
    // under a non-UTC TZ is what makes a regression to bare Date.parse fail here,
    // where a UTC test host would let the bug pass by accident.
    process.env.TZ = "Asia/Bangkok";
    expect(parseLedgerInstantMs(SQLITE_SPACE)).toBe(Date.parse(ISO));
  });

  it("resolves the bare Gamma +00 offset as UTC under a non-UTC host", () => {
    process.env.TZ = "Asia/Bangkok";
    expect(parseLedgerInstantMs(GAMMA)).toBe(Date.parse(ISO));
  });

  it("leaves an already-canonical ISO-ms-Z value unchanged", () => {
    expect(parseLedgerInstantMs(ISO)).toBe(Date.parse(ISO));
  });

  it("rounds fractional seconds beyond milliseconds to the nearest millisecond", () => {
    // Production shape from positions.closed_at (see ledgerInstant's doc comment): six
    // fractional digits ROUND (`.075833` -> `.076`), not truncate. Migration 095's `strftime`
    // backfill agrees on this exact shape — the only one live data has — but the two algorithms
    // are not equivalent in general (see @krabs/domain's timestamp.test.ts divergence case).
    const micro = parseLedgerInstantMs("2026-06-29 20:42:28.075833+00");
    expect(micro).toBe(Date.parse("2026-06-29T20:42:28.076Z"));
  });

  it("returns NaN for absent or unparseable input", () => {
    expect(parseLedgerInstantMs(null)).toBeNaN();
    expect(parseLedgerInstantMs(undefined)).toBeNaN();
    expect(parseLedgerInstantMs("")).toBeNaN();
    expect(parseLedgerInstantMs("not-a-time")).toBeNaN();
  });

  it("reads a date-only value as UTC midnight, not NaN", () => {
    // The day component `-05` looks exactly like a bare `-HH` UTC offset to the zone
    // regex; padding it would yield `2026-08-05:00` and NaN. `parseTimestamp` in
    // position-cycles.ts maps NaN to 0, which would sort such a row to the very bottom
    // of the cycle list instead of onto its own day. Asserted under a non-UTC host
    // because `Date.parse` reads a date-only string as UTC regardless of the host.
    process.env.TZ = "Asia/Bangkok";
    expect(parseLedgerInstantMs("2026-08-05")).toBe(Date.parse("2026-08-05T00:00:00.000Z"));
  });
});

describe("duplicate-open repair picks the winner by instant, not by text", () => {
  it("keeps the chronologically newest leg even when the older one is ISO", () => {
    // Lexically `'2026-08-05T05:00:00.000Z'` > `'2026-08-05 06:00:00'` (`'T'` > `' '`),
    // so a text comparison would close the 06:00 row — the one findByTokenId returns.
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-ts-repair-"));
    const ledger = bootstrapLedgerDb(path.join(dir, "ledger.db"));
    try {
      ledger.db.exec("DROP INDEX IF EXISTS idx_positions_unique_open_per_token");
      const insert = ledger.db.prepare(
        `INSERT INTO positions
           (position_id, token_id, condition_id, side, size, avg_entry_price,
            cost_basis_usdc, status, opened_at, updated_at)
         VALUES (?, 'tok-dup', 'cond-dup', 'buy', 1, 0.5, 0.5, 'open', ?, ?)`,
      );
      insert.run("pos-older-iso", "2026-08-05T05:00:00.000Z", "2026-08-05T05:00:00.000Z");
      insert.run("pos-newer-space", "2026-08-05 06:00:00", "2026-08-05 06:00:00");
      ledger.close();

      const reopened = bootstrapLedgerDb(path.join(dir, "ledger.db"));
      try {
        const open = reopened.db
          .prepare("SELECT position_id FROM positions WHERE status = 'open'")
          .all() as { position_id: string }[];
        expect(open.map((r) => r.position_id)).toEqual(["pos-newer-space"]);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migration 032 does the same on the legacy merged DB that upgrades through it", () => {
    // The TypeScript repair above only guards `bootstrapLedgerDb`, which baselines 032 away.
    // `bootstrapDatabase` runs every UNAPPLIED migration against an existing legacy merged DB,
    // so an install stopped before 032 executes its UPDATE against real rows — and there
    // `opened_at` really is mixed, because 001_initial.sql:245 defaulted the column to
    // `datetime('now')` and only 029 switched it to ISO. Rewinding past the marker reproduces
    // that upgrade exactly.
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-032-upgrade-"));
    const legacy = bootstrapDatabase(path.join(dir, "legacy.db"));
    try {
      legacy.db.exec("DROP INDEX IF EXISTS idx_positions_unique_open_per_token");
      legacy.db
        .prepare("DELETE FROM schema_migrations WHERE name = ?")
        .run("032_unique_open_position_per_token.sql");

      const insert = legacy.db.prepare(
        `INSERT INTO positions
           (position_id, token_id, condition_id, side, size, avg_entry_price,
            cost_basis_usdc, status, opened_at, updated_at)
         VALUES (?, 'tok-dup-032', 'cond-dup-032', 'buy', 1, 0.5, 0.5, 'open', ?, ?)`,
      );
      insert.run("pos-older-iso", "2026-08-05T05:00:00.000Z", "2026-08-05T05:00:00.000Z");
      insert.run("pos-newer-space", "2026-08-05 06:00:00", "2026-08-05 06:00:00");

      runMigrations(legacy.db);

      const open = legacy.db
        .prepare(
          "SELECT position_id FROM positions WHERE token_id = 'tok-dup-032' AND status = 'open'",
        )
        .all() as { position_id: string }[];
      expect(open.map((r) => r.position_id)).toEqual(["pos-newer-space"]);

      // The loser must be genuinely closed with an ISO stamp, not just excluded from the index.
      const loser = legacy.db
        .prepare("SELECT status, closed_at FROM positions WHERE position_id = 'pos-older-iso'")
        .get() as { status: string; closed_at: string };
      expect(loser.status).toBe("closed");
      expect(loser.closed_at).toMatch(ISO_MS);
    } finally {
      legacy.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("toSqliteDateTime renders the same string SQLite's own datetime('now') produces", () => {
  it("renders YYYY-MM-DD HH:MM:SS for a known instant", () => {
    expect(toSqliteDateTime(Date.parse("2026-04-24T23:00:00.000Z"))).toBe("2026-04-24 23:00:00");
  });

  it("matches SQLite's own datetime(...) rendering for the same instant", () => {
    const epochMs = Date.parse("2026-04-24T23:00:00.000Z");
    const db = new Database(":memory:");
    try {
      const row = db
        .prepare("SELECT datetime(?, 'unixepoch') AS rendered")
        .get(Math.floor(epochMs / 1000)) as { rendered: string };
      expect(toSqliteDateTime(epochMs)).toBe(row.rendered);
    } finally {
      db.close();
    }
  });

  it("truncates sub-second precision instead of rounding", () => {
    expect(toSqliteDateTime(Date.parse("2026-04-24T23:00:00.999Z"))).toBe("2026-04-24 23:00:00");
  });
});
