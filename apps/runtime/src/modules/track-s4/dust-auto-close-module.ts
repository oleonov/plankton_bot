import type {
  ConditionId,
  EventBus,
  NormalizedMarket,
  RuntimeModule,
  RuntimeEventMap,
  TokenId,
  TrackS4DustAutoCloseConfig,
} from "@krabs/domain";
import { PositionStatus, SignalReason } from "@krabs/domain";

import type { DustAutoCloseRepository } from "./dust-auto-close-repository.js";
import { computeDustCleanup } from "./dust-cleanup-decider.js";

export interface DustAutoCloseCandidate {
  tokenId: TokenId;
  conditionId: ConditionId;
  market?: NormalizedMarket;
  status: "open" | "dust";
  liquidationValueUsdc: number;
  costBasisUsdc: number;
  sellCountTotal: number;
  lastSellAgeMs: number | null;
  size: number;
  minOrderSize: number | null;
  marketTradable: boolean;
  bestBid: number | null;
  tickSize: number;
  minValidPrice: number;
  negRisk: boolean;
}

export interface DustAutoCloseCandidateProvider {
  listCandidates(
    limit: number,
  ): readonly DustAutoCloseCandidate[] | Promise<readonly DustAutoCloseCandidate[]>;
}

export interface DustAutoCloseMetricWriter {
  writeCounter(name: string, value?: number, labels?: string): void;
}

export interface DustAutoCloseRiskEventWriter {
  insert(event: { eventType: string; payload: Readonly<Record<string, unknown>> }): void;
}

export type DustAutoClosePolicyReloadSubscriber = (handler: () => void) => () => void;

export interface DustAutoCloseModuleDeps {
  bus: EventBus;
  repository: DustAutoCloseRepository;
  policy: () => TrackS4DustAutoCloseConfig;
  candidateProvider: DustAutoCloseCandidateProvider;
  onPolicyReload?: DustAutoClosePolicyReloadSubscriber | undefined;
  redeemInFlightGuard?: ((conditionId: ConditionId) => boolean) | undefined;
  isProfileOwned?: ((tokenId: TokenId) => boolean) | undefined;
  runtimeMetrics?: DustAutoCloseMetricWriter | undefined;
  riskEvents?: DustAutoCloseRiskEventWriter | undefined;
  now?: (() => number) | undefined;
}

interface PendingDustAutoCloseAttempt {
  tokenId: TokenId;
  conditionId: ConditionId;
  reason: string;
  createdAtMs: number;
  nextRetryAtMs: number;
  liquidationValueUsdc: number;
  costBasisUsdc: number;
}

