import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapLedgerDb } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteRedeemLogRepository } from "../repositories/redeem-log-repository.js";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteRedeemLogRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-redeem-log-"));
  conn = bootstrapLedgerDb(path.join(tmpDir, "ledger.db"));
  repo = new SqliteRedeemLogRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteRedeemLogRepository in-flight uniqueness", () => {
  it("blocks a second active redeem attempt for the same condition", () => {
    repo.insert({
      conditionId: "cond-1",
      tokenIds: ["tok-1"],
      attemptTs: 1_000,
      status: "attempting",
    });

    expect(() =>
      repo.insert({
        conditionId: "cond-1",
        tokenIds: ["tok-1"],
        attemptTs: 2_000,
        status: "attempting",
      }),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("allows a new active attempt after the previous active row transitions to success", () => {
    repo.insert({
      conditionId: "cond-1",
      tokenIds: ["tok-1"],
      attemptTs: 1_000,
      status: "attempting",
    });

    expect(
      repo.updateLatestActiveAttempt({
        conditionId: "cond-1",
        tokenIds: ["tok-1"],
        status: "success",
      }),
    ).toBe(true);

    expect(() =>
      repo.insert({
        conditionId: "cond-1",
        tokenIds: ["tok-1"],
        attemptTs: 2_000,
        status: "attempting",
      }),
    ).not.toThrow();
  });

  it("creates the partial unique in-flight index during bootstrap", () => {
    const row = conn.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_redeem_log_unique_in_flight'",
      )
      .get();

    expect(row).toBeTruthy();
  });
});
