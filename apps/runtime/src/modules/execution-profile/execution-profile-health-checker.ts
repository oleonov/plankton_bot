import type { ExecutionProfileHealthStatus, FreshnessStatus } from "@krabs/domain";
import type { RiskEventRepository } from "@krabs/domain";

import {
  EXECUTION_PROFILE_METRICS,
  EXECUTION_PROFILE_RISK_EVENTS,
  writeExecutionProfileCounter,
  writeExecutionProfileGaugeEvent,
  type ExecutionProfileEventMetricWriter,
} from "./execution-profile-metrics.js";
import {
  PROFILE_STATES,
  type ExecutionProfileStateRepository,
  type Profile,
  type ProfileState,
} from "./types.js";

export interface ExecutionProfileHealthPolicy {
  healthCheckIntervalMs: number;
  rollupWindowMs: number;
  maxRollupBuckets: number;
  pendingScaleInWarnAfterMs: number;
  healthRiskEventEveryMs: number;
  anomalyDetection: {
    enabled: boolean;
    cooldownMs: number;
  };
}

export interface SignalFreshnessSnapshot {
  status: FreshnessStatus;
  reason: string;
}

export interface PendingScaleInSnapshot {
  tokenId: string;
  profile: Profile;
  createdAtMs: number;
}

export interface ExecutionProfileHealthResult {
  status: ExecutionProfileHealthStatus;
  activeTokenCount: number;
  stalePendingCount: number;
  freshness: SignalFreshnessSnapshot;
}

export interface ExecutionProfileHealthCheckerDeps {
  stateRepo: ExecutionProfileStateRepository;
  riskEvents: Pick<RiskEventRepository, "insert">;
  metrics: ExecutionProfileEventMetricWriter;
  policy: () => ExecutionProfileHealthPolicy;
  now?: () => number;
  signalFreshness?: () => SignalFreshnessSnapshot;
  pendingScaleIns?: () => readonly PendingScaleInSnapshot[];
}

const PROFILES: readonly Profile[] = ["cheap", "medium", "expensive"];

export class ExecutionProfileHealthChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRiskEventAtMs = 0;

  constructor(private readonly deps: ExecutionProfileHealthCheckerDeps) {}

  start(): void {
    const interval = this.deps.policy().healthCheckIntervalMs;
    if (interval <= 0 || this.timer != null) return;
    this.timer = setInterval(() => void this.runOnce("periodic"), interval);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.runOnce("shutdown");
  }

  async runOnce(reason: string): Promise<ExecutionProfileHealthResult> {
    const now = this.deps.now?.() ?? Date.now();
    const states = this.deps.stateRepo.findAllActive();
    const stalePendingCount = this.countStalePending(now);
    const freshness = this.deps.signalFreshness?.() ?? { status: "unknown", reason: "missing" };
    const status: ExecutionProfileHealthStatus =
      stalePendingCount > 0 || freshness.status === "stale" || freshness.status === "unknown"
        ? "warn"
        : "ok";

    this.writeActiveTokenGauges(states, now);
    writeExecutionProfileGaugeEvent(
      this.deps.metrics,
      EXECUTION_PROFILE_METRICS.signalFreshnessGauge,
      freshness.status === "stale" || freshness.status === "unknown" ? 1 : 0,
      {
        freshness: freshness.status,
        source: freshness.reason === "stub_feed" ? "stub" : "runtime",
      },
      now,
    );
    if (status === "warn") {
      writeExecutionProfileCounter(this.deps.metrics, EXECUTION_PROFILE_METRICS.healthWarning, {
        component: "health",
        status,
        reason: "none",
      });
    }

    const result = {
      status,
      activeTokenCount: states.length,
      stalePendingCount,
      freshness,
    };
    if (this.shouldEmitRiskEvent(now, status, reason)) {
      this.deps.riskEvents.insert({
        eventType: EXECUTION_PROFILE_RISK_EVENTS.healthCheck,
        payload: {
          status,
          reason,
          activeTokenCount: states.length,
          stalePendingCount,
          freshnessStatus: freshness.status,
          freshnessReason: freshness.reason,
          checkedAt: new Date(now).toISOString(),
        },
      });
      this.lastRiskEventAtMs = now;
    }
    return result;
  }

  private writeActiveTokenGauges(
    states: readonly { profile: Profile; state: ProfileState }[],
    now: number,
  ): void {
    const counts = new Map<string, number>();
    for (const row of states) {
      const key = `${row.profile}:${row.state}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const profile of PROFILES) {
      for (const state of PROFILE_STATES) {
        const count = counts.get(`${profile}:${state}`) ?? 0;
        writeExecutionProfileGaugeEvent(
          this.deps.metrics,
          EXECUTION_PROFILE_METRICS.activeTokensGauge,
          count,
          { profile, state },
          now,
        );
      }
    }
  }

  private countStalePending(now: number): number {
    const threshold = this.deps.policy().pendingScaleInWarnAfterMs;
    return (this.deps.pendingScaleIns?.() ?? []).filter(
      (pending) => now - pending.createdAtMs >= threshold,
    ).length;
  }

  private shouldEmitRiskEvent(
    now: number,
    status: ExecutionProfileHealthStatus,
    reason: string,
  ): boolean {
    if (status === "warn" || reason === "manual" || this.lastRiskEventAtMs === 0) return true;
    return now - this.lastRiskEventAtMs >= this.deps.policy().healthRiskEventEveryMs;
  }
}
