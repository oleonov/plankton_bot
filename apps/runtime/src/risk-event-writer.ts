import type { RiskEventRepository } from "@plankton/domain";
import { normalizeReasonCode } from "./risk-event-codes.js";

export interface RiskEventWriterConfig {
  rejectCooldownMs: number;
}

export class RiskEventWriter {
  private readonly cooldown = new Map<string, number>();
  // Opportunistic prune cadence: walk the cooldown map on every ~1000 calls.
  // Entries are small but grow 1:1 with (tokenId × reasonCode) pairs seen.
  private callsSinceLastPrune = 0;

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

  onOperatorCommand(
    action: string,
    _targetId: string | null,
    commandDbId: number,
    reason: string | null,
    initiatorType?: string,
  ): void {
    this.repo.insert({
      eventType: "operator_command",
      payload: { action, commandDbId, reason, initiatorType: initiatorType ?? null },
    });
  }

  onReconciliationDrift(details: string, severity: string, timestamp: number): void {
    this.repo.insert({
      eventType: "reconciliation_drift",
      payload: { details, severity, timestamp },
    });
  }
}
