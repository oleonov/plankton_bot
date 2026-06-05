import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapLedgerDb } from "../../bootstrap.js";
import type { DbConnection } from "../../connection.js";
import { SqliteExecutionPolicyObservationRepository } from "../execution-policy-observation-repository.js";
import type { ExecutionPolicyObservation } from "@krabs/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteExecutionPolicyObservationRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-exec-policy-observation-"));
  conn = bootstrapLedgerDb(path.join(tmpDir, "ledger.db"));
  repo = new SqliteExecutionPolicyObservationRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function baseObservation(
  overrides: Partial<ExecutionPolicyObservation> = {},
): ExecutionPolicyObservation {
  return {
    profileId: "live-lite",
    signalId: "sig-1",
    clientOrderId: "client-1",
    decisionRuleId: "D8",
    sizingRuleId: "S2",
    notionalBucket: "$2-$5",
    tokenId: "tok-1",
    marketSlug: "cheap-wide-exit",
    side: "SELL",
    signalReason: "repricing-exit",
    selectedPricingMode: "edge",
    selectedPrice: 0.489,
    edgePrice: null,
    boundedPrice: null,
    boundedOutcome: "not-computed",
    spreadTicks: null,
    improvementTicks: null,
    deadSideObserved: false,
    deadSideBucket: null,
    deadSideEnforceHit: false,
    deadSideX60: false,
    deadSideX120: false,
    deadSideX300: false,
    deadSideX900: false,
    timeToEndMs: null,
    skippedReason: null,
    pricingDeltaTicks: 0,
    roundLevelHit: "off-round",
    sellShadowAvgEntry: 0.01,
    sellShadowAvgEntrySource: "position_repo",
    sellShadowSignalPrice: 0.01,
    sellShadowExecutionPrice: 0.489,
    sellShadowExecutionVsSignalRatio: 48.9,
    sellShadowExecutionVsAvgEntryRatio: 48.9,
    sellShadowCap5Violation: true,
    sellShadowCap10Violation: true,
    sellShadowExitPricingMode: "midpoint-anchored",
    sellShadowExitAnchorMode: "ask_undercut",
    ...overrides,
  };
}

describe("SqliteExecutionPolicyObservationRepository", () => {
  it("persists observe-only SELL shadow pricing fields", () => {
    repo.insert(baseObservation());

    const row = conn.db
      .prepare(
        `SELECT sell_shadow_avg_entry, sell_shadow_avg_entry_source,
                sell_shadow_execution_price, sell_shadow_cap5_violation,
                sell_shadow_cap10_violation, sell_shadow_exit_anchor_mode
           FROM execution_policy_observations`,
      )
      .get() as Record<string, unknown>;

    expect(row).toMatchObject({
      sell_shadow_avg_entry: 0.01,
      sell_shadow_avg_entry_source: "position_repo",
      sell_shadow_execution_price: 0.489,
      sell_shadow_cap5_violation: 1,
      sell_shadow_cap10_violation: 1,
      sell_shadow_exit_anchor_mode: "ask_undercut",
    });
  });

  it("preserves null SELL shadow cap booleans as SQLite NULL", () => {
    repo.insert(
      baseObservation({
        sellShadowAvgEntry: null,
        sellShadowAvgEntrySource: "missing_position",
        sellShadowExecutionVsAvgEntryRatio: null,
        sellShadowCap5Violation: null,
        sellShadowCap10Violation: null,
      }),
    );

    const row = conn.db
      .prepare(
        `SELECT sell_shadow_cap5_violation, sell_shadow_cap10_violation
           FROM execution_policy_observations`,
      )
      .get() as Record<string, unknown>;

    expect(row).toMatchObject({
      sell_shadow_cap5_violation: null,
      sell_shadow_cap10_violation: null,
    });
  });
});
