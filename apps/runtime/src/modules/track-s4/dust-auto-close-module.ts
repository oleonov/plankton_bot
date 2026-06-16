import type {
  ConditionId,
  EventBus,
  RuntimeModule,
  TokenId,
  TrackS4DustAutoCloseConfig,
} from "@krabs/domain";
import { PositionStatus, createCommandId } from "@krabs/domain";
import { buildClientOrderId } from "@krabs/domain/node";

import type { DustAutoCloseRepository } from "./dust-auto-close-repository.js";
import { computeDustCleanup } from "./dust-cleanup-decider.js";

export interface DustAutoCloseCandidate {
  tokenId: TokenId;
  conditionId: ConditionId;
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

export interface DustAutoCloseModuleDeps {
  bus: EventBus;
  repository: DustAutoCloseRepository;
  policy: () => TrackS4DustAutoCloseConfig;
  candidateProvider: DustAutoCloseCandidateProvider;
  redeemInFlightGuard?: ((conditionId: ConditionId) => boolean) | undefined;
  isProfileOwned?: ((tokenId: TokenId) => boolean) | undefined;
  runtimeMetrics?: DustAutoCloseMetricWriter | undefined;
  riskEvents?: DustAutoCloseRiskEventWriter | undefined;
  now?: (() => number) | undefined;
}

export class DustAutoCloseModule implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;

  constructor(private readonly deps: DustAutoCloseModuleDeps) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const policy = this.policy();
    if (!policy.enabled) return;

    this.unsubscribers.push(
      this.deps.bus.subscribe("PositionUpdated", async ({ position }) => {
        if (position.status === PositionStatus.Closed) {
          this.recordSuccessfulClose(position.tokenId);
        }
      }),
    );
    this.timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => {
        this.writeCounter("dust_auto_close_skipped", 1, {
          reason: "scan_error",
          errorClass: errorClass(err),
        });
      });
    }, policy.scanIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
    this.started = false;
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

    await this.publishCloseOrder(candidate, decision.limitPrice!, decision.sellSize!, now);
    this.deps.repository.markAttempted(
      candidate.tokenId,
      decision.reason,
      now,
      now + policy.retryBackoffMs,
    );
    this.writeCounter("dust_auto_close_attempted", 1);
    this.insertRiskEvent("dust_position_auto_closed", {
      tokenId: String(candidate.tokenId),
      conditionId: String(candidate.conditionId),
      price: decision.limitPrice,
      size: decision.sellSize,
      liquidationValueUsdc: candidate.liquidationValueUsdc,
      costBasisUsdc: candidate.costBasisUsdc,
    });
  }

  private async publishCloseOrder(
    candidate: DustAutoCloseCandidate,
    price: number,
    size: number,
    timestamp: number,
  ): Promise<void> {
    const signalId = `track_s4_dust_auto_close_${String(candidate.tokenId)}_${timestamp}`;
    await this.deps.bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId(signalId),
        clientOrderId: buildClientOrderId({
          signalId,
          tokenId: candidate.tokenId,
          side: "sell",
        }),
        source: "strategy",
        tokenId: candidate.tokenId,
        conditionId: candidate.conditionId,
        side: "sell",
        size,
        price,
        postOnly: false,
        orderType: "GTC",
        tickSize: candidate.tickSize,
        negRisk: candidate.negRisk,
        sequenceInTick: 0,
        signalReason: "dust-auto-close",
        signalId,
        decisionRuleId: "TRACK_S4_DUST_AUTO_CLOSE",
        signalTimestamp: new Date(timestamp).toISOString(),
        metadata: {
          source: "track_s4_dust_auto_close",
        },
      },
      timestamp,
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

function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}
