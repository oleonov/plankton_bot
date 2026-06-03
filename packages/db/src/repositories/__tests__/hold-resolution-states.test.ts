import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConditionId, createOrderId, createPositionId, createTokenId } from "@krabs/domain";
import { bootstrapLedgerDb } from "../../bootstrap.js";
import type { DbConnection } from "../../connection.js";
import { SqliteHoldResolutionStateRepository } from "../hold-resolution-states.js";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteHoldResolutionStateRepository;

const TOKEN_ID = createTokenId("track-c-token-1");
const CONDITION_ID = createConditionId("track-c-condition-1");
const POSITION_ID = createPositionId("track-c-position-1");
const ORDER_ID = createOrderId("track-c-order-1");

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-hold-resolution-"));
  conn = bootstrapLedgerDb(path.join(tmpDir, "ledger.db"));
  repo = new SqliteHoldResolutionStateRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteHoldResolutionStateRepository", () => {
  it("inserts and reads one active row for a token", () => {
    const result = repo.insertActive({
      tokenId: TOKEN_ID,
      conditionId: CONDITION_ID,
      positionId: POSITION_ID,
      sourceOrderId: ORDER_ID,
      markerCreatedAt: "2026-06-03T00:00:00.000Z",
      expectedResolutionAt: "2026-06-04T00:00:00.000Z",
      exitPnlPct: -0.84,
      staleReason: "chain",
      livenessVerdict: "dead",
      metadata: { reason: "dead_chain_hold_resolution" },
    });

    expect(result.inserted).toBe(true);
    expect(repo.findActiveByTokenId(TOKEN_ID)).toMatchObject({
      tokenId: TOKEN_ID,
      status: "active",
      conditionId: CONDITION_ID,
      positionId: POSITION_ID,
      sourceOrderId: ORDER_ID,
      expectedResolutionAt: "2026-06-04T00:00:00.000Z",
      staleReason: "chain",
      livenessVerdict: "dead",
    });
  });

  it.each(["resolved_zero_loss", "recovered", "cancelled"] as const)(
    "updates active rows to terminal status %s",
    (status) => {
      repo.insertActive(baseInput());

      expect(
        repo.transitionActive(TOKEN_ID, {
          status,
          clearedAt: "2026-06-03T01:00:00.000Z",
          clearReason: status,
        }),
      ).toBe(true);

      expect(repo.findActiveByTokenId(TOKEN_ID)).toBeNull();
      expect(readStatus()).toBe(status);
    },
  );

  it("enforces one active row per token via insert-if-absent", () => {
    expect(repo.insertActive(baseInput()).inserted).toBe(true);
    expect(repo.insertActive({ ...baseInput(), sourceOrderId: createOrderId("other-order") }))
      .toMatchObject({ inserted: false });

    const activeRows = conn.db
      .prepare("SELECT COUNT(*) AS count FROM hold_resolution_states WHERE token_id = ? AND status = 'active'")
      .get(String(TOKEN_ID)) as { count: number };
    expect(activeRows.count).toBe(1);
  });

  it("does not transition a terminal row twice", () => {
    repo.insertActive(baseInput());

    expect(repo.transitionActive(TOKEN_ID, { status: "cancelled" })).toBe(true);
    expect(repo.transitionActive(TOKEN_ID, { status: "recovered" })).toBe(false);
    expect(readStatus()).toBe("cancelled");
  });
});

function baseInput(): Parameters<SqliteHoldResolutionStateRepository["insertActive"]>[0] {
  return {
    tokenId: TOKEN_ID,
    conditionId: CONDITION_ID,
    positionId: POSITION_ID,
    sourceOrderId: ORDER_ID,
    markerCreatedAt: "2026-06-03T00:00:00.000Z",
    expectedResolutionAt: "2026-06-04T00:00:00.000Z",
    exitPnlPct: -0.84,
    staleReason: "chain",
    livenessVerdict: "dead",
    metadata: { reason: "dead_chain_hold_resolution" },
  };
}

function readStatus(): string {
  const row = conn.db
    .prepare("SELECT status FROM hold_resolution_states WHERE token_id = ?")
    .get(String(TOKEN_ID)) as { status: string };
  return row.status;
}
