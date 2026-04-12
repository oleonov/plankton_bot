import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { loadFamilyRulesYaml } from "../loader.js";

// Resolve paths relative to this test file → packages/config/src/__tests__/
const PKG_ROOT = path.resolve(import.meta.dirname, "../..");
const MONOREPO_ROOT = path.resolve(PKG_ROOT, "../..");
const TEMPLATE_PATH = path.join(MONOREPO_ROOT, "docs/family_rules_template_v1.yaml");
const TMP_DIR = path.join(PKG_ROOT, ".test-tmp");

function writeTmpYaml(name: string, content: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, name);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function cleanup(): void {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("loadFamilyRulesYaml", () => {
  it("loads the template YAML successfully", () => {
    const result = loadFamilyRulesYaml(TEMPLATE_PATH);
    expect(result.families).toHaveLength(1);

    const family = result.families[0]!;
    expect(family.identity.familyId).toBe("bitcoin-above:threshold:daily");
    expect(family.identity.familyKey).toBe("bitcoin-above");
    expect(family.identity.primaryCategory).toBe("crypto-btc");
    expect(family.identity.regime).toBe("threshold");
    expect(family.identity.strategyProfile).toBe("scalp");
  });

  it("transforms snake_case to camelCase", () => {
    const result = loadFamilyRulesYaml(TEMPLATE_PATH);
    const family = result.families[0]!;

    // Evidence layer
    expect(family.evidence.evidenceStatus).toBe("confirmed");
    expect(family.evidence.localTradeCount).toBe(2283);
    expect(family.evidence.openTailCostUsdc).toBe(0.0);
    expect(family.evidence.tailAdjustedPnl).toBe(698.51);
    expect(family.evidence.bothSidedEligible).toBe(false);
    expect(family.evidence.heavyCampaignEligible).toBe(true);

    // Rules layer
    expect(family.rules.universe.sessionMode).toBe("active-window");
    expect(family.rules.entry.entryMode).toBe("probe-first");
    expect(family.rules.entry.maxInitialNotionalUsdc).toBe(5.0);
    expect(family.rules.scaleIn.defaultMaxBuysPerLeg).toBe(3);
    expect(family.rules.exit.primaryProfitModel).toBe("sell-into-strength");
    expect(family.rules.twoSided.allowTwoSided).toBe(false);
    expect(family.rules.throughput).toEqual({
      maxConcurrentOrdersPerFamily: null,
      maxProbeInFlightPerToken: null,
      maxEntrySignalsPerTickPerFamily: null,
      fastLaneEnabled: null,
      dustLaneEnabled: null,
    });
    expect(family.rules.tailSuppression.maxOpenValueUsdc).toBe(75.0);
    expect(family.rules.session.activeWindowsUtc).toEqual([{ start: "14:00", end: "21:00" }]);
  });

  it("injects familyId into identity, evidence, and rules", () => {
    const result = loadFamilyRulesYaml(TEMPLATE_PATH);
    const family = result.families[0]!;
    const expectedId = "bitcoin-above:threshold:daily";

    expect(family.identity.familyId).toBe(expectedId);
    expect(family.evidence.familyId).toBe(expectedId);
    expect(family.rules.familyId).toBe(expectedId);
  });

  it("strips runtimeState from v2 import schema", () => {
    const result = loadFamilyRulesYaml(TEMPLATE_PATH);
    const family = result.families[0]!;
    // V2 schema strips runtime_state — it comes from DB, not YAML
    expect(family.runtimeState).toBeUndefined();
  });

  it("loads multi-family YAML format", () => {
    const content = `
version: 1
families:
  - family_id: "test-a:threshold:daily"
    identity:
      family_key: "test-a"
      primary_category: "test"
      regime: "threshold"
      horizon: "daily"
      cadence: "daily"
      strategy_profile: "scalp"
    evidence:
      evidence_status: "unknown"
      evidence_score: 0
      promotion_state: "probe-only"
      local_trade_count: 0
      local_market_count: 0
      local_realized_pnl_fifo: 0
      open_tail_cost_usdc: 0
      tail_adjusted_pnl: 0
      both_sided_eligible: false
      heavy_campaign_eligible: false
    rules:
      universe:
        enabled: true
        action: "trade"
        priority_rank: 1
        allow_weekends: false
        session_mode: "active-window"
      entry:
        entry_mode: "probe-first"
        min_entry_price: 0.01
        max_entry_price: 0.50
        max_initial_notional_usdc: 5
        allow_high_price_one_shot: false
        high_price_threshold: 0.50
        require_proven_family_above_price: 0.50
      scale_in:
        scale_mode: "confirm-only"
        default_max_buys_per_leg: 3
        heavy_max_buys_per_leg: 6
        allow_heavy_campaigns: false
        require_positive_recycle_history_for_scale: true
      exit:
        exit_mode: "repricing-sell"
        primary_profit_model: "sell-into-strength"
        allow_runner_extension: false
        prefer_fast_recycle: true
        resolution_holding_allowed: false
      two_sided:
        allow_two_sided: false
        two_sided_mode: "disabled"
      tail_suppression:
        max_open_value_usdc: 50
        max_active_markets: 5
        max_dust_positions: 2
        tail_quarantine_threshold_usdc: 50
        tail_quarantine_threshold_ratio: 1.0
        stale_tail_prune_enabled: true
        threshold_cleanup_required: true
      session:
        active_windows_utc:
          - start: "14:00"
            end: "21:00"
        reduced_windows_utc:
          - start: "12:00"
            end: "14:00"
        weekday_bias: "normal"
        weekend_mode: "reduced"
  - family_id: "test-b:generic:weekly"
    identity:
      family_key: "test-b"
      primary_category: "test"
      regime: "generic"
      horizon: "weekly"
      cadence: "weekly"
      strategy_profile: "event-driven"
    evidence:
      evidence_status: "partial"
      evidence_score: 50
      promotion_state: "scaled"
      local_trade_count: 100
      local_market_count: 10
      local_realized_pnl_fifo: 200
      open_tail_cost_usdc: 10
      tail_adjusted_pnl: 190
      both_sided_eligible: true
      heavy_campaign_eligible: false
    rules:
      universe:
        enabled: true
        action: "monitor"
        priority_rank: 2
        allow_weekends: true
        session_mode: "reduced"
      entry:
        entry_mode: "conviction-only"
        min_entry_price: 0.05
        max_entry_price: 0.40
        max_initial_notional_usdc: 10
        allow_high_price_one_shot: false
        high_price_threshold: 0.40
        require_proven_family_above_price: 0.40
      scale_in:
        scale_mode: "disabled"
        default_max_buys_per_leg: 2
        heavy_max_buys_per_leg: 4
        allow_heavy_campaigns: false
        require_positive_recycle_history_for_scale: false
      exit:
        exit_mode: "reduce-only"
        primary_profit_model: "sell-into-strength"
        allow_runner_extension: false
        prefer_fast_recycle: false
        resolution_holding_allowed: true
      two_sided:
        allow_two_sided: true
        two_sided_mode: "selective"
      tail_suppression:
        max_open_value_usdc: 30
        max_active_markets: 3
        max_dust_positions: 1
        tail_quarantine_threshold_usdc: 30
        tail_quarantine_threshold_ratio: 0.5
        stale_tail_prune_enabled: false
        threshold_cleanup_required: false
      session:
        active_windows_utc:
          - start: "09:00"
            end: "17:00"
        reduced_windows_utc: []
        weekday_bias: "required"
        weekend_mode: "disabled"
`;
    const filePath = writeTmpYaml("multi.yaml", content);
    try {
      const result = loadFamilyRulesYaml(filePath);
      expect(result.families).toHaveLength(2);
      expect(result.families[0]!.identity.familyKey).toBe("test-a");
      expect(result.families[1]!.identity.familyKey).toBe("test-b");
      expect(result.families[1]!.rules.universe.action).toBe("monitor");
    } finally {
      cleanup();
    }
  });

  it("rejects multi-family file without version", () => {
    const content = `
families:
  - family_id: "test:no-version:daily"
    identity:
      family_key: "test"
      primary_category: "test"
      regime: "threshold"
      horizon: "daily"
      cadence: "daily"
      strategy_profile: "scalp"
    evidence:
      evidence_status: "unknown"
      evidence_score: 0
      promotion_state: "probe-only"
      local_trade_count: 0
      local_market_count: 0
      local_realized_pnl_fifo: 0
      open_tail_cost_usdc: 0
      tail_adjusted_pnl: 0
      both_sided_eligible: false
      heavy_campaign_eligible: false
    rules:
      universe:
        enabled: true
        action: "trade"
        priority_rank: 1
        allow_weekends: false
        session_mode: "active-window"
      entry:
        entry_mode: "probe-first"
        min_entry_price: 0.01
        max_entry_price: 0.50
        max_initial_notional_usdc: 5
        allow_high_price_one_shot: false
        high_price_threshold: 0.50
        require_proven_family_above_price: 0.50
      scale_in:
        scale_mode: "confirm-only"
        default_max_buys_per_leg: 3
        heavy_max_buys_per_leg: 6
        allow_heavy_campaigns: false
        require_positive_recycle_history_for_scale: true
      exit:
        exit_mode: "repricing-sell"
        primary_profit_model: "sell-into-strength"
        allow_runner_extension: false
        prefer_fast_recycle: true
        resolution_holding_allowed: false
      two_sided:
        allow_two_sided: false
        two_sided_mode: "disabled"
      tail_suppression:
        max_open_value_usdc: 50
        max_active_markets: 5
        max_dust_positions: 2
        tail_quarantine_threshold_usdc: 50
        tail_quarantine_threshold_ratio: 1.0
        stale_tail_prune_enabled: true
        threshold_cleanup_required: true
      session:
        active_windows_utc:
          - start: "14:00"
            end: "21:00"
        reduced_windows_utc: []
        weekday_bias: "normal"
        weekend_mode: "reduced"
`;
    const filePath = writeTmpYaml("no-version.yaml", content);
    try {
      expect(() => loadFamilyRulesYaml(filePath)).toThrow("Schema validation failed");
    } finally {
      cleanup();
    }
  });

  it("throws on file not found", () => {
    expect(() => loadFamilyRulesYaml("/nonexistent/file.yaml")).toThrow(
      "Failed to read family rules file",
    );
  });

  it("throws on invalid YAML syntax", () => {
    const filePath = writeTmpYaml("bad.yaml", "{{{{not yaml at all: [}}}");
    try {
      expect(() => loadFamilyRulesYaml(filePath)).toThrow("Invalid YAML");
    } finally {
      cleanup();
    }
  });

  it("throws on schema validation failure with details", () => {
    const content = `
family_id: "test:bad:schema"
identity:
  family_key: "test"
  primary_category: "test"
  regime: "invalid-regime"
  horizon: "daily"
  cadence: "daily"
  strategy_profile: "scalp"
evidence:
  evidence_status: "confirmed"
  evidence_score: 0
  promotion_state: "scaled"
  local_trade_count: 0
  local_market_count: 0
  local_realized_pnl_fifo: 0
  open_tail_cost_usdc: 0
  tail_adjusted_pnl: 0
  both_sided_eligible: false
  heavy_campaign_eligible: false
rules:
  universe:
    enabled: true
    action: "trade"
    priority_rank: 1
    allow_weekends: false
    session_mode: "active-window"
  entry:
    entry_mode: "probe-first"
    min_entry_price: 0.01
    max_entry_price: 0.50
    max_initial_notional_usdc: 5
    allow_high_price_one_shot: false
    high_price_threshold: 0.50
    require_proven_family_above_price: 0.50
  scale_in:
    scale_mode: "confirm-only"
    default_max_buys_per_leg: 3
    heavy_max_buys_per_leg: 6
    allow_heavy_campaigns: false
    require_positive_recycle_history_for_scale: true
  exit:
    exit_mode: "repricing-sell"
    primary_profit_model: "sell-into-strength"
    allow_runner_extension: false
    prefer_fast_recycle: true
    resolution_holding_allowed: false
  two_sided:
    allow_two_sided: false
    two_sided_mode: "disabled"
  tail_suppression:
    max_open_value_usdc: 50
    max_active_markets: 5
    max_dust_positions: 2
    tail_quarantine_threshold_usdc: 50
    tail_quarantine_threshold_ratio: 1.0
    stale_tail_prune_enabled: true
    threshold_cleanup_required: true
  session:
    active_windows_utc:
      - start: "14:00"
        end: "21:00"
    reduced_windows_utc: []
    weekday_bias: "normal"
    weekend_mode: "reduced"
`;
    const filePath = writeTmpYaml("invalid-schema.yaml", content);
    try {
      expect(() => loadFamilyRulesYaml(filePath)).toThrow("Schema validation failed");
    } finally {
      cleanup();
    }
  });

  it("throws when YAML is not an object", () => {
    const filePath = writeTmpYaml("scalar.yaml", '"just a string"');
    try {
      expect(() => loadFamilyRulesYaml(filePath)).toThrow("must contain a YAML object");
    } finally {
      cleanup();
    }
  });

  // Minimal valid family block reused by global-related tests
  const MINIMAL_FAMILY_YAML = `
    - family_id: "min:threshold:daily"
      identity:
        family_key: "min"
        primary_category: "test"
        regime: "threshold"
        horizon: "daily"
        cadence: "daily"
        strategy_profile: "scalp"
      evidence:
        evidence_status: "unknown"
        evidence_score: 0
        promotion_state: "probe-only"
        local_trade_count: 0
        local_market_count: 0
        local_realized_pnl_fifo: 0
        open_tail_cost_usdc: 0
        tail_adjusted_pnl: 0
        both_sided_eligible: false
        heavy_campaign_eligible: false
      rules:
        universe:
          enabled: true
          action: "trade"
          priority_rank: 1
          allow_weekends: false
          session_mode: "active-window"
        entry:
          entry_mode: "probe-first"
          min_entry_price: 0.01
          max_entry_price: 0.50
          max_initial_notional_usdc: 5
          allow_high_price_one_shot: false
          high_price_threshold: 0.50
          require_proven_family_above_price: 0.50
        scale_in:
          scale_mode: "confirm-only"
          default_max_buys_per_leg: 3
          heavy_max_buys_per_leg: 6
          allow_heavy_campaigns: false
          require_positive_recycle_history_for_scale: true
        exit:
          exit_mode: "repricing-sell"
          primary_profit_model: "sell-into-strength"
          allow_runner_extension: false
          prefer_fast_recycle: true
          resolution_holding_allowed: false
        two_sided:
          allow_two_sided: false
          two_sided_mode: "disabled"
        tail_suppression:
          max_open_value_usdc: 50
          max_active_markets: 5
          max_dust_positions: 2
          tail_quarantine_threshold_usdc: 50
          tail_quarantine_threshold_ratio: 1.0
          stale_tail_prune_enabled: true
          threshold_cleanup_required: true
        session:
          active_windows_utc:
            - start: "14:00"
              end: "21:00"
          reduced_windows_utc: []
          weekday_bias: "normal"
          weekend_mode: "reduced"`;

  it("defaults global.initialBalanceUsdc to 10000 when global section is omitted", () => {
    const content = `version: 1\nfamilies:\n${MINIMAL_FAMILY_YAML}\n`;
    const filePath = writeTmpYaml("no-global.yaml", content);
    try {
      const result = loadFamilyRulesYaml(filePath);
      expect(result.global.initialBalanceUsdc).toBe(10_000);
      expect(result.families).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("parses custom global.initial_balance_usdc correctly", () => {
    const content = `version: 1\nglobal:\n  initial_balance_usdc: 250\nfamilies:\n${MINIMAL_FAMILY_YAML}\n`;
    const filePath = writeTmpYaml("custom-global.yaml", content);
    try {
      const result = loadFamilyRulesYaml(filePath);
      expect(result.global.initialBalanceUsdc).toBe(250);
      expect(result.families).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("rejects single-family file with global: key", () => {
    const content = `
family_id: "test:threshold:daily"
global:
  initial_balance_usdc: 100
identity:
  family_key: "test"
  primary_category: "test"
  regime: "threshold"
  horizon: "daily"
  cadence: "daily"
  strategy_profile: "scalp"
evidence:
  evidence_status: "unknown"
  evidence_score: 0
  promotion_state: "probe-only"
  local_trade_count: 0
  local_market_count: 0
  local_realized_pnl_fifo: 0
  open_tail_cost_usdc: 0
  tail_adjusted_pnl: 0
  both_sided_eligible: false
  heavy_campaign_eligible: false
rules:
  universe:
    enabled: true
    action: "trade"
    priority_rank: 1
    allow_weekends: false
    session_mode: "active-window"
  entry:
    entry_mode: "probe-first"
    min_entry_price: 0.01
    max_entry_price: 0.50
    max_initial_notional_usdc: 5
    allow_high_price_one_shot: false
    high_price_threshold: 0.50
    require_proven_family_above_price: 0.50
  scale_in:
    scale_mode: "confirm-only"
    default_max_buys_per_leg: 3
    heavy_max_buys_per_leg: 6
    allow_heavy_campaigns: false
    require_positive_recycle_history_for_scale: true
  exit:
    exit_mode: "repricing-sell"
    primary_profit_model: "sell-into-strength"
    allow_runner_extension: false
    prefer_fast_recycle: true
    resolution_holding_allowed: false
  two_sided:
    allow_two_sided: false
    two_sided_mode: "disabled"
  tail_suppression:
    max_open_value_usdc: 50
    max_active_markets: 5
    max_dust_positions: 2
    tail_quarantine_threshold_usdc: 50
    tail_quarantine_threshold_ratio: 1.0
    stale_tail_prune_enabled: true
    threshold_cleanup_required: true
  session:
    active_windows_utc:
      - start: "14:00"
        end: "21:00"
    reduced_windows_utc: []
    weekday_bias: "normal"
    weekend_mode: "reduced"
`;
    const filePath = writeTmpYaml("single-with-global.yaml", content);
    try {
      expect(() => loadFamilyRulesYaml(filePath)).toThrow(
        '"global" section is not supported in single-family format',
      );
    } finally {
      cleanup();
    }
  });
});
