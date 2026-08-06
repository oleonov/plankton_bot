import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../migrations/runner.js";

const MIGRATION = "095_normalize_legacy_timestamp_renderings.sql";

/**
 * Re-run migration 095 against rows seeded AFTER the initial bootstrap.
 *
 * `runMigrations` applies 095 to the empty tables it just created, so seeding first is not an
 * option — dropping its marker is what lets the real migration file (not a copy of its SQL) run
 * against the fixture. Calling this twice is also how idempotency is exercised.
 */
function reapplyMigration095(db: Database.Database): void {
  db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(MIGRATION);
  runMigrations(db);
}

function seedOrder(
  db: Database.Database,
  orderId: string,
  updatedAt: string,
  createdAt = "2026-04-01T00:00:00.000Z",
): void {
  db.prepare(
    `INSERT INTO orders
       (order_id, client_order_id, token_id, side, order_type, price, size, size_usdc,
        bot_run_id, created_at, updated_at)
     VALUES (?, ?, ?, 'buy', 'limit', 0.4, 10, 4, 'run-1', ?, ?)`,
  ).run(orderId, `coid-${orderId}`, `token-${orderId}`, createdAt, updatedAt);
}

function seedFill(db: Database.Database, fillId: string, orderId: string, filledAt: string): void {
  db.prepare(
    `INSERT INTO fills
       (fill_id, order_id, token_id, side, price, size, size_usdc, filled_at)
     VALUES (?, ?, ?, 'buy', 0.4, 10, 4, ?)`,
  ).run(fillId, orderId, `token-${fillId}`, filledAt);
}

function seedPosition(
  db: Database.Database,
  positionId: string,
  updatedAt: string,
  closedAt: string | null,
  openedAt = "2026-04-01T00:00:00.000Z",
): void {
  db.prepare(
    `INSERT INTO positions
       (position_id, token_id, side, status, opened_at, closed_at, updated_at)
     VALUES (?, ?, 'buy', 'closed', ?, ?, ?)`,
  ).run(positionId, `token-${positionId}`, openedAt, closedAt, updatedAt);
}

function seedResolution(db: Database.Database, conditionId: string, resolvedAt: string): void {
  db.prepare(
    `INSERT INTO market_resolutions
       (condition_id, resolution, resolved_at, detected_at, source)
     VALUES (?, 'YES', ?, '2026-04-01T00:00:00.000Z', 'gamma')`,
  ).run(conditionId, resolvedAt);
}

function resolvedAt(db: Database.Database, conditionId: string): string {
  return (
    db
      .prepare("SELECT resolved_at AS t FROM market_resolutions WHERE condition_id = ?")
      .get(conditionId) as { t: string }
  ).t;
}

function seedSettlement(
  db: Database.Database,
  settlementId: string,
  resolution: string,
  settledAt: string,
): void {
  db.prepare(
    `INSERT INTO settlement_ledger
       (settlement_id, condition_id, position_id, token_id,
        resolution, settlement_price, size, delta, settled_at)
     VALUES (?, 'cond-settle', 'pos-settle', 'token-settle', ?, 1.0, 1, 0.5, ?)`,
  ).run(settlementId, resolution, settledAt);
}

function settledAt(db: Database.Database, settlementId: string): string {
  return (
    db
      .prepare("SELECT settled_at AS t FROM settlement_ledger WHERE settlement_id = ?")
      .get(settlementId) as { t: string }
  ).t;
}

function orderUpdatedAt(db: Database.Database, orderId: string): string {
  return (
    db.prepare("SELECT updated_at AS t FROM orders WHERE order_id = ?").get(orderId) as {
      t: string;
    }
  ).t;
}

function orderCreatedAt(db: Database.Database, orderId: string): string {
  return (
    db.prepare("SELECT created_at AS t FROM orders WHERE order_id = ?").get(orderId) as {
      t: string;
    }
  ).t;
}

