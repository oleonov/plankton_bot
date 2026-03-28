import type Database from "better-sqlite3";
import type { FamilyId } from "@plankton/domain";

/**
 * Locally-defined config shape matching @plankton/config FamilyConfig.
 * Avoids adding @plankton/config as a dependency of @plankton/db.
 */
export interface DbFamilyConfig {
  identity: Record<string, unknown>;
  evidence: Record<string, unknown>;
  rules: Record<string, unknown>;
}

/**
 * DB-backed family rules provider.
 * Loads FamilyConfig[] by JOINing family_catalog + family_evidence + family_rules,
 * producing the same shape that the YAML loader returns.
 */
export class SqliteFamilyRulesDbRepository {
  constructor(private readonly db: Database.Database) {}

  loadAll(): DbFamilyConfig[] {
    const rows = this.db
      .prepare(
        `SELECT
           c.family_id, c.family_key, c.primary_category, c.regime, c.horizon,
           c.cadence, c.strategy_profile, c.topic_key, c.slug_pattern, c.notes,
           e.evidence_status, e.evidence_score, e.promotion_state,
           e.local_trade_count, e.local_market_count, e.local_realized_pnl_fifo,
           e.open_tail_cost_usdc, e.tail_adjusted_pnl,
           e.remote_closed_realized_pnl, e.open_position_count, e.open_dust_count,
           e.both_sided_eligible, e.heavy_campaign_eligible,
           e.active_window_edge_score, e.last_validated_at,
           r.*
         FROM family_catalog c
         JOIN family_evidence e ON e.family_id = c.family_id
         JOIN family_rules r ON r.family_id = c.family_id`,
      )
      .all() as Record<string, unknown>[];

    return rows.map((row) => this.rowToConfig(row));
  }

  updateToScaledDefaults(familyId: FamilyId): void {
    this.db
      .prepare(
        `UPDATE family_rules SET
           scale_mode = 'confirm-only',
           entry_mode = 'probe-first',
           allow_heavy_campaigns = 0,
           max_open_value_usdc = 50.0,
           max_active_markets = 5,
           max_dust_positions = 3,
           require_positive_recycle_history_for_scale = 1,
           default_max_buys_per_leg = 3,
           updated_at = datetime('now')
         WHERE family_id = ?`,
      )
      .run(familyId);
  }

  overwriteRules(familyId: FamilyId, rulesJson: string): void {
    const rules = JSON.parse(rulesJson) as Record<string, unknown>;
    this.db
      .prepare(
        `UPDATE family_rules SET
           enabled = ?, action = ?, priority_rank = ?, allow_weekends = ?, session_mode = ?,
           entry_mode = ?, min_entry_price = ?, max_entry_price = ?,
           max_initial_notional_usdc = ?, allow_high_price_one_shot = ?,
           high_price_threshold = ?, require_proven_family_above_price = ?,
           preferred_entry_band = ?, max_probe_count_per_market = ?,
           entry_cooldown_seconds = ?, max_new_markets_per_session = ?,
           scale_mode = ?, default_max_buys_per_leg = ?, heavy_max_buys_per_leg = ?,
           allow_heavy_campaigns = ?, require_positive_recycle_history_for_scale = ?,
           exit_mode = ?, primary_profit_model = ?, allow_runner_extension = ?,
           prefer_fast_recycle = ?, resolution_holding_allowed = ?,
           target_roi_band_low = ?, target_roi_band_high = ?,
           max_unmoved_hold_hours = ?, max_tail_hold_hours = ?,
           allow_two_sided = ?, two_sided_mode = ?, min_activity_for_two_sided = ?,
           max_open_value_usdc = ?, max_active_markets = ?, max_dust_positions = ?,
           tail_quarantine_threshold_usdc = ?, tail_quarantine_threshold_ratio = ?,
           stale_tail_prune_enabled = ?, threshold_cleanup_required = ?,
           active_windows_utc = ?, reduced_windows_utc = ?,
           weekday_bias = ?, weekend_mode = ?,
           updated_at = datetime('now')
         WHERE family_id = ?`,
      )
      .run(
        rules.enabled ? 1 : 0,
        rules.action,
        rules.priorityRank,
        rules.allowWeekends ? 1 : 0,
        rules.sessionMode,
        rules.entryMode,
        rules.minEntryPrice,
        rules.maxEntryPrice,
        rules.maxInitialNotionalUsdc,
        rules.allowHighPriceOneShot ? 1 : 0,
        rules.highPriceThreshold,
        rules.requireProvenFamilyAbovePrice,
        rules.preferredEntryBand ?? null,
        rules.maxProbeCountPerMarket ?? null,
        rules.entryCooldownSeconds ?? null,
        rules.maxNewMarketsPerSession ?? null,
        rules.scaleMode,
        rules.defaultMaxBuysPerLeg,
        rules.heavyMaxBuysPerLeg,
        rules.allowHeavyCampaigns ? 1 : 0,
        rules.requirePositiveRecycleHistoryForScale ? 1 : 0,
        rules.exitMode,
        rules.primaryProfitModel,
        rules.allowRunnerExtension ? 1 : 0,
        rules.preferFastRecycle ? 1 : 0,
        rules.resolutionHoldingAllowed ? 1 : 0,
        rules.targetRoiBandLow ?? null,
        rules.targetRoiBandHigh ?? null,
        rules.maxUnmovedHoldHours ?? null,
        rules.maxTailHoldHours ?? null,
        rules.allowTwoSided ? 1 : 0,
        rules.twoSidedMode,
        rules.minActivityForTwoSided ?? null,
        rules.maxOpenValueUsdc,
        rules.maxActiveMarkets,
        rules.maxDustPositions,
        rules.tailQuarantineThresholdUsdc,
        rules.tailQuarantineThresholdRatio,
        rules.staleTailPruneEnabled ? 1 : 0,
        rules.thresholdCleanupRequired ? 1 : 0,
        JSON.stringify(rules.activeWindowsUtc ?? []),
        JSON.stringify(rules.reducedWindowsUtc ?? []),
        rules.weekdayBias,
        rules.weekendMode,
        familyId,
      );
  }

