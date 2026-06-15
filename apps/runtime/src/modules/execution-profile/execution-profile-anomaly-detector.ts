import type { ExecutionProfileName } from "@krabs/domain";
import type { RiskEventRepository } from "@krabs/domain";

import {
  EXECUTION_PROFILE_METRICS,
  EXECUTION_PROFILE_RISK_EVENTS,
  serializeExecutionProfileLabels,
  type ExecutionProfileCounterWriter,
} from "./execution-profile-metrics.js";

export interface ExecutionProfileAnomalyPolicy {
  enabled: boolean;
  cooldownMs: number;
}

export interface ExecutionProfileAnomaly {
  component: "scale_in" | "profile_resolver" | "cost_cap" | "health";
  reason: "stuck_pending_scale_in" | "rapid_reclassification" | "high_cost_cap_rejection_rate";
  profile: ExecutionProfileName;
  details: Readonly<Record<string, unknown>>;
}

export interface ExecutionProfileAnomalyDetectorDeps {
  riskEvents: Pick<RiskEventRepository, "insert">;
  metrics: ExecutionProfileCounterWriter;
  policy: () => ExecutionProfileAnomalyPolicy;
  now?: () => number;
}

export class ExecutionProfileAnomalyDetector {
  private readonly lastEmittedAtByKey = new Map<string, number>();

  constructor(private readonly deps: ExecutionProfileAnomalyDetectorDeps) {}

  record(anomaly: ExecutionProfileAnomaly): boolean {
    const policy = this.deps.policy();
    if (!policy.enabled) return false;
    const now = this.deps.now?.() ?? Date.now();
    const key = `${anomaly.component}:${anomaly.reason}:${anomaly.profile}`;
    const last = this.lastEmittedAtByKey.get(key);
    if (last != null && now - last < policy.cooldownMs) return false;

    this.lastEmittedAtByKey.set(key, now);
    this.deps.metrics.writeCounter(
      EXECUTION_PROFILE_METRICS.healthWarning,
      1,
      serializeExecutionProfileLabels({
        component: anomaly.component,
        reason: "none",
        profile: anomaly.profile,
      }),
    );
    this.deps.riskEvents.insert({
      eventType: EXECUTION_PROFILE_RISK_EVENTS.anomalyDetected,
      payload: {
        ...anomaly,
        detectedAt: new Date(now).toISOString(),
      },
    });
    return true;
  }
}
