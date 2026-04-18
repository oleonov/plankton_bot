import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { loadFamilyRulesYaml } from "../loader.js";

// Resolve paths relative to this test file → packages/config/src/__tests__/
const PKG_ROOT = path.resolve(import.meta.dirname, "../..");
const MONOREPO_ROOT = path.resolve(PKG_ROOT, "../..");
const REAL_RULES_PATH = path.join(MONOREPO_ROOT, "config/family_rules.yaml");
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
  it("keeps production tail caps aligned with live policy", () => {
    const result = loadFamilyRulesYaml(REAL_RULES_PATH);
    const byId = new Map(result.families.map((family) => [family.identity.familyId, family]));

    expect(
      byId.get("donald-trump-of-truth-social-posts:social-activity:ad-hoc")?.rules.tailSuppression,
    ).toMatchObject({
      maxActiveMarkets: 100,
      maxDustPositions: 50,
      tailQuarantineThresholdUsdc: 1000,
      tailQuarantineThresholdRatio: 1000,
    });

    expect(
      byId.get("highest-temperature-in-london:price-range:daily")?.rules.tailSuppression,
    ).toMatchObject({
      maxActiveMarkets: 100,
      maxDustPositions: 50,
      tailQuarantineThresholdUsdc: 1000,
      tailQuarantineThresholdRatio: 1000,
    });

    expect(
      byId.get("highest-temperature-in-nyc:price-range:daily")?.rules.tailSuppression,
    ).toMatchObject({
      maxActiveMarkets: 100,
      maxDustPositions: 50,
      tailQuarantineThresholdUsdc: 1000,
      tailQuarantineThresholdRatio: 1000,
    });

    expect(
      byId.get("highest-temperature-in-seoul:price-range:daily")?.rules.tailSuppression,
    ).toMatchObject({
      maxActiveMarkets: 100,
      maxDustPositions: 50,
      tailQuarantineThresholdUsdc: 1000,
      tailQuarantineThresholdRatio: 1000,
    });

    expect(
      byId.get("elon-musk-of-tweets:social-activity:weekly-window")?.rules.tailSuppression,
    ).toMatchObject({
      maxActiveMarkets: 100,
      maxDustPositions: 50,
      tailQuarantineThresholdUsdc: 1000,
      tailQuarantineThresholdRatio: 1000,
    });
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
          weekday_bias: "normal"`;
  const MINIMAL_FAMILY_NO_MAX_ENTRY_PRICE_YAML = MINIMAL_FAMILY_YAML.replace(
    /^\s*max_entry_price: 0\.50\n/m,
    "",
  );

  it("defaults global.initialBalanceUsdc to 10000 when global section is omitted", () => {
    const content = `version: 1\nfamilies:\n${MINIMAL_FAMILY_YAML}\n`;
    const filePath = writeTmpYaml("no-global.yaml", content);
    try {
      const result = loadFamilyRulesYaml(filePath);
      expect(result.global.initialBalanceUsdc).toBe(10_000);
      expect(result.global.dustLaneMaxMarketsPerTick).toBe(100);
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
      expect(result.global.dustLaneMaxMarketsPerTick).toBe(100);
      expect(result.families).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("applies defaults.entry.max_entry_price when family omits it", () => {
    const content = `version: 1
defaults:
  entry:
    min_entry_price: 0.03
    max_entry_price: 0.35
    high_price_threshold: 0.35
    require_proven_family_above_price: 0.35
    preferred_entry_band: "0.05-0.35"
families:
${MINIMAL_FAMILY_NO_MAX_ENTRY_PRICE_YAML}
`;
    const filePath = writeTmpYaml("defaults-max-entry.yaml", content);
    try {
      const result = loadFamilyRulesYaml(filePath);
      expect(result.defaults.entry).toEqual({
        minEntryPrice: 0.03,
        maxEntryPrice: 0.35,
        highPriceThreshold: 0.35,
        requireProvenFamilyAbovePrice: 0.35,
        preferredEntryBand: "0.05-0.35",
      });
      expect(result.families[0]!.rules.entry.maxEntryPrice).toBe(0.35);
    } finally {
      cleanup();
    }
  });

  it("prefers family max_entry_price over defaults.entry.max_entry_price", () => {
    const content = `version: 1
defaults:
  entry:
    min_entry_price: 0.03
    max_entry_price: 0.35
    high_price_threshold: 0.35
    require_proven_family_above_price: 0.35
    preferred_entry_band: "0.05-0.35"
families:
${MINIMAL_FAMILY_YAML}
`;
    const filePath = writeTmpYaml("defaults-overridden.yaml", content);
    try {
      const result = loadFamilyRulesYaml(filePath);
      expect(result.families[0]!.rules.entry.maxEntryPrice).toBe(0.5);
    } finally {
      cleanup();
    }
  });

  it("rejects multi-family YAML when max_entry_price is missing in both family and defaults", () => {
    const content = `version: 1
families:
${MINIMAL_FAMILY_NO_MAX_ENTRY_PRICE_YAML}
`;
    const filePath = writeTmpYaml("missing-default-and-family-max.yaml", content);
    try {
      expect(() => loadFamilyRulesYaml(filePath)).toThrow("max_entry_price");
    } finally {
      cleanup();
    }
  });

  it("rejects partial defaults.entry presets", () => {
    const content = `version: 1
defaults:
  entry:
    max_entry_price: 0.35
families:
${MINIMAL_FAMILY_YAML}
`;
    const filePath = writeTmpYaml("partial-default-entry.yaml", content);
    try {
      expect(() => loadFamilyRulesYaml(filePath)).toThrow("min_entry_price");
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

  it("rejects single-family file with defaults: key", () => {
    const content = `
family_id: "test:threshold:daily"
defaults:
  entry:
    max_entry_price: 0.50
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
`;
    const filePath = writeTmpYaml("single-with-defaults.yaml", content);
    try {
      expect(() => loadFamilyRulesYaml(filePath)).toThrow(
        '"defaults" section is not supported in single-family format',
      );
    } finally {
      cleanup();
    }
  });
});
