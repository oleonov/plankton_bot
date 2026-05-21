import type { Logger } from "../../logger.js";

export interface SignalPathAggregateSnapshot {
  readonly signalsApproved: number;
  readonly signalsSkippedLateCooldown: number;
  readonly signalsSkippedEarlyCooldown: number;
  readonly cooldownSignalDedupe: CooldownSignalDedupeSnapshot;
  readonly signalsRejectedByReason: Readonly<Record<string, number>>;
  readonly sampleSignalId: string | null;
}

export interface CooldownSignalDedupeSnapshot {
  readonly total: number;
  readonly earlyOnly: number;
  readonly lateOnly: number;
  readonly earlyAndLate: number;
  readonly duplicateEarly: number;
  readonly duplicateLate: number;
}

const COOLDOWN_PHASE_EARLY = 1;
const COOLDOWN_PHASE_LATE = 2;

export class SignalPathTelemetry {
  private signalsApproved = 0;
  private signalsSkippedLateCooldown = 0;
  private signalsSkippedEarlyCooldown = 0;
  private sampleSignalId: string | null = null;
  private readonly signalsRejectedByReason = new Map<string, number>();
  private readonly cooldownSignalPhases = new Map<string, number>();
  private approvedDebugCounter = 0;
  private lateCooldownDebugCounter = 0;
  private duplicateEarlyCooldownSignals = 0;
  private duplicateLateCooldownSignals = 0;

  recordApproved(signalId: string): boolean {
    this.signalsApproved++;
    this.sampleSignalId = signalId;
    this.approvedDebugCounter++;
    return this.approvedDebugCounter % 100 === 0;
  }

  recordLateCooldown(signalId: string): boolean {
    this.signalsSkippedLateCooldown++;
    this.sampleSignalId = signalId;
    this.recordCooldownPhase(signalId, COOLDOWN_PHASE_LATE);
    this.lateCooldownDebugCounter++;
    return this.lateCooldownDebugCounter % 100 === 0;
  }

  recordEarlyCooldown(signalId: string): void {
    this.signalsSkippedEarlyCooldown++;
    this.sampleSignalId = signalId;
    this.recordCooldownPhase(signalId, COOLDOWN_PHASE_EARLY);
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
      cooldownSignalDedupe: this.snapshotCooldownSignalDedupe(),
      signalsRejectedByReason: Object.fromEntries(this.signalsRejectedByReason),
      sampleSignalId: this.sampleSignalId,
    };
    this.signalsApproved = 0;
    this.signalsSkippedLateCooldown = 0;
    this.signalsSkippedEarlyCooldown = 0;
    this.signalsRejectedByReason.clear();
    this.cooldownSignalPhases.clear();
    this.duplicateEarlyCooldownSignals = 0;
    this.duplicateLateCooldownSignals = 0;
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
        cooldown_signal_dedupe_total: snapshot.cooldownSignalDedupe.total,
        cooldown_signal_dedupe_early_only: snapshot.cooldownSignalDedupe.earlyOnly,
        cooldown_signal_dedupe_late_only: snapshot.cooldownSignalDedupe.lateOnly,
        cooldown_signal_dedupe_early_and_late: snapshot.cooldownSignalDedupe.earlyAndLate,
        cooldown_signal_dedupe_duplicate_early: snapshot.cooldownSignalDedupe.duplicateEarly,
        cooldown_signal_dedupe_duplicate_late: snapshot.cooldownSignalDedupe.duplicateLate,
        ...rejectedFields,
        sample_signal_id: snapshot.sampleSignalId,
      },
      "signal path aggregate",
    );
  }

  private recordCooldownPhase(signalId: string, phase: number): void {
    const current = this.cooldownSignalPhases.get(signalId) ?? 0;
    if ((current & phase) !== 0) {
      if (phase === COOLDOWN_PHASE_EARLY) {
        this.duplicateEarlyCooldownSignals++;
      } else {
        this.duplicateLateCooldownSignals++;
      }
      return;
    }
    this.cooldownSignalPhases.set(signalId, current | phase);
  }

  private snapshotCooldownSignalDedupe(): CooldownSignalDedupeSnapshot {
    let earlyOnly = 0;
    let lateOnly = 0;
    let earlyAndLate = 0;
    for (const phase of this.cooldownSignalPhases.values()) {
      if (phase === COOLDOWN_PHASE_EARLY) {
        earlyOnly++;
      } else if (phase === COOLDOWN_PHASE_LATE) {
        lateOnly++;
      } else if (phase === (COOLDOWN_PHASE_EARLY | COOLDOWN_PHASE_LATE)) {
        earlyAndLate++;
      }
    }
    return {
      total: this.cooldownSignalPhases.size,
      earlyOnly,
      lateOnly,
      earlyAndLate,
      duplicateEarly: this.duplicateEarlyCooldownSignals,
      duplicateLate: this.duplicateLateCooldownSignals,
    };
  }
}

function sanitizeReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
