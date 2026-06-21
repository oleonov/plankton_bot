import { classifyExchangeRejectionReason } from "@krabs/exchange";
import type { RiskEventRepository } from "@krabs/domain";
import { DEDUPED_INTERNAL_ORDER_REJECTION_REASONS } from "./internal-order-reasons.js";
import { normalizeReasonCode } from "./risk-event-codes.js";

export interface RiskEventWriterConfig {
  rejectCooldownMs: number;
  orderRejectCooldownMs?: number;
  exchangeErrorRejectCooldownMs?: number;
  exposureBreachCooldownMs: number;
}

const DEFAULT_EXCHANGE_ERROR_REJECT_COOLDOWN_MS = 5 * 60 * 1000;
const GLOBAL_SIGNAL_REJECT_REASON_CODES = new Set(["live_lite_active_markets_cap_full"]);

export class RiskEventWriter {
  private readonly cooldown = new Map<string, number>();
  private readonly orderRejectCooldown = new Map<string, number>();
  // Opportunistic prune cadence: walk the cooldown map on every ~1000 calls.
  // Entries are small but grow 1:1 with (tokenId × reasonCode) pairs seen.
  private callsSinceLastPrune = 0;
  private lastExposureBreachAt: number | null = null;

  constructor(
    private readonly repo: RiskEventRepository,
    private readonly config: RiskEventWriterConfig,
  ) {}

  onSignalRejected(
    signal: {
      signalId: string;
      tokenId: string;
      side?: string | null;
      decisionRuleId?: string | null;
    },
    reason: string,
    rejectedAt: number,
  ): void {
    const reasonCode = normalizeReasonCode(reason);
    const key = this.signalRejectedCooldownKey(signal, reasonCode);
    const lastAt = this.cooldown.get(key);

    if (lastAt !== undefined && rejectedAt - lastAt < this.config.rejectCooldownMs) return;

    this.repo.insert({
      eventType: "signal_rejected",
      payload: {
        reasonCode,
        reason,
        rawReason: reason,
        signalId: signal.signalId,
        tokenId: signal.tokenId,
        side: signal.side ?? null,
        decisionRuleId: signal.decisionRuleId ?? null,
      },
    });
    this.cooldown.set(key, rejectedAt);
    this.pruneCooldownsPeriodically(rejectedAt);
  }

  private signalRejectedCooldownKey(
    signal: {
      tokenId: string;
      side?: string | null;
      decisionRuleId?: string | null;
    },
    reasonCode: string,
  ): string {
    if (GLOBAL_SIGNAL_REJECT_REASON_CODES.has(reasonCode)) {
      return ["global", reasonCode, signal.side ?? "", signal.decisionRuleId ?? ""].join(":");
    }
    return `${signal.tokenId}:${reasonCode}`;
  }

  onOrderRejected(event: {
    commandId: string;
    clientOrderId: string;
    tokenId: string;
    conditionId: string;
    reason: string;
    errorCode: string;
    signalReason: string | null;
    side?: string | null;
    signalId?: string | null;
    decisionRuleId?: string | null;
    signalTimestamp?: string | null;
    exchangeErrorMessage?: string | null;
    exchangeErrorDetails?: Readonly<Record<string, unknown>> | null;
    timestamp: number;
  }): void {
    if (this.shouldDedupeOrderRejected(event)) return;

    const hasExchangeError =
      event.exchangeErrorDetails != null || event.exchangeErrorMessage != null;
    const exchangeRejectionReason = hasExchangeError
      ? classifyExchangeRejectionReason(event.exchangeErrorDetails)
      : null;

    this.repo.insert({
      eventType: "order_rejected",
      payload: {
        commandId: event.commandId,
        clientOrderId: event.clientOrderId,
        tokenId: event.tokenId,
        conditionId: event.conditionId,
        reason: event.reason,
        errorCode: event.errorCode,
        signalReason: event.signalReason,
        side: event.side ?? null,
        signalId: event.signalId ?? null,
        decisionRuleId: event.decisionRuleId ?? null,
        signalTimestamp: event.signalTimestamp ?? null,
        exchangeErrorMessage: event.exchangeErrorMessage ?? null,
        exchangeRejectionReason,
        exchangeErrorDetails: event.exchangeErrorDetails ?? null,
        timestamp: event.timestamp,
      },
    });
    this.rememberOrderRejected(event);
    this.pruneCooldownsPeriodically(event.timestamp);
  }

