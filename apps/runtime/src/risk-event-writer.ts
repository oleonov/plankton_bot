import type { RiskEventRepository, FamilyId } from "@plankton/domain";
import { normalizeReasonCode } from "./risk-event-codes.js";

export interface RiskEventWriterConfig {
  rejectCooldownMs: number;
}

const FAMILY_MODE_EVENTS: Record<string, string> = {
  family_quarantine: "family_quarantined",
  family_reduce_only: "family_reduce_only",
  family_activate: "family_activated",
};

export class RiskEventWriter {
  private readonly cooldown = new Map<string, number>();

  constructor(
    private readonly repo: RiskEventRepository,
    private readonly config: RiskEventWriterConfig,
  ) {}

  onSignalRejected(
    signal: { signalId: string; familyId: FamilyId; tokenId: string },
    reason: string,
    rejectedAt: number,
  ): void {
    const reasonCode = normalizeReasonCode(reason);
    const key = `${signal.familyId}:${reasonCode}`;
    const lastAt = this.cooldown.get(key);

    if (lastAt !== undefined && rejectedAt - lastAt < this.config.rejectCooldownMs) return;

    this.repo.insert({
      eventType: "signal_rejected",
      familyId: signal.familyId,
      payload: {
        reasonCode,
        rawReason: reason,
        signalId: signal.signalId,
        tokenId: signal.tokenId,
      },
    });
    this.cooldown.set(key, rejectedAt);
  }

  onOperatorCommand(
    action: string,
    targetFamilyId: FamilyId | null,
    commandDbId: number,
    reason: string | null,
  ): void {
    const eventType = FAMILY_MODE_EVENTS[action];
    if (!eventType || !targetFamilyId) return;

    this.repo.insert({
      eventType,
      familyId: targetFamilyId,
      payload: { commandDbId, reason },
    });
  }

  onReconciliationDrift(details: string, severity: string, timestamp: number): void {
    this.repo.insert({
      eventType: "reconciliation_drift",
      familyId: null,
      payload: { details, severity, timestamp },
    });
  }
}