export class DustAutoCloseModule implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly unsubscribers: Array<() => void> = [];
  private policyReloadUnsubscribe: (() => void) | null = null;
  private readonly pendingAttempts = new Map<string, PendingDustAutoCloseAttempt>();
  private started = false;

  constructor(private readonly deps: DustAutoCloseModuleDeps) {}

  async start(): Promise<void> {
    this.ensurePolicyReloadSubscription();
    this.applyPolicy();
  }

  async stop(): Promise<void> {
    this.stopActive();
    this.policyReloadUnsubscribe?.();
    this.policyReloadUnsubscribe = null;
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    const policy = this.policy();
    return { ok: true, detail: policy.enabled ? "enabled" : "disabled" };
  }

  async runOnce(): Promise<void> {
    const policy = this.policy();
    if (!policy.enabled) return;
    const now = this.now();
    const candidates = await this.deps.candidateProvider.listCandidates(
      policy.maxCandidatesPerCycle,
    );
    for (const candidate of candidates) {
      await this.processCandidate(candidate, policy, now);
    }
  }

  recordSuccessfulClose(tokenId: TokenId): void {
    if (this.deps.repository.getState(tokenId) == null) return;
    this.deps.repository.markSuccessful(tokenId);
    this.writeCounter("dust_auto_close_succeeded", 1);
  }

  private ensurePolicyReloadSubscription(): void {
    if (this.policyReloadUnsubscribe != null || this.deps.onPolicyReload == null) return;
    this.policyReloadUnsubscribe = this.deps.onPolicyReload(() => {
      this.applyPolicy();
    });
  }

  private applyPolicy(): void {
    const policy = this.policy();
    if (!policy.enabled) {
      this.stopActive();
      return;
    }
    this.startActive(policy);
  }

  private startActive(policy: TrackS4DustAutoCloseConfig): void {
    if (this.started) return;
    if (!policy.enabled) return;
    this.started = true;

    this.unsubscribers.push(
      this.deps.bus.subscribe("PositionUpdated", async ({ position }) => {
        if (position.status === PositionStatus.Closed) {
          this.recordSuccessfulClose(position.tokenId);
        }
      }),
      this.deps.bus.subscribe("SignalRejected", async ({ signal }) => {
        this.handleSignalSuppressed(signal.signalId);
      }),
      this.deps.bus.subscribe("SignalConversionSkipped", async ({ signal }) => {
        this.handleSignalSuppressed(signal.signalId);
      }),
      this.deps.bus.subscribe("PlaceOrderRequested", async ({ command }) => {
        this.handlePlaceOrderRequested(command);
      }),
    );
    this.timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => {
        this.writeCounter("dust_auto_close_skipped", 1, { reason: "scan_error" });
        this.insertRiskEvent("dust_auto_close_scan_error", {
          reason: "scan_error",
          errorClass: errorClass(err),
          message: errorMessage(err),
        });
      });
    }, policy.scanIntervalMs);
    this.timer.unref?.();
  }

  private stopActive(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
    this.started = false;
  }

  private async processCandidate(
    candidate: DustAutoCloseCandidate,
    policy: TrackS4DustAutoCloseConfig,
    now: number,
  ): Promise<void> {
    const nextRetryAtMs = this.deps.repository.getNextRetryAt(candidate.tokenId);
    const decision = computeDustCleanup(
      {
        status: candidate.status,
        liquidationValueUsdc: candidate.liquidationValueUsdc,
        costBasisUsdc: candidate.costBasisUsdc,
        sellCountTotal: candidate.sellCountTotal,
        lastSellAgeMs: candidate.lastSellAgeMs,
        size: candidate.size,
        minOrderSize: candidate.minOrderSize,
        marketTradable: candidate.marketTradable,
        bestBid: candidate.bestBid,
        tickSize: candidate.tickSize,
        minValidPrice: candidate.minValidPrice,
        retryEligible: nextRetryAtMs == null || now >= nextRetryAtMs,
        profileOwned: this.deps.isProfileOwned?.(candidate.tokenId) ?? false,
        redeemInFlight: this.deps.redeemInFlightGuard?.(candidate.conditionId) ?? false,
      },
      policy,
    );

    if (decision.action === "skip") {
      this.writeCounter("dust_auto_close_skipped", 1, { reason: decision.reason });
      return;
    }
    if (decision.action === "mark_non_closeable") {
      const retryAt = now + (decision.nextRetryDelayMs ?? policy.retryBackoffMs);
      this.deps.repository.markNonCloseable(candidate.tokenId, decision.reason, now, retryAt);
      this.writeCounter("dust_auto_close_non_closeable", 1, { reason: decision.reason });
      return;
    }

    await this.publishCloseSignal(candidate, decision.limitPrice!, decision.sellSize!, now);
  }

  private async publishCloseSignal(
    candidate: DustAutoCloseCandidate,
    price: number,
    size: number,
    timestamp: number,
  ): Promise<void> {
    const signalId = `track_s4_dust_auto_close_${String(candidate.tokenId)}_${timestamp}`;
    this.pendingAttempts.set(signalId, {
      tokenId: candidate.tokenId,
      conditionId: candidate.conditionId,
      reason: "qualified",
      createdAtMs: timestamp,
      nextRetryAtMs: timestamp + this.policy().retryBackoffMs,
      liquidationValueUsdc: candidate.liquidationValueUsdc,
      costBasisUsdc: candidate.costBasisUsdc,
    });
    await this.deps.bus.publish("SignalProduced", {
      market: candidate.market ?? buildDustMarketSnapshot(candidate, timestamp),
      signal: {
        signalId,
        tokenId: candidate.tokenId,
        conditionId: candidate.conditionId,
        side: "sell",
        suggestedPrice: price,
        suggestedSize: size,
        suggestedSizeUsdc: size * price,
        reason: SignalReason.DustAutoClose,
        strategyTick: timestamp,
        sequenceInTick: 0,
        decisionRuleId: "TRACK_S4_DUST_AUTO_CLOSE",
        sizingRuleId: "dust_cleanup",
        generatedAt: new Date(timestamp).toISOString(),
      },
    });
  }

  private handleSignalSuppressed(signalId: string): void {
    const pending = this.pendingAttempts.get(signalId);
    if (pending == null) return;
    this.pendingAttempts.delete(signalId);
    this.deps.repository.markNonCloseable(
      pending.tokenId,
      "risk_gate_suppressed",
      this.now(),
      this.now() + this.policy().retryBackoffMs,
    );
    this.writeCounter("dust_auto_close_non_closeable", 1, {
      reason: "risk_gate_suppressed",
    });
  }

  private handlePlaceOrderRequested(
    command: RuntimeEventMap["PlaceOrderRequested"]["command"],
  ): void {
    const signalId = command.signalId;
    if (signalId == null) return;
    const pending = this.pendingAttempts.get(signalId);
    if (pending == null) return;
    this.pendingAttempts.delete(signalId);
    const now = this.now();
    this.deps.repository.markAttempted(
      pending.tokenId,
      pending.reason,
      now,
      now + this.policy().retryBackoffMs,
    );
    this.writeCounter("dust_auto_close_attempted", 1);
    this.insertRiskEvent("dust_position_auto_closed", {
      tokenId: String(pending.tokenId),
      conditionId: String(pending.conditionId),
      price: command.price,
      size: command.size,
      liquidationValueUsdc: pending.liquidationValueUsdc,
      costBasisUsdc: pending.costBasisUsdc,
    });
  }

  private policy(): TrackS4DustAutoCloseConfig {
    return this.deps.policy();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private writeCounter(name: string, value: number, labels?: Record<string, unknown>): void {
    this.deps.runtimeMetrics?.writeCounter(
      name,
      value,
      labels == null ? undefined : stableLabels(labels),
    );
  }

  private insertRiskEvent(eventType: string, payload: Readonly<Record<string, unknown>>): void {
    this.deps.riskEvents?.insert({ eventType, payload });
  }
}

function stableLabels(labels: Record<string, unknown>): string {
  return JSON.stringify(labels);
}

function buildDustMarketSnapshot(
  candidate: DustAutoCloseCandidate,
  timestamp: number,
): NormalizedMarket {
  return {
    tokenId: candidate.tokenId,
    conditionId: String(candidate.conditionId),
    slug: `track-s4-${String(candidate.tokenId)}`,
    eventSlug: null,
    eventMarketCount: 1,
    question: "Track S4 dust auto-close",
    outcome: "unknown",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: candidate.marketTradable,
    tickSize: candidate.tickSize,
    negRisk: candidate.negRisk,
    acceptingOrders: candidate.marketTradable,
    enableOrderBook: true,
    bestBid: candidate.bestBid,
    bestAsk: null,
    midPrice: candidate.bestBid,
    spread: null,
    minOrderSize: candidate.minOrderSize,
    bookSource: "unknown",
    gammaCreatedAt: null,
    snapshotTs: timestamp,
    featuresCapturedTs: null,
  };
}

function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
