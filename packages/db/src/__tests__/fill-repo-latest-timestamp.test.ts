import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bootstrapDatabase } from "../bootstrap.js";
import { SqliteFillRepository } from "../repositories/fill-repository.js";
import {
  createFillId,
  createOrderId,
  createTokenId,
  createFamilyId,
  createConditionId,
} from "@plankton/domain";
import type { Fill } from "@plankton/domain";
import type { DbConnection } from "../connection.js";

describe("SqliteFillRepository.getLatestTimestamp", () => {
  let conn: DbConnection;
  let repo: SqliteFillRepository;

  beforeEach(() => {
    conn = bootstrapDatabase(":memory:");
    repo = new SqliteFillRepository(conn.db);
    // Insert a parent order row to satisfy the fills.order_id FK constraint
    conn.db
      .prepare(
        `INSERT INTO orders (order_id, client_order_id, token_id, family_id, side, order_type, price, size, size_usdc, status, bot_run_id, created_at, updated_at)
         VALUES ('ord-1', 'cloid-1', 'tok-1', 'fam-1', 'buy', 'GTC', 0.5, 10, 5, 'open', 'run-1', datetime('now'), datetime('now'))`,
      )
      .run();
  });

  afterEach(() => {
    conn.close();
  });

  it("returns null when no fills exist", () => {
    expect(repo.getLatestTimestamp()).toBeNull();
  });

  it("returns the latest filled_at as epoch ms", () => {
    const baseFill: Fill = {
      fillId: createFillId("fill-1"),
      orderId: createOrderId("ord-1"),
      tokenId: createTokenId("tok-1"),
      conditionId: createConditionId("cond-1"),
      familyId: createFamilyId("fam-1"),
      side: "buy",
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      filledAt: "2026-01-01T00:00:00Z",
    };
    repo.save(baseFill);
    repo.save({
      ...baseFill,
      fillId: createFillId("fill-2"),
      filledAt: "2026-03-19T12:00:00.000Z",
    });

    const latest = repo.getLatestTimestamp();
    expect(latest).toBe(new Date("2026-03-19T12:00:00.000Z").getTime());
  });
});
