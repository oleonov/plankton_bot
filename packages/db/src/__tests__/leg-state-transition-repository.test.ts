import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createConditionId,
  createFillId,
  createOrderId,
  createPositionId,
  createTokenId,
} from "@plankton/domain";
import { SqliteLegStateTransitionRepository } from "../repositories/leg-state-transition-repository.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    readFileSync(join(import.meta.dirname, "../migrations/040_leg_state_transitions.sql"), "utf-8"),
  );
  return db;
}

describe("SqliteLegStateTransitionRepository", () => {
  let db: Database.Database;
  let repo: SqliteLegStateTransitionRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteLegStateTransitionRepository(db);
  });

  it("inserts and reads transitions by token and position", () => {
    const tokenId = createTokenId("tok-1");
    const positionId = createPositionId("pos-1");

    expect(
      repo.insert({
        tokenId,
        positionId,
        fillId: createFillId("fill-1"),
        orderId: createOrderId("ord-1"),
        clientOrderId: "coid-1" as any,
        conditionId: createConditionId("cond-1"),
        fromPhase: "S0",
        toPhase: "S1",
        action: "BUY",
        price: 0.1,
        size: 5,
        sizeUsdc: 0.5,
        fromBuyCount: 0,
        fromSellCount: 0,
        toBuyCount: 1,
        toSellCount: 0,
        reason: "fill_received",
        occurredAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe(true);

    const byToken = repo.findByTokenId(tokenId);
    expect(byToken).toHaveLength(1);
    expect(byToken[0]).toMatchObject({
      tokenId,
      positionId,
      fillId: "fill-1",
      fromPhase: "S0",
      toPhase: "S1",
      action: "BUY",
      sizeUsdc: 0.5,
    });
    expect(repo.findByPositionId(positionId)).toHaveLength(1);
  });

  it("deduplicates fill-backed transitions by fill_id", () => {
    const transition = {
      tokenId: createTokenId("tok-1"),
      positionId: null,
      fillId: createFillId("fill-1"),
      orderId: createOrderId("ord-1"),
      clientOrderId: null,
      conditionId: createConditionId("cond-1"),
      fromPhase: "S0" as const,
      toPhase: "S1" as const,
      action: "BUY" as const,
      price: 0.1,
      size: 5,
      sizeUsdc: 0.5,
      fromBuyCount: 0,
      fromSellCount: 0,
      toBuyCount: 1,
      toSellCount: 0,
      reason: "startup_backfill",
      occurredAt: "2026-01-01T00:00:00Z",
    };

    expect(repo.insert(transition)).toBe(true);
    expect(repo.insert({ ...transition, toBuyCount: 2 })).toBe(false);
    expect(repo.findByTokenId(transition.tokenId)).toHaveLength(1);
  });
});