  private pruneCooldownsPeriodically(nowMs: number): void {
    this.callsSinceLastPrune++;
    if (this.callsSinceLastPrune >= 1000) {
      this.pruneExpired(nowMs);
      this.callsSinceLastPrune = 0;
    }
  }

  private shouldDedupeOrderRejected(event: {
    tokenId: string;
    side?: string | null;
    reason: string;
    errorCode: string;
    decisionRuleId?: string | null;
    signalReason: string | null;
    exchangeErrorMessage?: string | null;
    exchangeErrorDetails?: Readonly<Record<string, unknown>> | null;
    timestamp: number;
  }): boolean {
    if (event.exchangeErrorMessage != null || event.exchangeErrorDetails != null) {
      const key = this.exchangeErrorCooldownKey(event);
      const lastAt = this.orderRejectCooldown.get(key);
      const cooldownMs =
        this.config.exchangeErrorRejectCooldownMs ?? DEFAULT_EXCHANGE_ERROR_REJECT_COOLDOWN_MS;
      return lastAt !== undefined && event.timestamp - lastAt < cooldownMs;
    }
    if (!DEDUPED_INTERNAL_ORDER_REJECTION_REASONS.has(event.reason)) return false;

    const key = this.orderRejectedCooldownKey(event);
    const lastAt = this.orderRejectCooldown.get(key);
    const cooldownMs = this.config.orderRejectCooldownMs ?? this.config.rejectCooldownMs;
    return lastAt !== undefined && event.timestamp - lastAt < cooldownMs;
  }

  private rememberOrderRejected(event: {
    tokenId: string;
    side?: string | null;
    reason: string;
    errorCode: string;
    decisionRuleId?: string | null;
    signalReason: string | null;
    exchangeErrorMessage?: string | null;
    exchangeErrorDetails?: Readonly<Record<string, unknown>> | null;
    timestamp: number;
  }): void {
    if (event.exchangeErrorMessage != null || event.exchangeErrorDetails != null) {
      this.orderRejectCooldown.set(this.exchangeErrorCooldownKey(event), event.timestamp);
      return;
    }
    if (!DEDUPED_INTERNAL_ORDER_REJECTION_REASONS.has(event.reason)) return;
    this.orderRejectCooldown.set(this.orderRejectedCooldownKey(event), event.timestamp);
  }

  private orderRejectedCooldownKey(event: {
    tokenId: string;
    side?: string | null;
    reason: string;
    decisionRuleId?: string | null;
    signalReason: string | null;
  }): string {
    return [
      event.tokenId,
      event.side ?? "",
      event.reason,
      event.decisionRuleId ?? "",
      event.signalReason ?? "",
    ].join(":");
  }

  // Exchange-error rejects are keyed by (tokenId, side, errorCode,
  // classified rejection reason):
  // transient exchange faults (rate-limits, upstream 5xx, balance/allowance
  // staleness) emit ~19k events/hour with near-identical messages. A 5-minute
  // dedup window collapses the burst to ~12 events/hour per token+errorCode
  // pair while preserving the first occurrence's full diagnostic payload.
  // Prefix "err:" prevents key collisions with internal-reason cooldowns.
  private exchangeErrorCooldownKey(event: {
    tokenId: string;
    side?: string | null;
    errorCode: string;
    exchangeErrorDetails?: Readonly<Record<string, unknown>> | null;
  }): string {
    const rejectionReason = classifyExchangeRejectionReason(event.exchangeErrorDetails);
    return ["err", event.tokenId, event.side ?? "", event.errorCode, rejectionReason].join(":");
  }

  private pruneExpired(nowMs: number): void {
    const ttl = this.config.rejectCooldownMs;
    for (const [key, ts] of this.cooldown) {
      if (nowMs - ts > ttl) this.cooldown.delete(key);
    }
    const orderTtl = this.config.orderRejectCooldownMs ?? this.config.rejectCooldownMs;
    for (const [key, ts] of this.orderRejectCooldown) {
      if (nowMs - ts > orderTtl) this.orderRejectCooldown.delete(key);
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
