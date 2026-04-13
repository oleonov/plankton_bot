import { z } from "zod";
import type { EntryRulePreset } from "@plankton/domain";

// ─── Enum schemas (independent of @plankton/domain) ─────────────────────────

const regimeSchema = z.enum([
  "threshold",
  "price-range",
  "directional-updown",
  "social-activity",
  "succession",
  "geopolitics",
  "generic",
  "tournament",
  "weather-range",
]);

const strategyProfileSchema = z.enum([
  "scalp",
  "event-driven",
  "inventory-recycle",
  "optional-probe",
  "restricted",
]);

const feeTierSchema = z.enum(["fee-free", "fee-enabled", "unknown"]);
const liveWalletRequirementSchema = z.enum(["eoa-ok", "relayer-required"]);

const evidenceStatusSchema = z.enum(["confirmed", "partial", "weak", "unknown"]);

const promotionStateSchema = z.enum([
  "probe-only",
  "scaled",
  "restricted",
  "reduce-only",
  "quarantine",
]);

const actionSchema = z.enum(["trade", "monitor", "reduce-only", "blocked"]);

const sessionModeSchema = z.enum(["active-window", "reduced", "always-reduced"]);

const entryModeSchema = z.enum(["spray-first", "probe-first", "conviction-only", "disabled"]);

const scaleModeSchema = z.enum(["confirm-only", "disabled", "aggressive-confirm"]);

const exitModeSchema = z.enum(["repricing-sell", "reduce-only", "disabled"]);

const profitModelSchema = z.enum(["sell-into-strength"]);

const twoSidedModeSchema = z.enum(["disabled", "selective", "active"]);

const weekdayBiasSchema = z.enum(["normal", "preferred", "required"]);

const runtimeModeSchema = z.enum(["active", "probe-only", "reduce-only", "quarantine"]);

// ─── Sub-schemas (snake_case YAML input) ────────────────────────────────────

const timeWindowSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/, "Must be HH:MM format"),
  end: z.string().regex(/^\d{2}:\d{2}$/, "Must be HH:MM format"),
});

export const identityYamlSchema = z.object({
  family_key: z.string(),
  primary_category: z.string(),
  regime: regimeSchema,
  horizon: z.string(),
  cadence: z.string(),
  strategy_profile: strategyProfileSchema,
  topic_key: z.string().nullable().optional().default(null),
  slug_pattern: z.string().nullable().optional().default(null),
  notes: z.string().nullable().optional().default(null),
  fee_tier: feeTierSchema.nullable().optional().default(null),
  live_wallet_requirement: liveWalletRequirementSchema.nullable().optional().default(null),
  requires_post_only_for_live: z.boolean().nullable().optional().default(null),
});

export const evidenceYamlSchema = z.object({
  evidence_status: evidenceStatusSchema,
  evidence_score: z.number(),
  promotion_state: promotionStateSchema,
  local_trade_count: z.number().int(),
  local_market_count: z.number().int(),
  local_realized_pnl_fifo: z.number(),
  open_tail_cost_usdc: z.number(),
  tail_adjusted_pnl: z.number(),
  remote_closed_realized_pnl: z.number().nullable().optional().default(null),
  open_position_count: z.number().int().nullable().optional().default(null),
  open_dust_count: z.number().int().nullable().optional().default(null),
  both_sided_eligible: z.boolean(),
  heavy_campaign_eligible: z.boolean(),
  active_window_edge_score: z.number().nullable().optional().default(null),
  recurrence_score: z.number().nullable().optional().default(null),
  recycle_score: z.number().nullable().optional().default(null),
  live_viability_score: z.number().nullable().optional().default(null),
  toxicity_penalty: z.number().nullable().optional().default(null),
  last_validated_at: z.string().nullable().optional().default(null),
});

const universeYamlSchema = z.object({
  enabled: z.boolean(),
  action: actionSchema,
  priority_rank: z.number().int(),
  session_mode: sessionModeSchema,
});

const entryYamlSchema = z.object({
  entry_mode: entryModeSchema,
  min_entry_price: z.number(),
  max_entry_price: z.number(),
  max_initial_notional_usdc: z.number(),
  allow_high_price_one_shot: z.boolean(),
  high_price_threshold: z.number(),
  require_proven_family_above_price: z.number(),
  preferred_entry_band: z.string().nullable().optional().default(null),
  max_probe_count_per_market: z.number().int().nullable().optional().default(null),
  entry_cooldown_seconds: z.number().int().nullable().optional().default(null),
  max_new_markets_per_session: z.number().int().nullable().optional().default(null),
  probe_size_usdc: z.number().default(5),
  add_size_usdc: z.number().default(4),
});

