import { roundToTick } from "@krabs/domain";
import type { Logger } from "../../logger.js";

export interface SignalPathAggregateSnapshot {
  readonly signalsApproved: number;
  readonly signalsSkippedLateCooldown: number;
  readonly signalsSkippedEarlyCooldown: number;
  readonly cooldownSignalDedupe: CooldownSignalDedupeSnapshot;
  readonly cooldownPriceDedupe: CooldownPriceDedupeSnapshot;
  readonly signalsRejectedByReason: Readonly<Record<string, number>>;
  readonly sampleSignalId: string | null;
  readonly heap: SignalPathTelemetryHeapSnapshot;
}

export interface CooldownSignalDedupeSnapshot {
  readonly total: number;
  readonly earlyOnly: number;
  readonly lateOnly: number;
  readonly earlyAndLate: number;
  readonly duplicateEarly: number;
  readonly duplicateLate: number;
}

export interface CooldownPriceDedupeSnapshot extends CooldownSignalDedupeSnapshot {
  readonly skippedNoPrice: number;
}

export interface SignalPathTelemetryHeapSnapshot {
  readonly signalIdMapSize: number;
  readonly priceKeyMapSize: number;
  readonly heapBeforeBytes: number;
  readonly heapAfterBytes: number;
  readonly deltaBytes: number;
}

export const PRICE_KEY_WINDOW_MS = 5000;

const COOLDOWN_PHASE_EARLY = 1;
const COOLDOWN_PHASE_LATE = 2;
type CooldownTelemetrySide = "BUY" | "SELL";

export class SignalPathTelemetry {
  private signalsApproved = 0;
  private signalsSkippedLateCooldown = 0;
  private signalsSkippedEarlyCooldown = 0;
  private sampleSignalId: string | null = null;
  private readonly signalsRejectedByReason = new Map<string, number>();
  // R76a-ext showed late-only and early-only are independent scan subsets, not duplicates.
  private readonly cooldownSignalPhases = new Map<string, number>();
  private readonly cooldownPriceKeyPhases = new Map<string, number>();
  private approvedDebugCounter = 0;
  private lateCooldownDebugCounter = 0;
  private duplicateEarlyCooldownSignals = 0;
  private duplicateLateCooldownSignals = 0;
  private duplicateEarlyCooldownPriceKeys = 0;
  private duplicateLateCooldownPriceKeys = 0;
  private cooldownPriceDedupeSkippedNoPrice = 0;

  recordApproved(signalId: string): boolean {
    this.signalsApproved++;
    this.sampleSignalId = signalId;
    this.approvedDebugCounter++;
    return this.approvedDebugCounter % 100 === 0;
  }

  recordLateCooldown(
    signalId: string,
    tokenId: string,
    side: CooldownTelemetrySide,
    price: number | null | undefined,
    tickSize: number | null | undefined,
  ): boolean {
    this.signalsSkippedLateCooldown++;
    this.sampleSignalId = signalId;
    this.recordCooldownPricePhase(tokenId, side, price, tickSize, COOLDOWN_PHASE_LATE);
    this.recordCooldownPhase(signalId, COOLDOWN_PHASE_LATE);
    this.lateCooldownDebugCounter++;
    return this.lateCooldownDebugCounter % 100 === 0;
  }

  recordEarlyCooldown(
    signalId: string,
    tokenId: string,
    side: CooldownTelemetrySide,
    price: number | null | undefined,
    tickSize: number | null | undefined,
  ): void {
    this.signalsSkippedEarlyCooldown++;
    this.sampleSignalId = signalId;
    this.recordCooldownPricePhase(tokenId, side, price, tickSize, COOLDOWN_PHASE_EARLY);
    this.recordCooldownPhase(signalId, COOLDOWN_PHASE_EARLY);
  }

  recordRejected(signalId: string, reason: string): void {
    this.sampleSignalId = signalId;
    this.signalsRejectedByReason.set(reason, (this.signalsRejectedByReason.get(reason) ?? 0) + 1);
  }

