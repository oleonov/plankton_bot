/**
 * DbFamilyRulesProvider — reads family rules from control.db
 * instead of YAML, scoped to a specific deployment profile.
 */

import type Database from "better-sqlite3";
import type {
  FamilyRulesProvider,
  FamilyRuleBundle,
  FamilyIdentity,
  FamilyRules,
  FamilyId,
  Regime,
  TimeWindow,
  UniverseRules,
  EntryRules,
  ScaleInRules,
  ExitRules,
  TwoSidedRules,
  ThroughputRules,
  TailSuppressionRules,
  SessionRules,
} from "@plankton/domain";
import { createFamilyId } from "@plankton/domain";

interface RawRow {
  // identity (family_catalog)
  family_id: string;
  family_key: string;
  primary_category: string;
  regime: string;
  horizon: string;
  cadence: string;
  strategy_profile: string;
  fee_tier: string | null;
  live_wallet_requirement: string | null;
  requires_post_only_for_live: number | null;
  topic_key: string | null;
  slug_pattern: string | null;
  notes: string | null;

  // universe
  enabled: number;
  action: string;
  priority_rank: number;
  allow_weekends: number;
  session_mode: string;

  // entry
  entry_mode: string;
  min_entry_price: number;
  max_entry_price: number;
  max_initial_notional_usdc: number;
  allow_high_price_one_shot: number;
  high_price_threshold: number;
  require_proven_family_above_price: number;
  preferred_entry_band: string | null;
  max_probe_count_per_market: number | null;
  entry_cooldown_seconds: number | null;
  max_new_markets_per_session: number | null;
  probe_size_usdc: number;
  add_size_usdc: number;

  // scale_in
  scale_mode: string;
  default_max_buys_per_leg: number;
  heavy_max_buys_per_leg: number;
  allow_heavy_campaigns: number;
  require_positive_recycle_history_for_scale: number;

  // exit
  exit_mode: string;
  primary_profit_model: string;
  allow_runner_extension: number;
  prefer_fast_recycle: number;
  resolution_holding_allowed: number;
  resolution_buffer_minutes: number;
  target_roi_band_low: number | null;
  target_roi_band_high: number | null;
  max_unmoved_hold_hours: number | null;
  max_tail_hold_hours: number | null;

  // two_sided
  allow_two_sided: number;
  two_sided_mode: string;
  min_activity_for_two_sided: number | null;

  // throughput
  max_concurrent_orders_per_family: number | null;
  max_probe_in_flight_per_token: number | null;
  max_entry_signals_per_tick_per_family: number | null;
  fast_lane_enabled: number | null;
  dust_lane_enabled: number | null;

  // tail_suppression
  max_open_value_usdc: number;
  max_active_markets: number;
  max_dust_positions: number;
  tail_quarantine_threshold_usdc: number;
  tail_quarantine_threshold_ratio: number;
  stale_tail_prune_enabled: number;
  threshold_cleanup_required: number;
  auto_settle_resolved_markets: number;

  // session
  active_windows_utc: string;
  reduced_windows_utc: string;
  weekday_bias: string;
  weekend_mode: string;
}

const LOAD_SQL = `
  SELECT
    c.family_id, c.family_key, c.primary_category, c.regime,
    c.horizon, c.cadence, c.strategy_profile,
    c.fee_tier, c.live_wallet_requirement, c.requires_post_only_for_live,
    c.topic_key, c.slug_pattern, c.notes,
    r.*
  FROM family_deployments d
  JOIN family_catalog c ON c.family_id = d.family_id
  JOIN family_rules r   ON r.family_id = d.family_id
  WHERE d.profile = ? AND d.enabled = 1
`;

function bool(v: number): boolean {
  return v !== 0;
}

