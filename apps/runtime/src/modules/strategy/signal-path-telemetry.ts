import type { Logger } from "../../logger.js";

export interface SignalPathAggregateSnapshot {
  readonly signalsApproved: number;
  readonly signalsSkippedLateCooldown: number;
  readonly signalsSkippedEarlyCooldown: number;
  readonly signalsRejectedByReason: Readonly<Record<string, number>>;
  readonly sampleSignalId: string | null;
}

export class SignalPathTelemetry {
  private signalsApproved = 0;
  private signalsSkippedLateCooldown = 0;
  private signalsSkippedEarlyCooldown = 0;
  private sampleSignalId: string | null = null;
  private readonly signalsRejectedByReason = new Map<string, number>();
  private approvedDebugCounter = 0;
  private lateCooldownDebugCounter = 0;

  recordApproved(signalId: string): boolean {
    this.signalsApproved++;
    this.sampleSignalId = signalId;
    this.approvedDebugCounter++;
    return this.approvedDebugCounter % 100 === 0;
  }

  recordLateCooldown(signalId: string): boolean {
    this.signalsSkippedLateCooldown++;
    this.sampleSignalId = signalId;
    this.lateCooldownDebugCounter++;
    return this.lateCooldownDebugCounter % 100 === 0;
  }

  recordEarlyCooldown(signalId: string): void {
    this.signalsSkippedEarlyCooldown++;
    this.sampleSignalId = signalId;
  }

  recordRejected(signalId: string, reason: string): void {
    this.sampleSignalId = signalId;
    this.signalsRejectedByReason.set(reason, (this.signalsRejectedByReason.get(reason) ?? 0) + 1);
  }

  snapshotAndReset(): SignalPathAggregateSnapshot {
    const snapshot: SignalPathAggregateSnapshot = {
      signalsApproved: this.signalsApproved,
      signalsSkippedLateCooldown: this.signalsSkippedLateCooldown,
      signalsSkippedEarlyCooldown: this.signalsSkippedEarlyCooldown,
      signalsRejectedByReason: Object.fromEntries(this.signalsRejectedByReason),
      sampleSignalId: this.sampleSignalId,
    };
    this.signalsApproved = 0;
    this.signalsSkippedLateCooldown = 0;
    this.signalsSkippedEarlyCooldown = 0;
    this.signalsRejectedByReason.clear();
    this.sampleSignalId = null;
    return snapshot;
  }

  logAggregate(logger: Logger, snapshot: SignalPathAggregateSnapshot, periodSec: number): void {
    const total =
      snapshot.signalsApproved +
      snapshot.signalsSkippedLateCooldown +
      snapshot.signalsSkippedEarlyCooldown +
      Object.values(snapshot.signalsRejectedByReason).reduce((sum, value) => sum + value, 0);
    if (total === 0) return;

    const rejectedFields: Record<string, number> = {};
    for (const [reason, count] of Object.entries(snapshot.signalsRejectedByReason)) {
      rejectedFields[`signals_rejected_${sanitizeReason(reason)}`] = count;
    }

    logger.info(
      {
        event: "signal_path_aggregate",
        period_sec: periodSec,
        signals_approved: snapshot.signalsApproved,
        signals_skipped_late_cooldown: snapshot.signalsSkippedLateCooldown,
        signals_skipped_early_cooldown: snapshot.signalsSkippedEarlyCooldown,
        ...rejectedFields,
        sample_signal_id: snapshot.sampleSignalId,
      },
      "signal path aggregate",
    );
  }
}

function sanitizeReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
