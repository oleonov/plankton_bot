import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteDecisionSignalLogRepository } from "../repositories/decision-signal-log-repository.js";
import { createConditionId, createTokenId } from "@plankton/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteDecisionSignalLogRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteDecisionSignalLogRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteDecisionSignalLogRepository", () => {
  it("persists decision signal facts", () => {
    repo.insert({
      signalId: "sig-1",
      tokenId: createTokenId("tok-1"),
      conditionId: createConditionId("cond-1"),
      side: "SELL",
      decisionRuleId: "D5",
      state: "S1",
      price: 0.21,
      buyCount: 1,
      timeSinceLastSeconds: 123,
      signalTimestamp: "2026-04-26T00:00:00.000Z",
    });

    const row = conn.db.prepare("SELECT * FROM decision_signal_log").get() as
      | Record<string, unknown>
      | undefined;
    expect(row).toMatchObject({
      signal_id: "sig-1",
      token_id: "tok-1",
      condition_id: "cond-1",
      side: "SELL",
      decision_rule_id: "D5",
      state: "S1",
      price: 0.21,
      buy_count: 1,
      time_since_last_seconds: 123,
      signal_timestamp: "2026-04-26T00:00:00.000Z",
    });
  });
});
