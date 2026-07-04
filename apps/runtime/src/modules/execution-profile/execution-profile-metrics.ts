import type {
  AbandonmentReason,
  CostCapCrossedBand,
  CostCapSeverity,
  ExecutionProfileDecision,
  ExecutionProfileHealthStatus,
  ExecutionProfileName,
  FreshnessStatus,
  ProfileLadderBand,
  ScaleInMode,
  ScaleInReason,
} from "@krabs/domain";

import { PROFILE_STATES, type ProfileState } from "./types.js";

export const EXECUTION_PROFILE_METRICS = {
  assigned: "track_execution_profile_assigned",
  reclassified: "track_execution_profile_reclassified",
  stateTransition: "track_execution_profile_state_transition",
  recoveryOrphan: "track_execution_profile_recovery_orphan",
  activeTokensGauge: "track_execution_profile_active_tokens_gauge",
  costCapEnforced: "track_execution_profile_cost_cap_enforced",
  costCapUnder: "track_execution_profile_cost_cap_under",
  costCapBetween: "track_execution_profile_cost_cap_between",
  costCapOver: "track_execution_profile_cost_cap_over",
  costCapCrossed: "track_execution_profile_cost_cap_crossed",
  scaleInDecided: "track_execution_profile_scale_in_decided",
  scaleInSkipped: "track_execution_profile_scale_in_skipped",
  scaleInCostCapBlocked: "track_execution_profile_scale_in_cost_cap_blocked",
  scaleInEmitted: "track_execution_profile_scale_in_emitted",
  chainDecision: "track_execution_profile_chain_decision",
  healthWarning: "track_execution_profile_health_warning",
  healthCheck: "track_execution_profile_health_check",
  signalFreshnessGauge: "track_execution_profile_signal_freshness_gauge",
  rollupBucketGauge: "track_execution_profile_rollup_bucket_count_gauge",
  rollupOverflow: "track_execution_profile_rollup_overflow_count",
  positionAbandonedDormantPerBand: "position_abandoned_dormant_per_band",
  positionAbandonedEvaluation: "position_abandoned_evaluation",
  scaleInSkippedDormant: "scale_in_skipped_dormant",
  ladderRebuildSkippedDormant: "ladder_rebuild_skipped_dormant",
} as const;

export const EXECUTION_PROFILE_RISK_EVENTS = {
  assigned: "profile_assigned",
  reclassified: "profile_reclassified",
  stateChanged: "profile_state_changed",
  costCapDecided: "cost_cap_decided",
  scaleInDecided: "scale_in_decided",
  decisionChainRollup: "execution_profile_decision_chain_rollup",
  healthCheck: "profile_health_check",
  anomalyDetected: "profile_anomaly_detected",
  positionAbandonedDormant: "position_abandoned_dormant",
} as const;

export interface ExecutionProfileCounterWriter {
  writeCounter(name: string, value?: number, labels?: string): void;
}

export interface ExecutionProfileEventMetricWriter extends ExecutionProfileCounterWriter {
  writeEvent(metricName: string, value: number, labels: string, capturedAt: string): void;
  writeLatest?: (metricName: string, value: number, labels?: string, capturedAt?: string) => void;
}

export type ExecutionProfileLabelValue =
  | ExecutionProfileName
  | ProfileState
  | ScaleInMode
  | ScaleInReason
  | CostCapSeverity
  | CostCapCrossedBand
  | ExecutionProfileDecision
  | ExecutionProfileHealthStatus
  | FreshnessStatus
  | ProfileLadderBand
  | AbandonmentReason
  | "null"
  | "none"
  | "abandoned"
  | "kept"
  | "scale_in"
  | "cost_cap"
  | "health"
  | "profile"
  | "profile_resolver"
  | "position"
  | "runtime"
  | "stub"
  | "allow"
  | "block"
  | "skip"
  | "disabled";

export type ExecutionProfileLabels = Readonly<Record<string, ExecutionProfileLabelValue>>;

