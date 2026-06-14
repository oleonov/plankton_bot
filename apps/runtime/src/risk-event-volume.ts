// These high-volume event types are strategy signal telemetry, not operational
// failures. `index.ts` builds the SQL exclusion list from this constant; add any
// future signal-only audit event here before enabling it in risk_events.
export const SIGNAL_TELEMETRY_RISK_EVENT_TYPES = [
  "signal_emitted",
  "signal_suppressed",
  "planner_suppressed_rollup",
] as const;

export interface RiskEventVolumeSnapshotInput {
  last1h: number;
  last24h: number;
  signalTelemetryLast1h: number;
  signalTelemetryLast24h: number;
  thresholdPerHour: number;
  windowStartMs: number;
}

export interface RiskEventVolumeSnapshot extends RiskEventVolumeSnapshotInput {
  operationalLast1h: number;
  operationalLast24h: number;
  warning: boolean;
  warningScope: "operational_non_signal_telemetry";
}

export function buildRiskEventVolumeSnapshot(
  input: RiskEventVolumeSnapshotInput,
): RiskEventVolumeSnapshot {
  const operationalLast1h = Math.max(0, input.last1h - input.signalTelemetryLast1h);
  const operationalLast24h = Math.max(0, input.last24h - input.signalTelemetryLast24h);
  return {
    ...input,
    operationalLast1h,
    operationalLast24h,
    warning: operationalLast1h >= input.thresholdPerHour,
    warningScope: "operational_non_signal_telemetry",
  };
}