function filledAt(db: Database.Database, fillId: string): string {
  return (
    db.prepare("SELECT filled_at AS t FROM fills WHERE fill_id = ?").get(fillId) as { t: string }
  ).t;
}

function seedMarket(db: Database.Database, tokenId: string, updatedAt: string): void {
  db.prepare(
    `INSERT INTO markets
       (token_id, condition_id, slug, question, outcome, tick_size, updated_at)
     VALUES (?, ?, ?, ?, 'YES', 0.01, ?)`,
  ).run(tokenId, `cond-${tokenId}`, `slug-${tokenId}`, `question-${tokenId}`, updatedAt);
}

function marketUpdatedAt(db: Database.Database, tokenId: string): string {
  return (
    db.prepare("SELECT updated_at AS t FROM markets WHERE token_id = ?").get(tokenId) as {
      t: string;
    }
  ).t;
}

function positionRow(
  db: Database.Database,
  positionId: string,
): { updated_at: string; closed_at: string | null } {
  return db
    .prepare("SELECT updated_at, closed_at FROM positions WHERE position_id = ?")
    .get(positionId) as { updated_at: string; closed_at: string | null };
}

function openedAt(db: Database.Database, positionId: string): string {
  return (
    db.prepare("SELECT opened_at AS t FROM positions WHERE position_id = ?").get(positionId) as {
      t: string;
    }
  ).t;
}

