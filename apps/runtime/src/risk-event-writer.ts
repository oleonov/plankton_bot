import type { RiskEventRepository } from "@plankton/domain";
import { normalizeReasonCode } from "./risk-event-codes.js";

export interface RiskEventWriterConfig {
  rejectCooldownMs: number;
  exposureBreachCooldownMs: number;
}

export class RiskEventWriter {
  private readonly cooldown = new Map<string, number>();
  // Opportunistic prune cadence: walk the cooldown map on every ~1000 calls.
  // Entries are small but grow 1:1 with (tokenId × reasonCode) pairs seen.
  private callsSinceLastPrune = 0;
  private lastExposureBreachAt: number | null = null;

  constructor(
    private readonly repo: RiskEventRepository,
    private readonly config: RiskEventWriterConfig,
  ) {}

  onSignalRejected(
    signal: { signalId: string; tokenId: string },
    reason: string,
    rejectedAt: number,
  ): void {
    const reasonCode = normalizeReasonCode(reason);
    const key = `${signal.tokenId}:${reasonCode}`;
    const lastAt = this.cooldown.get(key);

    if (lastAt !== undefined && rejectedAt - lastAt < this.config.rejectCooldownMs) return;

    this.repo.insert({
      eventType: "signal_rejected",
      payload: {
        reasonCode,
        rawReason: reason,
        signalId: signal.signalId,
        tokenId: signal.tokenId,
      },
    });
    this.cooldown.set(key, rejectedAt);

    this.callsSinceLastPrune++;
    if (this.callsSinceLastPrune >= 1000) {
      this.pruneExpired(rejectedAt);
      this.callsSinceLastPrune = 0;
    }
  }

  private pruneExpired(nowMs: number): void {
    const ttl = this.config.rejectCooldownMs;
    for (const [key, ts] of this.cooldown) {
      if (nowMs - ts > ttl) this.cooldown.delete(key);
    }
  }

  onReconciliationDrift(details: string, severity: string, timestamp: number): void {
    this.repo.insert({
      eventType: "reconciliation_drift",
      payload: { details, severity, timestamp },
    });
  }

  /**
   * Emit max_exposure_breach when the shared exposure formula (open positions
   * cost basis + open buy-order notional — see `calculateTotalExposure`) has
   * crossed the live-lite envelope cap. Pre-trade risk checks already reject
   * signals that WOULD breach; this fires only when the cap is already
   * exceeded by current state (post-reconciliation adjustments, stale buy
   * orders, or drift from the pre-trade model), which is an
   * operator-actionable anomaly.
   */
  onExposureBreach(currentExposureUsdc: number, limitUsdc: number, nowMs: number): void {
    if (currentExposureUsdc <= limitUsdc) return;
    if (
      this.lastExposureBreachAt !== null &&
      nowMs - this.lastExposureBreachAt < this.config.exposureBreachCooldownMs
    ) {
      return;
    }
    this.repo.insert({
      eventType: "max_exposure_breach",
      payload: {
        currentExposure: Number(currentExposureUsdc.toFixed(4)),
        limit: limitUsdc,
      },
    });
    this.lastExposureBreachAt = nowMs;
  }
}