  snapshotAndReset(): SignalPathAggregateSnapshot {
    const heapBeforeBytes = process.memoryUsage().heapUsed;
    const signalIdMapSize = this.cooldownSignalPhases.size;
    const priceKeyMapSize = this.cooldownPriceKeyPhases.size;
    const snapshot: SignalPathAggregateSnapshot = {
      signalsApproved: this.signalsApproved,
      signalsSkippedLateCooldown: this.signalsSkippedLateCooldown,
      signalsSkippedEarlyCooldown: this.signalsSkippedEarlyCooldown,
      cooldownSignalDedupe: this.snapshotCooldownSignalDedupe(),
      cooldownPriceDedupe: this.snapshotCooldownPriceDedupe(),
      signalsRejectedByReason: Object.fromEntries(this.signalsRejectedByReason),
      sampleSignalId: this.sampleSignalId,
      heap: {
        signalIdMapSize,
        priceKeyMapSize,
        heapBeforeBytes,
        heapAfterBytes: 0,
        deltaBytes: 0,
      },
    };
    this.signalsApproved = 0;
    this.signalsSkippedLateCooldown = 0;
    this.signalsSkippedEarlyCooldown = 0;
    this.signalsRejectedByReason.clear();
    this.cooldownSignalPhases.clear();
    this.cooldownPriceKeyPhases.clear();
    this.duplicateEarlyCooldownSignals = 0;
    this.duplicateLateCooldownSignals = 0;
    this.duplicateEarlyCooldownPriceKeys = 0;
    this.duplicateLateCooldownPriceKeys = 0;
    this.cooldownPriceDedupeSkippedNoPrice = 0;
    this.sampleSignalId = null;
    const heapAfterBytes = process.memoryUsage().heapUsed;
    return {
      ...snapshot,
      heap: {
        signalIdMapSize,
        priceKeyMapSize,
        heapBeforeBytes,
        heapAfterBytes,
        deltaBytes: heapAfterBytes - heapBeforeBytes,
      },
    };
  }

