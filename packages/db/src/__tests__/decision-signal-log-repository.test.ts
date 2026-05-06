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
      sizingRuleId: "S2",
      notionalBucket: "$2-$5",
      state: "S1",
      price: 0.21,
      buyCount: 1,
      timeSinceLastSeconds: 123,
      signalTimestamp: "2026-04-26T00:00:00.000Z",
      isAdd: null,
      addAgeMs: null,
      addAgeBucket: null,
      addPriceChangePct: null,
      addPriceChangeBucket: null,
      nthBuyAtEmit: null,
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
      sizing_rule_id: "S2",
      notional_bucket: "$2-$5",
      state: "S1",
      price: 0.21,
      buy_count: 1,
      time_since_last_seconds: 123,
      signal_timestamp: "2026-04-26T00:00:00.000Z",
      is_add: null,
      add_age_ms: null,
      add_age_bucket: null,
      add_price_change_pct: null,
      add_price_change_bucket: null,
      nth_buy_at_emit: null,
    });
  });

  it("persists §11.1 adds telemetry on add-BUY signals", () => {
    repo.insert({
      signalId: "sig-2",
      tokenId: createTokenId("tok-2"),
      conditionId: createConditionId("cond-2"),
      side: "BUY",
      decisionRuleId: "D2",
      sizingRuleId: "B3",
      notionalBucket: "$5-$10",
      state: "S1",
      price: 0.15,
      buyCount: 2,
      timeSinceLastSeconds: 45,
      signalTimestamp: "2026-05-06T00:00:00.000Z",
      isAdd: 1,
      addAgeMs: 7_200_000,
      addAgeBucket: "1-3h",
      addPriceChangePct: -0.18,
      addPriceChangeBucket: "-25% to -10%",
      nthBuyAtEmit: 3,
    });

    const row = conn.db
      .prepare("SELECT * FROM decision_signal_log WHERE signal_id = ?")
      .get("sig-2") as Record<string, unknown> | undefined;
    expect(row).toMatchObject({
      is_add: 1,
      add_age_ms: 7_200_000,
      add_age_bucket: "1-3h",
      add_price_change_pct: -0.18,
      add_price_change_bucket: "-25% to -10%",
      nth_buy_at_emit: 3,
    });
  });
});