function mapRow(row: RawRow): FamilyRuleBundle {
  const familyId = createFamilyId(row.family_id);

  const identity: FamilyIdentity = {
    familyId,
    familyKey: row.family_key,
    primaryCategory: row.primary_category,
    regime: row.regime as Regime,
    horizon: row.horizon,
    cadence: row.cadence,
    strategyProfile: row.strategy_profile as FamilyIdentity["strategyProfile"],
    feeTier: (row.fee_tier as FamilyIdentity["feeTier"]) ?? null,
    liveWalletRequirement:
      (row.live_wallet_requirement as FamilyIdentity["liveWalletRequirement"]) ?? null,
    requiresPostOnlyForLive:
      row.requires_post_only_for_live == null ? null : bool(row.requires_post_only_for_live),
    topicKey: row.topic_key,
    slugPattern: row.slug_pattern,
    notes: row.notes,
  };

  const universe: UniverseRules = {
    enabled: bool(row.enabled),
    action: row.action as UniverseRules["action"],
    priorityRank: row.priority_rank,
    allowWeekends: bool(row.allow_weekends),
    sessionMode: row.session_mode as UniverseRules["sessionMode"],
  };

  const entry: EntryRules = {
    entryMode: row.entry_mode as EntryRules["entryMode"],
    minEntryPrice: row.min_entry_price,
    maxEntryPrice: row.max_entry_price,
    maxInitialNotionalUsdc: row.max_initial_notional_usdc,
    allowHighPriceOneShot: bool(row.allow_high_price_one_shot),
    highPriceThreshold: row.high_price_threshold,
    requireProvenFamilyAbovePrice: row.require_proven_family_above_price,
    preferredEntryBand: row.preferred_entry_band,
    maxProbeCountPerMarket: row.max_probe_count_per_market,
    entryCooldownSeconds: row.entry_cooldown_seconds,
    maxNewMarketsPerSession: row.max_new_markets_per_session,
    probeSizeUsdc: row.probe_size_usdc,
    addSizeUsdc: row.add_size_usdc,
  };

  const scaleIn: ScaleInRules = {
    scaleMode: row.scale_mode as ScaleInRules["scaleMode"],
    defaultMaxBuysPerLeg: row.default_max_buys_per_leg,
    heavyMaxBuysPerLeg: row.heavy_max_buys_per_leg,
    allowHeavyCampaigns: bool(row.allow_heavy_campaigns),
    requirePositiveRecycleHistoryForScale: bool(row.require_positive_recycle_history_for_scale),
  };

  const exit: ExitRules = {
    exitMode: row.exit_mode as ExitRules["exitMode"],
    primaryProfitModel: row.primary_profit_model as ExitRules["primaryProfitModel"],
    allowRunnerExtension: bool(row.allow_runner_extension),
    preferFastRecycle: bool(row.prefer_fast_recycle),
    resolutionHoldingAllowed: bool(row.resolution_holding_allowed),
    resolutionBufferMinutes: row.resolution_buffer_minutes,
    targetRoiBandLow: row.target_roi_band_low,
    targetRoiBandHigh: row.target_roi_band_high,
    maxUnmovedHoldHours: row.max_unmoved_hold_hours,
    maxTailHoldHours: row.max_tail_hold_hours,
  };

  const twoSided: TwoSidedRules = {
    allowTwoSided: bool(row.allow_two_sided),
    twoSidedMode: row.two_sided_mode as TwoSidedRules["twoSidedMode"],
    minActivityForTwoSided: row.min_activity_for_two_sided,
  };

  const throughput: ThroughputRules = {
    maxConcurrentOrdersPerFamily: row.max_concurrent_orders_per_family,
    maxProbeInFlightPerToken: row.max_probe_in_flight_per_token,
    maxEntrySignalsPerTickPerFamily: row.max_entry_signals_per_tick_per_family,
    fastLaneEnabled: row.fast_lane_enabled == null ? null : bool(row.fast_lane_enabled),
    dustLaneEnabled: row.dust_lane_enabled == null ? null : bool(row.dust_lane_enabled),
  };

  const tailSuppression: TailSuppressionRules = {
    maxOpenValueUsdc: row.max_open_value_usdc,
    maxActiveMarkets: row.max_active_markets,
    maxDustPositions: row.max_dust_positions,
    tailQuarantineThresholdUsdc: row.tail_quarantine_threshold_usdc,
    tailQuarantineThresholdRatio: row.tail_quarantine_threshold_ratio,
    staleTailPruneEnabled: bool(row.stale_tail_prune_enabled),
    thresholdCleanupRequired: bool(row.threshold_cleanup_required),
    autoSettleResolvedMarkets: bool(row.auto_settle_resolved_markets),
  };

  const session: SessionRules = {
    activeWindowsUtc: JSON.parse(row.active_windows_utc) as TimeWindow[],
    reducedWindowsUtc: JSON.parse(row.reduced_windows_utc) as TimeWindow[],
    weekdayBias: row.weekday_bias as SessionRules["weekdayBias"],
    weekendMode: row.weekend_mode as SessionRules["weekendMode"],
  };

  const rules: FamilyRules = {
    familyId,
    universe,
    entry,
    scaleIn,
    exit,
    twoSided,
    throughput,
    tailSuppression,
    session,
  };

  return { identity, rules };
}

export class DbFamilyRulesProvider implements FamilyRulesProvider {
  private cache: Map<string, FamilyRuleBundle> | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly activeProfile: string,
  ) {}

  reload(): void {
    this.cache = null;
  }

  getRule(familyId: FamilyId): FamilyRuleBundle | null {
    return this.ensureCache().get(familyId) ?? null;
  }

  isEnabled(familyId: FamilyId): boolean {
    return this.ensureCache().has(familyId);
  }

  getAllFamilies(): FamilyIdentity[] {
    return [...this.ensureCache().values()].map((b) => b.identity);
  }

  getRulesForRegime(regime: Regime): FamilyRuleBundle[] {
    return [...this.ensureCache().values()].filter((b) => b.identity.regime === regime);
  }

  private ensureCache(): Map<string, FamilyRuleBundle> {
    if (!this.cache) {
      this.cache = this.loadFromDb();
    }
    return this.cache;
  }

  private loadFromDb(): Map<string, FamilyRuleBundle> {
    const rows = this.db.prepare(LOAD_SQL).all(this.activeProfile) as RawRow[];
    const map = new Map<string, FamilyRuleBundle>();
    for (const row of rows) {
      const bundle = mapRow(row);
      map.set(row.family_id, bundle);
    }
    return map;
  }
}
