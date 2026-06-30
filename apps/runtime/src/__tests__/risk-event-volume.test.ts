import { describe, expect, it } from "vitest";
import {
  SIGNAL_TELEMETRY_RISK_EVENT_TYPES,
  buildRiskEventVolumeSnapshot,
} from "../risk-event-volume.js";

describe("buildRiskEventVolumeSnapshot", () => {
  it("does not warn when signal telemetry is the only high-volume source", () => {
    expect(
      buildRiskEventVolumeSnapshot({
        last1h: 1712,
        last24h: 12_000,
        signalTelemetryLast1h: 1710,
        signalTelemetryLast24h: 11_500,
        thresholdPerHour: 1000,
        windowStartMs: 1,
      }),
    ).toMatchObject({
      operationalLast1h: 2,
      operationalLast24h: 500,
      warning: false,
      warningScope: "operational_non_signal_telemetry",
    });
  });

  it("classifies planner suppression rollups as signal telemetry", () => {
    expect(SIGNAL_TELEMETRY_RISK_EVENT_TYPES).toContain("planner_suppressed_rollup");
    expect(SIGNAL_TELEMETRY_RISK_EVENT_TYPES).toContain("execution_profile_decision_chain_rollup");
    expect(SIGNAL_TELEMETRY_RISK_EVENT_TYPES).toContain("dead_market_shadow");
    expect(SIGNAL_TELEMETRY_RISK_EVENT_TYPES).toContain("entry_lane_shadow");
    expect(
      buildRiskEventVolumeSnapshot({
        last1h: 1200,
        last24h: 12_000,
        signalTelemetryLast1h: 1200,
        signalTelemetryLast24h: 12_000,
        thresholdPerHour: 1000,
        windowStartMs: 1,
      }),
    ).toMatchObject({
      operationalLast1h: 0,
      operationalLast24h: 0,
      warning: false,
    });
  });

  it("warns when non-telemetry risk events exceed the hourly threshold", () => {
    expect(
      buildRiskEventVolumeSnapshot({
        last1h: 1800,
        last24h: 20_000,
        signalTelemetryLast1h: 700,
        signalTelemetryLast24h: 15_000,
        thresholdPerHour: 1000,
        windowStartMs: 1,
      }),
    ).toMatchObject({
      operationalLast1h: 1100,
      operationalLast24h: 5000,
      warning: true,
    });
  });
});
