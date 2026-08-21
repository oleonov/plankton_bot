// These high-volume event types are strategy signal telemetry, not operational
// failures. `index.ts` builds the SQL exclusion list from this constant; add any
// future signal-only audit event here before enabling it in risk_events.
export const SIGNAL_TELEMETRY_RISK_EVENT_TYPES = [
  "signal_emitted",
  "signal_suppressed",
  "planner_suppressed_rollup",
  "execution_profile_decision_chain_rollup",
  "entry_lane_shadow",
] as const;

/** High-volume diagnostics which are neither signals nor operational failures. */
export const NON_OPERATIONAL_DIAGNOSTIC_RISK_EVENT_TYPES = ["quote_motion_shadow_sample"] as const;

export interface RiskEventVolumeSnapshotInput {
  last1h: number;
  last24h: number;
  signalTelemetryLast1h: number;
  signalTelemetryLast24h: number;
  diagnosticTelemetryLast1h?: number;
  diagnosticTelemetryLast24h?: number;
  thresholdPerHour: number;
  windowStartMs: number;
}

export interface RiskEventVolumeSnapshot extends RiskEventVolumeSnapshotInput {
  operationalLast1h: number;
  operationalLast24h: number;
  diagnosticTelemetryLast1h: number;
  diagnosticTelemetryLast24h: number;
  warning: boolean;
  warningScope: "operational_excluding_telemetry";
}

export function buildRiskEventVolumeSnapshot(
  input: RiskEventVolumeSnapshotInput,
): RiskEventVolumeSnapshot {
  const diagnosticTelemetryLast1h = input.diagnosticTelemetryLast1h ?? 0;
  const diagnosticTelemetryLast24h = input.diagnosticTelemetryLast24h ?? 0;
  const operationalLast1h = Math.max(
    0,
    input.last1h - input.signalTelemetryLast1h - diagnosticTelemetryLast1h,
  );
  const operationalLast24h = Math.max(
    0,
    input.last24h - input.signalTelemetryLast24h - diagnosticTelemetryLast24h,
  );
  return {
    ...input,
    diagnosticTelemetryLast1h,
    diagnosticTelemetryLast24h,
    operationalLast1h,
    operationalLast24h,
    warning: operationalLast1h >= input.thresholdPerHour,
    warningScope: "operational_excluding_telemetry",
  };
}
