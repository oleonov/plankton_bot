import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapLedgerDb } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteRedeemQuarantineRepository } from "../repositories/redeem-quarantine-repository.js";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteRedeemQuarantineRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-redeem-quarantine-"));
  conn = bootstrapLedgerDb(path.join(tmpDir, "ledger.db"));
  repo = new SqliteRedeemQuarantineRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteRedeemQuarantineRepository", () => {
  it("records sticky STATE_FAILED counters and enters quarantine at threshold", () => {
    insertPosition("pos-1", "tok-1", "cond-1", 1.25);

    const below = repo.recordStateFailed({
      conditionId: "cond-1",
      nowTs: 1_000,
      threshold: 2,
      ttlMs: 86_400_000,
    });
    expect(below).toMatchObject({
      consecutiveStateFailedCount: 1,
      redeemQuarantineUntilTs: null,
      enteredQuarantine: false,
    });

    const tripped = repo.recordStateFailed({
      conditionId: "cond-1",
      nowTs: 2_000,
      threshold: 2,
      ttlMs: 86_400_000,
    });
    expect(tripped).toMatchObject({
      consecutiveStateFailedCount: 2,
      redeemQuarantineUntilTs: 86_402_000,
      enteredQuarantine: true,
      positionRows: 1,
      totalBasisUsdc: 1.25,
    });
  });

  it("clears quarantine state after success or TTL expiry", () => {
    insertPosition("pos-1", "tok-1", "cond-1", 1);
    repo.recordStateFailed({ conditionId: "cond-1", nowTs: 1_000, threshold: 1, ttlMs: 10_000 });

    const success = repo.clearAfterSuccess("cond-1");
    expect(success).toMatchObject({
      reset: true,
      previousConsecutiveStateFailedCount: 1,
      previousRedeemQuarantineUntilTs: 11_000,
    });
    expect(repo.findByConditionIds(["cond-1"]).get("cond-1")).toMatchObject({
      consecutiveStateFailedCount: 0,
      redeemQuarantineUntilTs: null,
    });

    repo.recordStateFailed({ conditionId: "cond-1", nowTs: 2_000, threshold: 1, ttlMs: 10_000 });
    const expired = repo.clearExpired("cond-1");
    expect(expired.reset).toBe(true);
    expect(repo.findByConditionIds(["cond-1"]).get("cond-1")).toMatchObject({
      consecutiveStateFailedCount: 0,
      redeemQuarantineUntilTs: null,
    });
  });

  it("summarizes active quarantines and recent audit events", () => {
    insertPosition("pos-1", "tok-1", "cond-1", 1.25);
    insertPosition("pos-2", "tok-2", "cond-1", 0.75);
    repo.recordStateFailed({ conditionId: "cond-1", nowTs: 1_000, threshold: 1, ttlMs: 10_000 });
    conn.db
      .prepare("INSERT INTO risk_events (event_type, payload) VALUES (?, ?)")
      .run("redeem_quarantine_expired", "{}");
    conn.db
      .prepare("INSERT INTO risk_events (event_type, payload) VALUES (?, ?)")
      .run("redeem_quarantine_manual_reset", "{}");

    expect(repo.summarizeQuarantine(2_000)).toMatchObject({
      quarantinedCount: 1,
      totalBasisUsdc: 2,
      expired24h: 1,
      manualResets24h: 1,
    });
  });
});

function insertPosition(positionId: string, tokenId: string, conditionId: string, basis: number) {
  conn.db
    .prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, current_value_usdc, status, opened_at, updated_at)
       VALUES (?, ?, ?, 'buy', 1, ?, ?, ?, 'open', datetime('now'), datetime('now'))`,
    )
    .run(positionId, tokenId, conditionId, basis, basis, basis);
}