describe("migration 095 — legacy timestamp renderings", () => {
  it("normalizes every legacy rendering, keeps NULL and unparseable values, and is idempotent", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    seedOrder(db, "iso", "2026-08-05T07:54:37.742Z");
    seedOrder(db, "space", "2026-08-05 08:53:21");
    seedOrder(db, "garbage", "not-a-timestamp");
    seedPosition(db, "gamma-sec", "2026-08-04 22:29:18", "2026-08-05 05:53:26+00");
    seedPosition(db, "gamma-micro", "2026-08-04T22:29:18.000Z", "2026-06-29 20:42:28.075833+00");
    seedPosition(db, "open", "2026-08-04T22:29:18.000Z", null);

    reapplyMigration095(db);

    // Already canonical — must not move.
    expect(orderUpdatedAt(db, "iso")).toBe("2026-08-05T07:54:37.742Z");
    // SQLite space (19 ch) → canonical, same instant.
    expect(orderUpdatedAt(db, "space")).toBe("2026-08-05T08:53:21.000Z");
    // Unparseable: `strftime` yields NULL, and the guard drops the row rather than nulling a
    // real value. `updated_at` is NOT NULL, so an unguarded rewrite would abort the migration
    // and with it the whole bootstrap.
    expect(orderUpdatedAt(db, "garbage")).toBe("not-a-timestamp");

    expect(positionRow(db, "gamma-sec")).toEqual({
      updated_at: "2026-08-04T22:29:18.000Z",
      closed_at: "2026-08-05T05:53:26.000Z",
    });
    // Gamma microsecond (29 ch) rounds to milliseconds — the only lossy case, sub-millisecond.
    expect(positionRow(db, "gamma-micro").closed_at).toBe("2026-06-29T20:42:28.076Z");
    // A NULL closed_at is an OPEN position, not a missing timestamp: `NULL NOT GLOB '…'` is NULL,
    // never true, so the row is never selected.
    expect(positionRow(db, "open").closed_at).toBeNull();

    // Row-count invariance: a rewrite must never lose or duplicate a row.
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM positions").get()).toEqual({ n: 3 });

    const afterFirst = db
      .prepare("SELECT order_id, updated_at FROM orders ORDER BY order_id")
      .all();
    const positionsAfterFirst = db
      .prepare("SELECT position_id, updated_at, closed_at FROM positions ORDER BY position_id")
      .all();

    reapplyMigration095(db);

    expect(db.prepare("SELECT order_id, updated_at FROM orders ORDER BY order_id").all()).toEqual(
      afterFirst,
    );
    expect(
      db
        .prepare("SELECT position_id, updated_at, closed_at FROM positions ORDER BY position_id")
        .all(),
    ).toEqual(positionsAfterFirst);
  });

  it("restores MAX(updated_at) to the chronologically newest row", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    // 08:53:21 is the later instant, but `' '` (0x20) sorts below `'T'` (0x54), so on a split
    // column the lexical maximum is the EARLIER row. That inversion is what stalled the SSE
    // order:filled / order:cancelled stream, which polls `updated_at > lastSeen`.
    seedOrder(db, "iso", "2026-08-05T07:54:37.742Z");
    seedOrder(db, "space", "2026-08-05 08:53:21");
    expect(db.prepare("SELECT MAX(updated_at) AS t FROM orders").get()).toEqual({
      t: "2026-08-05T07:54:37.742Z",
    });

    reapplyMigration095(db);

    expect(db.prepare("SELECT MAX(updated_at) AS t FROM orders").get()).toEqual({
      t: "2026-08-05T08:53:21.000Z",
    });
  });

  it("normalizes market_resolutions.resolved_at, the SOURCE that re-splits closed_at", () => {
    // `RedeemSweepModule.closeLocalPositions` reads this column and hands it verbatim to
    // `PositionSettler.settleOne`, which writes it into `positions.closed_at`. A market that
    // resolved BEFORE this deploy but settles AFTER it would therefore re-split the column
    // this migration just cleaned — and `MarketResolutionRepository.save` is
    // `ON CONFLICT(condition_id) DO NOTHING`, so the fixed Gamma ingress never rewrites it.
    const db = new Database(":memory:");
    runMigrations(db);

    seedResolution(db, "cond-gamma-sec", "2026-08-05 05:53:26+00");
    seedResolution(db, "cond-gamma-micro", "2026-06-29 20:42:28.075833+00");
    // 20 ch, seen only in this column: `resolvedAt = info.closedTime` off a Gamma payload with
    // no sub-second component. SQLite accepts the bare `Z`, so the instant is preserved exactly.
    seedResolution(db, "cond-iso-no-ms", "2026-05-18T12:00:00Z");
    seedResolution(db, "cond-canonical", "2026-08-05T07:54:37.742Z");
    seedResolution(db, "cond-garbage", "not-a-timestamp");

    reapplyMigration095(db);

    expect(resolvedAt(db, "cond-gamma-sec")).toBe("2026-08-05T05:53:26.000Z");
    expect(resolvedAt(db, "cond-gamma-micro")).toBe("2026-06-29T20:42:28.076Z");
    expect(resolvedAt(db, "cond-iso-no-ms")).toBe("2026-05-18T12:00:00.000Z");
    expect(resolvedAt(db, "cond-canonical")).toBe("2026-08-05T07:54:37.742Z");
    // `resolved_at` is NOT NULL: an unguarded rewrite of an unparseable value would abort the
    // migration and with it the whole bootstrap.
    expect(resolvedAt(db, "cond-garbage")).toBe("not-a-timestamp");

    const afterFirst = db
      .prepare("SELECT condition_id, resolved_at FROM market_resolutions ORDER BY condition_id")
      .all();
    expect(afterFirst).toHaveLength(5);

    reapplyMigration095(db);

    expect(
      db
        .prepare("SELECT condition_id, resolved_at FROM market_resolutions ORDER BY condition_id")
        .all(),
    ).toEqual(afterFirst);
  });

  it("normalizes settlement_ledger.settled_at, the second sink resolved_at feeds", () => {
    // `PositionSettler.settleOne` writes ONE `resolution.resolvedAt` into both `positions.closed_at`
    // and `settled_at`, so this column carries the same 302 legacy rows. No reader is wrong today:
    // the one raw comparison (`findAlgoRedeemSettlementsSince`) is confined to the `algo-redeem`
    // partition, which `settleAlgoRedeem` stamps with `new Date().toISOString()`. Normalizing
    // anyway is what stops that from being an accident of a single WHERE clause.
    const db = new Database(":memory:");
    runMigrations(db);

    // `settlement_ledger` carries FKs to both parents, so a settlement row cannot exist without
    // them. Both are seeded canonical: this test isolates `settled_at`, not the parent columns.
    seedResolution(db, "cond-settle", "2026-04-22T18:31:41.346Z");
    seedPosition(db, "pos-settle", "2026-04-22T18:31:41.346Z", "2026-04-22T18:31:41.346Z");

    seedSettlement(db, "s-gamma-sec", "Yes", "2026-08-05 05:53:26+00");
    seedSettlement(db, "s-gamma-micro", "No", "2026-06-29 20:42:28.075833+00");
    seedSettlement(db, "s-algo-redeem", "algo-redeem", "2026-04-22T18:31:41.346Z");

    reapplyMigration095(db);

    expect(settledAt(db, "s-gamma-sec")).toBe("2026-08-05T05:53:26.000Z");
    expect(settledAt(db, "s-gamma-micro")).toBe("2026-06-29T20:42:28.076Z");
    expect(settledAt(db, "s-algo-redeem")).toBe("2026-04-22T18:31:41.346Z");

    // The normalized legacy row now sorts ABOVE a same-day canonical one, which is the whole
    // point: before the rewrite `'2026-08-05 05:53:26+00'` lost to any `'2026-08-05T…'` row.
    seedSettlement(db, "s-same-day", "algo-redeem", "2026-08-05T05:00:00.000Z");
    expect(db.prepare("SELECT MAX(settled_at) AS t FROM settlement_ledger").get()).toEqual({
      t: "2026-08-05T05:53:26.000Z",
    });
  });

  it("leaves the exit_owner triggers unfired — they guard `UPDATE OF exit_owner` only", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    // A sticky owner plus a legacy rendering on the same row: if the rewrite named exit_owner in
    // its SET clause, `trg_positions_exit_owner_immutable` would RAISE(ABORT) and take the whole
    // bootstrap down. 302 production rows sit in exactly this shape.
    db.prepare(
      `INSERT INTO positions
         (position_id, token_id, side, status, exit_owner, opened_at, closed_at, updated_at)
       VALUES ('p-owned', 'token-owned', 'buy', 'closed', 'bounce',
               '2026-04-01T00:00:00.000Z', '2026-08-05 05:53:26+00', '2026-08-04 22:29:18')`,
    ).run();

    expect(() => reapplyMigration095(db)).not.toThrow();

    expect(
      db.prepare("SELECT exit_owner, closed_at FROM positions WHERE position_id = 'p-owned'").get(),
    ).toEqual({ exit_owner: "bounce", closed_at: "2026-08-05T05:53:26.000Z" });
  });

  // FAILS against the original 5-UPDATE version of 095 (no markets.updated_at statement): the
  // space-form row would still read back as 19 chars and MAX() would still pick the wrong row.
  it("normalizes markets.updated_at, the audit's THIRD missed column (no comparative reader today)", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    seedMarket(db, "m-space", "2026-08-05 05:58:10");
    seedMarket(db, "m-canonical", "2026-08-05T07:54:37.742Z");
    seedMarket(db, "m-garbage", "not-a-timestamp");

    reapplyMigration095(db);

    expect(marketUpdatedAt(db, "m-space")).toBe("2026-08-05T05:58:10.000Z");
    expect(marketUpdatedAt(db, "m-canonical")).toBe("2026-08-05T07:54:37.742Z");
    // `updated_at` is NOT NULL: an unguarded rewrite of an unparseable value would abort the
    // migration and with it the whole bootstrap.
    expect(marketUpdatedAt(db, "m-garbage")).toBe("not-a-timestamp");

    // The normalized row now sorts ABOVE a same-day canonical one — before the rewrite
    // `'2026-08-05 05:58:10'` lost to any `'2026-08-05T…'` row, same defect as orders.updated_at.
    // (`m-garbage` is excluded here: its unparseable value legitimately sorts highest of all as
    // plain TEXT — that is a property of garbage data, not of this migration.)
    expect(
      db.prepare("SELECT MAX(updated_at) AS t FROM markets WHERE token_id != 'm-garbage'").get(),
    ).toEqual({
      t: "2026-08-05T07:54:37.742Z",
    });

    const afterFirst = db
      .prepare("SELECT token_id, updated_at FROM markets ORDER BY token_id")
      .all();

    reapplyMigration095(db);

    expect(db.prepare("SELECT token_id, updated_at FROM markets ORDER BY token_id").all()).toEqual(
      afterFirst,
    );
  });

  // These three match zero rows on the live ledger — every reader-compared column above already
  // does. They exist for the legacy `bootstrapDatabase` upgrade path: migration 029 copies
  // orders/fills/positions columns VERBATIM out of the pre-029 tables, so a DB upgraded through
  // that path carries whatever rendering `001_initial.sql`'s `DEFAULT (datetime('now'))` wrote —
  // SQLite-space, not ISO. See the migration header.
  it("normalizes orders.created_at, fills.filled_at and positions.opened_at (legacy bootstrapDatabase path)", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    seedOrder(db, "legacy-created", "2026-04-01T00:00:00.000Z", "2026-08-04 22:29:18");
    seedOrder(db, "canonical-created", "2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z");

    // `fills.order_id` REFERENCES `orders`; this parent is canonical and unrelated to the
    // filled_at assertions below, isolating this test to filled_at the same way the settlement
    // test isolates settled_at from its own parent columns.
    seedOrder(db, "fk-parent", "2026-04-01T00:00:00.000Z");
    seedFill(db, "legacy-filled", "fk-parent", "2026-08-04 22:29:18");
    seedFill(db, "canonical-filled", "fk-parent", "2026-04-01T00:00:00.000Z");

    seedPosition(db, "legacy-opened", "2026-04-01T00:00:00.000Z", null, "2026-08-04 22:29:18");
    seedPosition(
      db,
      "canonical-opened",
      "2026-04-01T00:00:00.000Z",
      null,
      "2026-04-01T00:00:00.000Z",
    );

    reapplyMigration095(db);

    expect(orderCreatedAt(db, "legacy-created")).toBe("2026-08-04T22:29:18.000Z");
    // Already canonical — must not move.
    expect(orderCreatedAt(db, "canonical-created")).toBe("2026-04-01T00:00:00.000Z");

    expect(filledAt(db, "legacy-filled")).toBe("2026-08-04T22:29:18.000Z");
    expect(filledAt(db, "canonical-filled")).toBe("2026-04-01T00:00:00.000Z");

    expect(openedAt(db, "legacy-opened")).toBe("2026-08-04T22:29:18.000Z");
    expect(openedAt(db, "canonical-opened")).toBe("2026-04-01T00:00:00.000Z");

    const afterFirst = {
      created: [orderCreatedAt(db, "legacy-created"), orderCreatedAt(db, "canonical-created")],
      filled: [filledAt(db, "legacy-filled"), filledAt(db, "canonical-filled")],
      opened: [openedAt(db, "legacy-opened"), openedAt(db, "canonical-opened")],
    };

    reapplyMigration095(db);

    expect({
      created: [orderCreatedAt(db, "legacy-created"), orderCreatedAt(db, "canonical-created")],
      filled: [filledAt(db, "legacy-filled"), filledAt(db, "canonical-filled")],
      opened: [openedAt(db, "legacy-opened"), openedAt(db, "canonical-opened")],
    }).toEqual(afterFirst);
  });
});
