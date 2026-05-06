import type { Database } from "better-sqlite3";
import type {
  ExecutionPolicyObservation,
  ExecutionPolicyObservationRepository,
} from "@plankton/domain";

export class SqliteExecutionPolicyObservationRepository implements ExecutionPolicyObservationRepository {
  constructor(private readonly db: Database) {}

  insert(obs: ExecutionPolicyObservation): void {
    this.db
      .prepare(
        `INSERT INTO execution_policy_observations
           (profile_id, signal_id, client_order_id, token_id, market_slug, side,
            signal_reason, decision_rule_id, sizing_rule_id, notional_bucket,
            selected_pricing_mode, selected_price, edge_price,
            bounded_price, bounded_outcome, spread_ticks, improvement_ticks,
            dead_side_observed, dead_side_bucket, dead_side_enforce_hit,
            dead_side_x60, dead_side_x120, dead_side_x300, dead_side_x900,
            time_to_end_ms, skipped_reason, pricing_delta_ticks, round_level_hit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        obs.profileId,
        obs.signalId,
        obs.clientOrderId,
        obs.tokenId,
        obs.marketSlug,
        obs.side,
        obs.signalReason,
        obs.decisionRuleId,
        obs.sizingRuleId,
        obs.notionalBucket,
        obs.selectedPricingMode,
        obs.selectedPrice,
        obs.edgePrice,
        obs.boundedPrice,
        obs.boundedOutcome,
        obs.spreadTicks,
        obs.improvementTicks,
        obs.deadSideObserved ? 1 : 0,
        obs.deadSideBucket,
        obs.deadSideEnforceHit ? 1 : 0,
        obs.deadSideX60 ? 1 : 0,
        obs.deadSideX120 ? 1 : 0,
        obs.deadSideX300 ? 1 : 0,
        obs.deadSideX900 ? 1 : 0,
        obs.timeToEndMs,
        obs.skippedReason,
        obs.pricingDeltaTicks,
        obs.roundLevelHit,
      );
  }
}