const scaleInYamlSchema = z.object({
  scale_mode: scaleModeSchema,
  default_max_buys_per_leg: z.number().int(),
  heavy_max_buys_per_leg: z.number().int(),
  allow_heavy_campaigns: z.boolean(),
  require_positive_recycle_history_for_scale: z.boolean(),
});

const exitYamlSchema = z.object({
  exit_mode: exitModeSchema,
  primary_profit_model: profitModelSchema,
  allow_runner_extension: z.boolean(),
  prefer_fast_recycle: z.boolean(),
  resolution_holding_allowed: z.boolean(),
  resolution_buffer_minutes: z.number().int().default(60),
  target_roi_band_low: z.number().nullable().optional().default(null),
  target_roi_band_high: z.number().nullable().optional().default(null),
  max_unmoved_hold_hours: z.number().nullable().optional().default(null),
  max_tail_hold_hours: z.number().nullable().optional().default(null),
});

const twoSidedYamlSchema = z.object({
  allow_two_sided: z.boolean(),
  two_sided_mode: twoSidedModeSchema,
  min_activity_for_two_sided: z.number().int().nullable().optional().default(null),
  max_additional_entry_price: z.number().nullable().optional(),
});

const throughputYamlSchema = z.object({
  max_concurrent_orders_per_family: z.number().int().positive().nullable().optional().default(null),
  max_probe_in_flight_per_token: z.number().int().positive().nullable().optional().default(null),
  max_entry_signals_per_tick_per_family: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .default(null),
  fast_lane_enabled: z.boolean().nullable().optional().default(null),
  dust_lane_enabled: z.boolean().nullable().optional().default(null),
  queue_jump_canary_enabled: z.boolean().nullable().optional().default(null),
});

const tailSuppressionYamlSchema = z.object({
  max_open_value_usdc: z.number(),
  max_active_markets: z.number().int(),
  max_dust_positions: z.number().int(),
  tail_quarantine_threshold_usdc: z.number(),
  tail_quarantine_threshold_ratio: z.number(),
  stale_tail_prune_enabled: z.boolean(),
  threshold_cleanup_required: z.boolean(),
  auto_settle_resolved_markets: z.boolean().default(true),
});

const sessionYamlSchema = z.object({
  active_windows_utc: z.array(timeWindowSchema),
  reduced_windows_utc: z.array(timeWindowSchema),
  weekday_bias: weekdayBiasSchema,
});

export const rulesYamlSchema = z.object({
  universe: universeYamlSchema,
  entry: entryYamlSchema,
  scale_in: scaleInYamlSchema,
  exit: exitYamlSchema,
  two_sided: twoSidedYamlSchema,
  throughput: throughputYamlSchema.optional().default({
    max_concurrent_orders_per_family: null,
    max_probe_in_flight_per_token: null,
    max_entry_signals_per_tick_per_family: null,
    fast_lane_enabled: null,
    dust_lane_enabled: null,
    queue_jump_canary_enabled: null,
  }),
  tail_suppression: tailSuppressionYamlSchema,
  session: sessionYamlSchema,
});

const entryYamlInputSchema = entryYamlSchema.extend({
  max_entry_price: z.number().optional(),
});

const rulesYamlInputSchema = rulesYamlSchema.extend({
  entry: entryYamlInputSchema,
});

export const runtimeStateYamlSchema = z.object({
  runtime_mode: runtimeModeSchema,
  open_value_usdc: z.number(),
  open_position_count: z.number().int(),
  open_dust_count: z.number().int(),
  active_market_count: z.number().int(),
  current_tail_cost_usdc: z.number(),
  tail_adjusted_pnl_live: z.number(),
  last_entry_ts: z.string().nullable().optional().default(null),
  last_exit_ts: z.string().nullable().optional().default(null),
  quarantine_reason: z.string().nullable().optional().default(null),
});

// ─── Top-level family YAML schema ───────────────────────────────────────────

export const evidenceYamlDefaults = {
  evidence_status: "unknown" as const,
  evidence_score: 0,
  promotion_state: "probe-only" as const,
  local_trade_count: 0,
  local_market_count: 0,
  local_realized_pnl_fifo: 0,
  open_tail_cost_usdc: 0,
  tail_adjusted_pnl: 0,
  both_sided_eligible: false,
  heavy_campaign_eligible: false,
};