const PROFILES = new Set<ExecutionProfileName>(["cheap", "medium", "expensive"]);
const PROFILE_LADDER_BANDS = new Set<ProfileLadderBand>([
  "cheap",
  "medium_low",
  "medium_high",
  "expensive",
]);
const STATES = new Set<ProfileState>(PROFILE_STATES);
const MODES = new Set<ScaleInMode>(["up", "flat", "avg_down"]);
const SEVERITIES = new Set<CostCapSeverity>(["under_p75", "between", "over_p90"]);
const CROSSED_BANDS = new Set<CostCapCrossedBand>(["none", "normal", "aggressive"]);
const OUTCOMES = new Set<ExecutionProfileDecision>(["allow", "block", "skip", "disabled"]);
const HEALTH_STATUSES = new Set<ExecutionProfileHealthStatus>(["ok", "warn"]);
const FRESHNESS_STATUSES = new Set<FreshnessStatus>([
  "ok",
  "warn",
  "disabled",
  "stale",
  "unknown",
  "stub_active",
]);
const CHAIN_KINDS = new Set([
  "scale_in",
  "cost_cap",
  "health",
  "profile",
  "profile_resolver",
  "position",
]);
const REASONS = new Set<ScaleInReason>([
  "scale_in_disabled",
  "invalid_inputs",
  "time_gate_blocked",
  "mode_no_signal",
  "avg_down_no_recovery",
  "avg_down_disabled",
  "avg_down_collapsed_tail",
  "flat_no_trigger",
  "below_min_add",
  "near_death_add",
  "stock_close_penny_add",
  "calendar_missing",
  "stock_close_tail_damp_below_min_order",
  "cost_cap_blocked",
  "allowed",
  "add_in_flight",
  "missing_position",
  "not_active_state",
  "missing_mark_price",
]);
const ABANDONMENT_REASONS = new Set<AbandonmentReason>([
  "qualified",
  "abandonment_disabled",
  "band_disabled",
  "invalid_input",
  "state_not_eligible",
  "cost_above_probe_max",
  "buy_count_above_probe_max",
  "prior_sell",
  "first_buy_missing",
  "timer_not_elapsed",
  "pending_scale_in",
  "active_profile_ladder",
  "active_sell_order",
]);

export function serializeExecutionProfileLabels(labels: ExecutionProfileLabels): string {
  validateExecutionProfileLabels("execution_profile_metric", labels);
  const sorted = Object.fromEntries(
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify(sorted);
}

export function validateExecutionProfileLabels(
  metricName: string,
  labels: Readonly<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(labels)) {
    if (key.toLowerCase().includes("token")) {
      throw new Error(`${metricName} label ${key} is not cardinality safe`);
    }
    if (typeof value !== "string") {
      throw new Error(`${metricName} label ${key} must be a string enum`);
    }
    if (!isAllowedLabel(key, value)) {
      throw new Error(`${metricName} label ${key} has unknown value ${value}`);
    }
  }
}

export function writeExecutionProfileCounter(
  writer: ExecutionProfileCounterWriter | undefined,
  metricName: string,
  labels: ExecutionProfileLabels = {},
  value = 1,
): void {
  writer?.writeCounter(metricName, value, serializeExecutionProfileLabels(labels));
}

export function writeExecutionProfileGaugeEvent(
  writer: Pick<ExecutionProfileEventMetricWriter, "writeEvent">,
  metricName: string,
  value: number,
  labels: ExecutionProfileLabels,
  capturedAtMs: number,
): void {
  writer.writeEvent(
    metricName,
    value,
    serializeExecutionProfileLabels(labels),
    new Date(capturedAtMs).toISOString(),
  );
}

function isAllowedLabel(key: string, value: string): boolean {
  if (key === "profile" || key === "fromProfile" || key === "toProfile")
    return PROFILES.has(value as ExecutionProfileName);
  if (key === "state" || key === "from" || key === "to")
    return value === "null" || STATES.has(value as ProfileState);
  if (key === "mode") return value === "none" || MODES.has(value as ScaleInMode);
  if (key === "severity") return SEVERITIES.has(value as CostCapSeverity);
  if (key === "band")
    return (
      CROSSED_BANDS.has(value as CostCapCrossedBand) ||
      PROFILE_LADDER_BANDS.has(value as ProfileLadderBand)
    );
  if (key === "result") return value === "abandoned" || value === "kept";
  if (key === "outcome" || key === "decision")
    return OUTCOMES.has(value as ExecutionProfileDecision);
  if (key === "status")
    return (
      HEALTH_STATUSES.has(value as ExecutionProfileHealthStatus) ||
      FRESHNESS_STATUSES.has(value as FreshnessStatus)
    );
  if (key === "freshness") return FRESHNESS_STATUSES.has(value as FreshnessStatus);
  if (key === "kind" || key === "component") return CHAIN_KINDS.has(value);
  if (key === "reason")
    return (
      REASONS.has(value as ScaleInReason) ||
      ABANDONMENT_REASONS.has(value as AbandonmentReason) ||
      value === "none"
    );
  if (key === "source") return value === "stub" || value === "runtime";
  return false;
}
