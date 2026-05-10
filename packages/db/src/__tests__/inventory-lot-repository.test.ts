import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteInventoryLotRepository } from "../repositories/inventory-lot-repository.js";
import { createLotId, createPositionId, createTokenId, createFillId } from "@krabs/domain";
import type { InventoryLot } from "@krabs/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteInventoryLotRepository;

function insertOrder(db: Database.Database, overrides?: Partial<Record<string, unknown>>): void {
  const defaults = {
    order_id: "ord-1",
    client_order_id: "cloid-1",
    token_id: "tok-1",
    side: "buy",
    order_type: "GTC",
    price: 0.55,
    size: 100,
    size_usdc: 55,
    status: "open",
    bot_run_id: "run-1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const row = { ...defaults, ...overrides };
  db.prepare(
    `INSERT INTO orders (order_id, client_order_id, token_id, side, order_type, price, size, size_usdc, status, bot_run_id, created_at, updated_at) VALUES (@order_id, @client_order_id, @token_id, @side, @order_type, @price, @size, @size_usdc, @status, @bot_run_id, @created_at, @updated_at)`,
  ).run(row);
}

function insertFill(db: Database.Database, fillId: string, orderId: string): void {
  db.prepare(
    `INSERT INTO fills (fill_id, order_id, token_id, side, price, size, size_usdc, fee, filled_at) VALUES (?, ?, 'tok-1', 'buy', 0.55, 50, 27.5, 0, datetime('now'))`,
  ).run(fillId, orderId);
}

function insertPosition(db: Database.Database, positionId: string): void {
  db.prepare(
    `INSERT INTO positions (position_id, token_id, side, size, avg_entry_price, cost_basis_usdc, realized_pnl, status, opened_at, updated_at) VALUES (?, 'tok-1', 'buy', 100, 0.55, 55, 0, 'open', datetime('now'), datetime('now'))`,
  ).run(positionId);
}

function makeLot(overrides?: Partial<InventoryLot>): InventoryLot {
  return {
    lotId: createLotId("lot-1"),
    positionId: createPositionId("pos-1"),
    tokenId: createTokenId("tok-1"),
    side: "buy",
    size: 50,
    remainingSize: 50,
    entryPrice: 0.55,
    costUsdc: 27.5,
    fillId: createFillId("fill-1"),
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Set up prerequisite rows (order, fill, position) for lot insertion. */
function setupPrereqs(db: Database.Database): void {
  insertOrder(db);
  insertFill(db, "fill-1", "ord-1");
  insertPosition(db, "pos-1");
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteInventoryLotRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteInventoryLotRepository", () => {
  it("save + findByTokenId round-trip", () => {
    setupPrereqs(conn.db);
    const lot = makeLot();
    repo.save(lot);

    const found = repo.findByTokenId(createTokenId("tok-1"));
    expect(found).toHaveLength(1);
    expect(found[0]!.lotId).toBe("lot-1");
    expect(found[0]!.positionId).toBe("pos-1");
    expect(found[0]!.size).toBe(50);
    expect(found[0]!.remainingSize).toBe(50);
    expect(found[0]!.entryPrice).toBe(0.55);
    expect(found[0]!.fillId).toBe("fill-1");
  });

  it("findOpen returns only lots with remaining_size > 0", () => {
    setupPrereqs(conn.db);
    insertFill(conn.db, "fill-2", "ord-1");

    repo.save(
      makeLot({
        lotId: createLotId("lot-open"),
        fillId: createFillId("fill-1"),
        remainingSize: 25,
      }),
    );
    repo.save(
      makeLot({
        lotId: createLotId("lot-empty"),
        fillId: createFillId("fill-2"),
        remainingSize: 0,
      }),
    );

    const open = repo.findOpen(createPositionId("pos-1"));
    expect(open).toHaveLength(1);
    expect(open[0]!.lotId).toBe("lot-open");
  });

  it("consumeFifo basic case: one lot fully consumed", () => {
    setupPrereqs(conn.db);
    repo.save(makeLot({ size: 50, remainingSize: 50 }));

    const result = repo.consumeFifo(createPositionId("pos-1"), 50);
    expect(result).toHaveLength(1);
    expect(result[0]!.consumed).toBe(50);
    expect(result[0]!.lot.remainingSize).toBe(0);
  });

  it("consumeFifo partial: two lots, first fully consumed, second partially", () => {
    setupPrereqs(conn.db);
    insertFill(conn.db, "fill-2", "ord-1");

    repo.save(
      makeLot({
        lotId: createLotId("lot-A"),
        fillId: createFillId("fill-1"),
        size: 30,
        remainingSize: 30,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.save(
      makeLot({
        lotId: createLotId("lot-B"),
        fillId: createFillId("fill-2"),
        size: 40,
        remainingSize: 40,
        createdAt: "2026-01-02T00:00:00Z",
      }),
    );

    const result = repo.consumeFifo(createPositionId("pos-1"), 50);
    expect(result).toHaveLength(2);

    // First lot fully consumed
    expect(result[0]!.lot.lotId).toBe("lot-A");
    expect(result[0]!.consumed).toBe(30);
    expect(result[0]!.lot.remainingSize).toBe(0);

    // Second lot partially consumed
    expect(result[1]!.lot.lotId).toBe("lot-B");
    expect(result[1]!.consumed).toBe(20);
    expect(result[1]!.lot.remainingSize).toBe(20);
  });

  it("consumeFifo error: requested more than available", () => {
    setupPrereqs(conn.db);
    repo.save(makeLot({ size: 30, remainingSize: 30 }));

    expect(() => repo.consumeFifo(createPositionId("pos-1"), 100)).toThrow(
      /Insufficient inventory/,
    );
  });

  it("consumeFifo tolerates tiny floating point inventory drift", () => {
    setupPrereqs(conn.db);
    repo.save(makeLot({ size: 9.75, remainingSize: 4.119999999999999 }));

    const result = repo.consumeFifo(createPositionId("pos-1"), 4.12);

    expect(result).toHaveLength(1);
    expect(result[0]!.consumed).toBeCloseTo(4.12, 6);

    const lots = repo.findByTokenId(createTokenId("tok-1"));
    expect(lots[0]!.remainingSize).toBe(0);
  });

  it("consumeFifo still rejects inventory shortfalls beyond tolerance", () => {
    setupPrereqs(conn.db);
    repo.save(makeLot({ size: 9.75, remainingSize: 4.119 }));

    expect(() => repo.consumeFifo(createPositionId("pos-1"), 4.12)).toThrow(
      /Insufficient inventory/,
    );
  });

  it("consumeFifo updates remaining_size correctly in DB", () => {
    setupPrereqs(conn.db);
    repo.save(makeLot({ size: 100, remainingSize: 100 }));

    repo.consumeFifo(createPositionId("pos-1"), 60);

    // Verify via a fresh read
    const lots = repo.findByTokenId(createTokenId("tok-1"));
    expect(lots).toHaveLength(1);
    expect(lots[0]!.remainingSize).toBe(40);
  });
});