  logAggregate(logger: Logger, snapshot: SignalPathAggregateSnapshot, periodSec: number): void {
    logger.debug(
      {
        event: "signal_path_telemetry_snapshot_heap",
        priceKeyMapSize: snapshot.heap.priceKeyMapSize,
        signalIdMapSize: snapshot.heap.signalIdMapSize,
        heapBeforeBytes: snapshot.heap.heapBeforeBytes,
        heapAfterBytes: snapshot.heap.heapAfterBytes,
        deltaBytes: snapshot.heap.deltaBytes,
      },
      "signal path telemetry snapshot heap",
    );

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
        cooldown_signal_unique_signals_total: snapshot.cooldownSignalDedupe.total,
        cooldown_signal_early_only_total: snapshot.cooldownSignalDedupe.earlyOnly,
        cooldown_signal_late_only_total: snapshot.cooldownSignalDedupe.lateOnly,
        cooldown_signal_early_and_late_total: snapshot.cooldownSignalDedupe.earlyAndLate,
        cooldown_signal_duplicate_early_total: snapshot.cooldownSignalDedupe.duplicateEarly,
        cooldown_signal_duplicate_late_total: snapshot.cooldownSignalDedupe.duplicateLate,
        cooldown_signal_dedupe_total: snapshot.cooldownSignalDedupe.total,
        cooldown_signal_dedupe_early_only: snapshot.cooldownSignalDedupe.earlyOnly,
        cooldown_signal_dedupe_late_only: snapshot.cooldownSignalDedupe.lateOnly,
        cooldown_signal_dedupe_early_and_late: snapshot.cooldownSignalDedupe.earlyAndLate,
        cooldown_signal_dedupe_duplicate_early: snapshot.cooldownSignalDedupe.duplicateEarly,
        cooldown_signal_dedupe_duplicate_late: snapshot.cooldownSignalDedupe.duplicateLate,
        cooldown_price_unique_price_keys_total: snapshot.cooldownPriceDedupe.total,
        cooldown_price_early_only_total: snapshot.cooldownPriceDedupe.earlyOnly,
        cooldown_price_late_only_total: snapshot.cooldownPriceDedupe.lateOnly,
        cooldown_price_early_and_late_total: snapshot.cooldownPriceDedupe.earlyAndLate,
        cooldown_price_duplicate_early_total: snapshot.cooldownPriceDedupe.duplicateEarly,
        cooldown_price_duplicate_late_total: snapshot.cooldownPriceDedupe.duplicateLate,
        cooldown_price_skipped_no_price_total: snapshot.cooldownPriceDedupe.skippedNoPrice,
        cooldown_price_dedupe_total: snapshot.cooldownPriceDedupe.total,
        cooldown_price_dedupe_early_only: snapshot.cooldownPriceDedupe.earlyOnly,
        cooldown_price_dedupe_late_only: snapshot.cooldownPriceDedupe.lateOnly,
        cooldown_price_dedupe_early_and_late: snapshot.cooldownPriceDedupe.earlyAndLate,
        cooldown_price_dedupe_duplicate_early: snapshot.cooldownPriceDedupe.duplicateEarly,
        cooldown_price_dedupe_duplicate_late: snapshot.cooldownPriceDedupe.duplicateLate,
        cooldown_price_dedupe_skipped_no_price: snapshot.cooldownPriceDedupe.skippedNoPrice,
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

  private recordCooldownPricePhase(
    tokenId: string,
    side: CooldownTelemetrySide,
    price: number | null | undefined,
    tickSize: number | null | undefined,
    phase: number,
  ): void {
    if (
      price == null ||
      !Number.isFinite(price) ||
      tickSize == null ||
      !Number.isFinite(tickSize) ||
      tickSize <= 0
    ) {
      this.cooldownPriceDedupeSkippedNoPrice++;
      return;
    }

    const tickRoundedPrice = roundToTick(price, tickSize);
    const timeBucket = Math.floor(Date.now() / PRICE_KEY_WINDOW_MS);
    const key = `${tokenId}|${side}|${tickRoundedPrice}|${timeBucket}`;
    const current = this.cooldownPriceKeyPhases.get(key) ?? 0;
    if ((current & phase) !== 0) {
      if (phase === COOLDOWN_PHASE_EARLY) {
        this.duplicateEarlyCooldownPriceKeys++;
      } else {
        this.duplicateLateCooldownPriceKeys++;
      }
      return;
    }
    this.cooldownPriceKeyPhases.set(key, current | phase);
  }

  private snapshotCooldownSignalDedupe(): CooldownSignalDedupeSnapshot {
    return snapshotCooldownDedupe(
      this.cooldownSignalPhases,
      this.duplicateEarlyCooldownSignals,
      this.duplicateLateCooldownSignals,
    );
  }

  private snapshotCooldownPriceDedupe(): CooldownPriceDedupeSnapshot {
    return {
      ...snapshotCooldownDedupe(
        this.cooldownPriceKeyPhases,
        this.duplicateEarlyCooldownPriceKeys,
        this.duplicateLateCooldownPriceKeys,
      ),
      skippedNoPrice: this.cooldownPriceDedupeSkippedNoPrice,
    };
  }
}

function snapshotCooldownDedupe(
  phases: ReadonlyMap<string, number>,
  duplicateEarly: number,
  duplicateLate: number,
): CooldownSignalDedupeSnapshot {
  let earlyOnly = 0;
  let lateOnly = 0;
  let earlyAndLate = 0;
  for (const phase of phases.values()) {
    if (phase === COOLDOWN_PHASE_EARLY) {
      earlyOnly++;
    } else if (phase === COOLDOWN_PHASE_LATE) {
      lateOnly++;
    } else if (phase === (COOLDOWN_PHASE_EARLY | COOLDOWN_PHASE_LATE)) {
      earlyAndLate++;
    }
  }
  return {
    total: phases.size,
    earlyOnly,
    lateOnly,
    earlyAndLate,
    duplicateEarly,
    duplicateLate,
  };
}

function sanitizeReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
