import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConditionId, createOrderId, createPositionId, createTokenId } from "@krabs/domain";
import { bootstrapLedgerDb } from "../../bootstrap.js";
import type { DbConnection } from "../../connection.js";
import { SqliteFloorIntentRepository } from "../floor-intents.js";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteFloorIntentRepository;

const TOKEN_ID = createTokenId("track-c-token-1");
const CONDITION_ID = createConditionId("track-c-condition-1");
const POSITION_ID = createPositionId("track-c-position-1");
const ORDER_ID = createOrderId("track-c-order-1");

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-floor-intents-"));
  conn = bootstrapLedgerDb(path.join(tmpDir, "ledger.db"));
  repo = new SqliteFloorIntentRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteFloorIntentRepository", () => {
  it("inserts and reads an active floor intent", () => {
    const result = repo.insertActive(baseInput());

    expect(result.inserted).toBe(true);
    expect(repo.findActiveByTokenId(TOKEN_ID)).toMatchObject({
      tokenId: TOKEN_ID,
      conditionId: CONDITION_ID,
      positionId: POSITION_ID,
      sourceOrderId: ORDER_ID,
      status: "active",
      targetPrice: 0.1,
      attemptCount: 0,
    });
  });

  it("enforces one active intent per token via insert-if-absent", () => {
    expect(repo.insertActive(baseInput()).inserted).toBe(true);
    expect(repo.insertActive({ ...baseInput(), targetPrice: 0.09 })).toMatchObject({
      inserted: false,
    });

    const activeRows = conn.db
      .prepare(
        "SELECT COUNT(*) AS count FROM floor_intents WHERE token_id = ? AND status = 'active'",
      )
      .get(String(TOKEN_ID)) as { count: number };
    expect(activeRows.count).toBe(1);
  });

  it("atomically consumes an active intent once", () => {
    repo.insertActive(baseInput());

    expect(
      repo.consumeActive(TOKEN_ID, {
        consumedAt: "2026-06-03T01:00:00.000Z",
        consumingOrderId: createOrderId("replacement-order"),
      }),
    ).toBe(true);
    expect(
      repo.consumeActive(TOKEN_ID, {
        consumedAt: "2026-06-03T01:01:00.000Z",
        consumingOrderId: createOrderId("replacement-order-2"),
      }),
    ).toBe(false);
    expect(repo.findActiveByTokenId(TOKEN_ID)).toBeNull();
    expect(readStatus()).toBe("consumed");
  });

  it.each(["superseded", "cancelled"] as const)("cleans up an active intent as %s", (status) => {
    repo.insertActive(baseInput());

    expect(
      repo.clearActive(TOKEN_ID, {
        status,
        clearedAt: "2026-06-03T01:00:00.000Z",
        clearReason: "external_close",
      }),
    ).toBe(true);
    expect(repo.findActiveByTokenId(TOKEN_ID)).toBeNull();
    expect(readStatus()).toBe(status);
  });
});

function baseInput(): Parameters<SqliteFloorIntentRepository["insertActive"]>[0] {
  return {
    tokenId: TOKEN_ID,
    conditionId: CONDITION_ID,
    positionId: POSITION_ID,
    sourceOrderId: ORDER_ID,
    sourceSignalId: "signal-1",
    createdAt: "2026-06-03T00:00:00.000Z",
    targetPrice: 0.1,
    floorRatioApplied: 0.4,
    normalSignalFloorWouldHaveBlocked: true,
    normalSignalFloorPrice: 0.2,
    metadata: { source: "test" },
  };
}

function readStatus(): string {
  const row = conn.db
    .prepare("SELECT status FROM floor_intents WHERE token_id = ?")
    .get(String(TOKEN_ID)) as { status: string };
  return row.status;
}
