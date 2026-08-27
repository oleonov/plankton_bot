import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteDecisionSignalLogRepository } from "../repositories/decision-signal-log-repository.js";
import { createConditionId, createTokenId } from "@krabs/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteDecisionSignalLogRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-test-"));
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
      isExit: 1,
      isFirstSell: 1,
      holdingTimeMs: 5_400_000,
      holdingTimeBucket: "1-6h",
      exitPnlPct: 0.4,
      exitPnlBucket: "+25% to +50%",
      soldBoughtRatio: 0,
      soldBoughtRatioBucket: "0%",
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
      is_exit: 1,
      is_first_sell: 1,
      holding_time_ms: 5_400_000,
      holding_time_bucket: "1-6h",
      exit_pnl_pct: 0.4,
      exit_pnl_bucket: "+25% to +50%",
      sold_bought_ratio: 0,
      sold_bought_ratio_bucket: "0%",
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
      // BUY rows are explicitly non-exits; SELL-only derived telemetry stays null.
      isExit: 0,
      isFirstSell: null,
      holdingTimeMs: null,
      holdingTimeBucket: null,
      exitPnlPct: null,
      exitPnlBucket: null,
      soldBoughtRatio: null,
      soldBoughtRatioBucket: null,
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
      is_exit: 0,
      is_first_sell: null,
      holding_time_ms: null,
      holding_time_bucket: null,
      exit_pnl_pct: null,
      exit_pnl_bucket: null,
      sold_bought_ratio: null,
      sold_bought_ratio_bucket: null,
    });
  });

  it("persists entry attribution but discards a synthetic category payload", () => {
    const payload = {
      tokenId: "tok-3",
      shadowClassification: "AFTER_PUMP_EXPENSIVE",
      windows: { "1h": { midpointPercentile: 0.94 } },
    };
    repo.insert({
      signalId: "sig-3",
      tokenId: createTokenId("tok-3"),
      conditionId: createConditionId("cond-3"),
      side: "BUY",
      decisionRuleId: "FALLBACK",
      sizingRuleId: "B5",
      notionalBucket: "$1-$2",
      state: "OTHER",
      price: 0.42,
      buyCount: 0,
      timeSinceLastSeconds: null,
      signalTimestamp: "2026-06-06T00:00:00.000Z",
      isAdd: 0,
      addAgeMs: null,
      addAgeBucket: null,
      addPriceChangePct: null,
      addPriceChangeBucket: null,
      nthBuyAtEmit: 1,
      isExit: 0,
      isFirstSell: null,
      holdingTimeMs: null,
      holdingTimeBucket: null,
      exitPnlPct: null,
      exitPnlBucket: null,
      soldBoughtRatio: null,
      soldBoughtRatioBucket: null,
      entryFreshEdgeKind: "first_entry",
      entryFreshEdgeShadowClass: "AFTER_PUMP_EXPENSIVE",
      entryFreshEdgePayloadJson: JSON.stringify(payload),
      entryCategory: "geopolitics" as const,
      entryCategoryGateClass: "PRIORITIZE" as const,
      entryCategoryPayloadJson: JSON.stringify({
        category: "geopolitics",
        gateClass: "PRIORITIZE",
      }),
    });

    const row = conn.db
      .prepare("SELECT * FROM decision_signal_log WHERE signal_id = ?")
      .get("sig-3") as Record<string, unknown> | undefined;
    expect(row).toMatchObject({
      entry_fresh_edge_kind: "first_entry",
      entry_fresh_edge_shadow_class: "AFTER_PUMP_EXPENSIVE",
      entry_fresh_edge_payload_json: JSON.stringify(payload),
      entry_category: "geopolitics",
      entry_category_gate_class: "PRIORITIZE",
      entry_category_payload_json: null,
    });
  });
});