function createFamilyYamlSchema<TRules extends z.ZodTypeAny>(rulesSchema: TRules) {
  return z
    .object({
      family_id: z.string(),
      identity: identityYamlSchema,
      evidence: evidenceYamlSchema.optional().default(evidenceYamlDefaults),
      rules: rulesSchema,
    })
    .strip();
}

/**
 * V2 import schema: identity + rules only.
 * Evidence and runtime_state are stripped — they come from DB, not YAML.
 * Evidence defaults are provided for backward compat with v1 YAML files.
 * .strip() silently drops runtime_state and any other unknown keys from v1 files.
 */
export const familyYamlSchema = createFamilyYamlSchema(rulesYamlSchema);
export const familyYamlInputSchema = createFamilyYamlSchema(rulesYamlInputSchema);

// ─── Global config (operator-level runtime settings) ─────────────────────────

const globalYamlSchema = z.object({
  initial_balance_usdc: z.number().positive().max(1_000_000).default(10_000),
  spray_size_usdc: z.number().nonnegative().max(100).default(0.15),
  spray_max_markets_per_tick: z.number().int().nonnegative().max(100).default(10),
  dust_lane_max_markets_per_tick: z.number().int().nonnegative().max(250).default(100),
  spray_cooldown_seconds: z.number().nonnegative().max(3600).default(5),
  spray_budget_usdc: z.number().nonnegative().max(100_000).default(50),
  spray_max_total_positions: z.number().int().nonnegative().max(1000).default(30),
});

export type GlobalYaml = z.infer<typeof globalYamlSchema>;

const entryDefaultsYamlSchema = z.object({
  min_entry_price: z.number(),
  max_entry_price: z.number(),
  high_price_threshold: z.number(),
  require_proven_family_above_price: z.number(),
  preferred_entry_band: z.string().nullable().optional().default(null),
});

export const familyRuleDefaultsYamlSchema = z.object({
  entry: entryDefaultsYamlSchema.nullable().optional().default(null),
});

export const familyRulesFileSchema = z.object({
  version: z.number().int(),
  global: globalYamlSchema.default({ initial_balance_usdc: 10_000 }),
  defaults: familyRuleDefaultsYamlSchema.optional().default({}),
  families: z.array(familyYamlSchema),
});

export const familyRulesFileInputSchema = z.object({
  version: z.number().int(),
  global: globalYamlSchema.default({ initial_balance_usdc: 10_000 }),
  defaults: familyRuleDefaultsYamlSchema.optional().default({}),
  families: z.array(familyYamlInputSchema),
});

export type FamilyYaml = z.infer<typeof familyYamlSchema>;
export type FamilyRulesFile = z.infer<typeof familyRulesFileSchema>;

// ─── CamelCase type utilities ────────────────────────────────────────────────

type CamelCase<S extends string> = S extends `${infer P}_${infer Q}`
  ? `${P}${Capitalize<CamelCase<Q>>}`
  : S;

type CamelCaseKeys<T> = T extends readonly (infer U)[]
  ? CamelCaseKeys<U>[]
  : T extends Record<string, unknown>
    ? { [K in keyof T as K extends string ? CamelCase<K> : K]: CamelCaseKeys<T[K]> }
    : T;

// ─── Derived FamilyConfig (camelCase, with injected familyId) ────────────────

export interface TimeWindow {
  start: string;
  end: string;
}

type IdentityConfig = CamelCaseKeys<z.infer<typeof identityYamlSchema>> & { familyId: string };
type EvidenceConfig = CamelCaseKeys<z.infer<typeof evidenceYamlSchema>> & { familyId: string };
type RulesConfig = CamelCaseKeys<z.infer<typeof rulesYamlSchema>> & { familyId: string };
type RuntimeStateConfig = CamelCaseKeys<z.infer<typeof runtimeStateYamlSchema>> & {
  familyId: string;
  updatedAt: string;
};

export interface FamilyConfig {
  identity: IdentityConfig;
  evidence: EvidenceConfig;
  rules: RulesConfig;
  runtimeState?: RuntimeStateConfig;
}

export interface GlobalConfig {
  initialBalanceUsdc: number;
  spraySizeUsdc: number;
  sprayMaxMarketsPerTick: number;
  dustLaneMaxMarketsPerTick?: number;
  sprayCooldownSeconds: number;
  sprayBudgetUsdc: number;
  sprayMaxTotalPositions: number;
}

export interface FamilyRuleDefaultsConfig {
  entry: EntryRulePreset | null;
}
