import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteFillRepository } from "../repositories/fill-repository.js";
import {
  createFillId,
  createOrderId,
  createTokenId,
  createConditionId,
} from "@plankton/domain";
import type { Fill } from "@plankton/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteFillRepository;

function insertOrder(db: Database.Database, overrides?: Partial<Record<string, unknown>>): void {
  const defaults = {
    order_id: "ord-1",
    client_order_id: "cloid-1",
    token_id: "tok-1",
    family_id: "fam-1",
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
    `INSERT INTO orders (order_id, client_order_id, token_id, family_id, side, order_type, price, size, size_usdc, status, bot_run_id, created_at, updated_at) VALUES (@order_id, @client_order_id, @token_id, @family_id, @side, @order_type, @price, @size, @size_usdc, @status, @bot_run_id, @created_at, @updated_at)`,
  ).run(row);
}

function makeFill(overrides?: Partial<Fill>): Fill {
  return {
    fillId: createFillId("fill-1"),
    orderId: createOrderId("ord-1"),
    tokenId: createTokenId("tok-1"),
    conditionId: createConditionId("cond-1"),
    side: "buy",
    price: 0.55,
    size: 50,
    sizeUsdc: 27.5,
    liquidityRole: "unknown",
    fee: 0.01,
    feeRateBps: 0,
    filledAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteFillRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteFillRepository", () => {
  it("save + findByOrderId round-trip", () => {
    insertOrder(conn.db);
    const fill = makeFill();
    repo.save(fill);

    const found = repo.findByOrderId(createOrderId("ord-1"));
    expect(found).toHaveLength(1);
    expect(found[0]!.fillId).toBe("fill-1");
    expect(found[0]!.orderId).toBe("ord-1");
    expect(found[0]!.price).toBe(0.55);
    expect(found[0]!.size).toBe(50);
    expect(found[0]!.liquidityRole).toBe("unknown");
    expect(found[0]!.fee).toBe(0.01);
  });

  it("findByTokenId works", () => {
    insertOrder(conn.db, { order_id: "ord-A", client_order_id: "c-A", token_id: "tok-A" });
    insertOrder(conn.db, { order_id: "ord-B", client_order_id: "c-B", token_id: "tok-B" });

    repo.save(
      makeFill({
        fillId: createFillId("f1"),
        orderId: createOrderId("ord-A"),
        tokenId: createTokenId("tok-A"),
      }),
    );
    repo.save(
      makeFill({
        fillId: createFillId("f2"),
        orderId: createOrderId("ord-B"),
        tokenId: createTokenId("tok-B"),
      }),
    );

    const tokA = repo.findByTokenId(createTokenId("tok-A"));
    expect(tokA).toHaveLength(1);
    expect(tokA[0]!.fillId).toBe("f1");
  });

  it("findByOrderIds returns fills for all requested orders", () => {
    insertOrder(conn.db, { order_id: "ord-A", client_order_id: "c-A", token_id: "tok-A" });
    insertOrder(conn.db, { order_id: "ord-B", client_order_id: "c-B", token_id: "tok-B" });
    insertOrder(conn.db, { order_id: "ord-C", client_order_id: "c-C", token_id: "tok-C" });

    repo.save(
      makeFill({
        fillId: createFillId("f1"),
        orderId: createOrderId("ord-A"),
        tokenId: createTokenId("tok-A"),
      }),
    );
    repo.save(
      makeFill({
        fillId: createFillId("f2"),
        orderId: createOrderId("ord-B"),
        tokenId: createTokenId("tok-B"),
      }),
    );
    repo.save(
      makeFill({
        fillId: createFillId("f3"),
        orderId: createOrderId("ord-C"),
        tokenId: createTokenId("tok-C"),
      }),
    );

    const fills = repo.findByOrderIds([createOrderId("ord-A"), createOrderId("ord-C")]);

    expect(fills.map((fill) => fill.fillId).sort()).toEqual(["f1", "f3"]);
  });

  it("findRecent returns newest first with limit", () => {
    insertOrder(conn.db);

    repo.save(makeFill({ fillId: createFillId("f1"), filledAt: "2026-01-01T00:00:00Z" }));
    repo.save(makeFill({ fillId: createFillId("f2"), filledAt: "2026-01-02T00:00:00Z" }));
    repo.save(makeFill({ fillId: createFillId("f3"), filledAt: "2026-01-03T00:00:00Z" }));

    const recent = repo.findRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.fillId).toBe("f3");
    expect(recent[1]!.fillId).toBe("f2");
  });

  it("findUnreconciled returns only unreconciled fills", () => {
    insertOrder(conn.db);

    repo.save(makeFill({ fillId: createFillId("f1") }));
    repo.save(makeFill({ fillId: createFillId("f2") }));

    // All should be unreconciled initially
    expect(repo.findUnreconciled()).toHaveLength(2);
  });

  it("markReconciled marks fills and they no longer appear in findUnreconciled", () => {
    insertOrder(conn.db);

    repo.save(makeFill({ fillId: createFillId("f1") }));
    repo.save(makeFill({ fillId: createFillId("f2") }));
    repo.save(makeFill({ fillId: createFillId("f3") }));

    repo.markReconciled([createFillId("f1"), createFillId("f2")]);

    const unreconciled = repo.findUnreconciled();
    expect(unreconciled).toHaveLength(1);
    expect(unreconciled[0]!.fillId).toBe("f3");
  });

  it("markReconciled with empty array is no-op", () => {
    insertOrder(conn.db);
    repo.save(makeFill({ fillId: createFillId("f1") }));

    // Should not throw
    repo.markReconciled([]);

    expect(repo.findUnreconciled()).toHaveLength(1);
  });
});