  private rowToConfig(row: Record<string, unknown>): DbFamilyConfig {
    const familyId = row.family_id as string;

    return {
      identity: {
        familyId,
        familyKey: row.family_key as string,
        primaryCategory: row.primary_category as string,
        regime: row.regime as string,
        horizon: row.horizon as string,
        cadence: row.cadence as string,
        strategyProfile: row.strategy_profile as string,
        topicKey: (row.topic_key as string) ?? null,
        slugPattern: (row.slug_pattern as string) ?? null,
        notes: (row.notes as string) ?? null,
      },
      evidence: {
        familyId,
        evidenceStatus: row.evidence_status as string,
        evidenceScore: row.evidence_score as number,
        promotionState: row.promotion_state as string,
        localTradeCount: row.local_trade_count as number,
        localMarketCount: row.local_market_count as number,
        localRealizedPnlFifo: row.local_realized_pnl_fifo as number,
        openTailCostUsdc: row.open_tail_cost_usdc as number,
        tailAdjustedPnl: row.tail_adjusted_pnl as number,
        remoteClosedRealizedPnl: (row.remote_closed_realized_pnl as number) ?? null,
        openPositionCount: (row.open_position_count as number) ?? null,
        openDustCount: (row.open_dust_count as number) ?? null,
        bothSidedEligible: Boolean(row.both_sided_eligible),
        heavyCampaignEligible: Boolean(row.heavy_campaign_eligible),
        activeWindowEdgeScore: (row.active_window_edge_score as number) ?? null,
        recurrenceScore: (row.recurrence_score as number) ?? null,
        recycleScore: (row.recycle_score as number) ?? null,
        liveViabilityScore: (row.live_viability_score as number) ?? null,
        toxicityPenalty: (row.toxicity_penalty as number) ?? null,
        lastValidatedAt: (row.last_validated_at as string) ?? null,
      },
      rules: {
        familyId,
        universe: {
          enabled: Boolean(row.enabled),
          action: row.action as string,
          priorityRank: row.priority_rank as number,
          allowWeekends: Boolean(row.allow_weekends),
          sessionMode: row.session_mode as string,
        },
        entry: {
          entryMode: row.entry_mode as string,
          minEntryPrice: row.min_entry_price as number,
          maxEntryPrice: row.max_entry_price as number,
          maxInitialNotionalUsdc: row.max_initial_notional_usdc as number,
          allowHighPriceOneShot: Boolean(row.allow_high_price_one_shot),
          highPriceThreshold: row.high_price_threshold as number,
          requireProvenFamilyAbovePrice: row.require_proven_family_above_price as number,
          preferredEntryBand: (row.preferred_entry_band as string) ?? null,
          maxProbeCountPerMarket: (row.max_probe_count_per_market as number) ?? null,
          entryCooldownSeconds: (row.entry_cooldown_seconds as number) ?? null,
          maxNewMarketsPerSession: (row.max_new_markets_per_session as number) ?? null,
          probeSizeUsdc: 5,
          addSizeUsdc: 4,
        },
        scaleIn: {
          scaleMode: row.scale_mode as string,
          defaultMaxBuysPerLeg: row.default_max_buys_per_leg as number,
          heavyMaxBuysPerLeg: row.heavy_max_buys_per_leg as number,
          allowHeavyCampaigns: Boolean(row.allow_heavy_campaigns),
          requirePositiveRecycleHistoryForScale: Boolean(
            row.require_positive_recycle_history_for_scale,
          ),
        },
        exit: {
          exitMode: row.exit_mode as string,
          primaryProfitModel: row.primary_profit_model as string,
          allowRunnerExtension: Boolean(row.allow_runner_extension),
          preferFastRecycle: Boolean(row.prefer_fast_recycle),
          resolutionHoldingAllowed: Boolean(row.resolution_holding_allowed),
          resolutionBufferMinutes: 60,
          targetRoiBandLow: (row.target_roi_band_low as number) ?? null,
          targetRoiBandHigh: (row.target_roi_band_high as number) ?? null,
          maxUnmovedHoldHours: (row.max_unmoved_hold_hours as number) ?? null,
          maxTailHoldHours: (row.max_tail_hold_hours as number) ?? null,
        },
        twoSided: {
          allowTwoSided: Boolean(row.allow_two_sided),
          twoSidedMode: row.two_sided_mode as string,
          minActivityForTwoSided: (row.min_activity_for_two_sided as number) ?? null,
        },
        tailSuppression: {
          maxOpenValueUsdc: row.max_open_value_usdc as number,
          maxActiveMarkets: row.max_active_markets as number,
          maxDustPositions: row.max_dust_positions as number,
          tailQuarantineThresholdUsdc: row.tail_quarantine_threshold_usdc as number,
          tailQuarantineThresholdRatio: row.tail_quarantine_threshold_ratio as number,
          staleTailPruneEnabled: Boolean(row.stale_tail_prune_enabled),
          thresholdCleanupRequired: Boolean(row.threshold_cleanup_required),
          autoSettleResolvedMarkets: true,
        },
        session: {
          activeWindowsUtc: JSON.parse((row.active_windows_utc as string) || "[]"),
          reducedWindowsUtc: JSON.parse((row.reduced_windows_utc as string) || "[]"),
          weekdayBias: row.weekday_bias as string,
          weekendMode: row.weekend_mode as string,
        },
      },
    };
  }
}
