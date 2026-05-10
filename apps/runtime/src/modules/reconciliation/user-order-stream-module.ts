import type {
  EventBus,
  ExchangeGateway,
  ExchangeUserOrderEvent,
  ExchangeUserTradeEvent,
  FillRepository,
  MarketRepository,
  Order,
  OrderRepository,
  RuntimeModule,
} from "@krabs/domain";
import { createCommandId } from "@krabs/domain";
import type { Logger } from "../../logger.js";
import {
  findLocalOrderForExchangeFill,
  importExchangeFills,
  reconcileFills,
} from "./fill-reconciler.js";
import { reconcileOrders } from "./order-reconciler.js";
import { buildCancelTelemetry } from "./cancel-telemetry.js";

const METRICS_WINDOW_MS = 10 * 60 * 1000;
const ORPHAN_TTL_MS = 60 * 1000;
const FILL_CATCHUP_OVERLAP_MS = 5_000;
const DEDUPE_TTL_MS = 60 * 60 * 1000;
const PHANTOM_GRACE_MS = 90_000;

interface BufferedTradeEvent {
  readonly event: ExchangeUserTradeEvent;
  readonly firstSeenAt: number;
}

interface LatencySummary {
  readonly count: number;
  readonly avgMs: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface UserOrderStreamMetricsSnapshot {
  readonly windowStartMs: number;
  readonly wsEventsReceived: number;
  readonly wsEventsReceivedPerSec: number;
  readonly wsFills: number;
  readonly pollingFills: number;
  readonly wsLatencyMs: LatencySummary | null;
  readonly orphanBufferSize: number;
  readonly dedupeHits: number;
  readonly reconnectCount: number;
  readonly wsEventGapDetected: number;
}

export interface UserOrderStreamModuleDeps {
  gateway: ExchangeGateway;
  bus: EventBus;
  marketRepo: MarketRepository;
  orderRepo: OrderRepository;
  fillRepo: FillRepository;
  log: Logger;
  fillCatchupOverlapMs?: number;
  orphanTtlMs?: number;
  now?: () => number;
}

interface UserOrderStreamWindow {
  windowStartMs: number;
  wsEventsReceived: number;
  wsFills: number;
  pollingFills: number;
  latencySamplesMs: number[];
  dedupeHits: number;
  reconnectCount: number;
  wsEventGapDetected: number;
}

interface ManagedUserEventStream {
  close(): void;
  setConditionIds(conditionIds: readonly string[]): void;
}

export class UserOrderStreamModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly fillCatchupOverlapMs: number;
  private readonly orphanTtlMs: number;
  private readonly now: () => number;
  private readonly seenEventKeys = new Map<string, number>();
  private readonly orphanBuffer = new Map<string, BufferedTradeEvent>();
  private readonly window: UserOrderStreamWindow;
  private unsubs: Array<() => void> = [];
  private stream: ManagedUserEventStream | null = null;
  private started = false;
  private catchupInFlight = false;
  private seenPruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: UserOrderStreamModuleDeps) {
    this.log = deps.log.child({ module: "user-order-stream" });
    this.fillCatchupOverlapMs = deps.fillCatchupOverlapMs ?? FILL_CATCHUP_OVERLAP_MS;
    this.orphanTtlMs = deps.orphanTtlMs ?? ORPHAN_TTL_MS;
    this.now = deps.now ?? Date.now;
    this.window = this.createEmptyWindow(this.now());
  }

  async start(): Promise<void> {
    this.started = true;
    // Defense-in-depth: own the dedupe-map prune cadence instead of relying
    // solely on the external 30s getMetricsSnapshot() poll. DEDUPE_TTL_MS is
    // 1h, so pruning every 5 minutes is more than enough; unref'ed so tests
    // and shutdown aren't blocked.
    this.seenPruneTimer = setInterval(
      () => {
        this.pruneSeenEventKeys(this.now());
        this.pruneExpiredOrphans(this.now());
      },
      5 * 60 * 1000,
    );
    if (typeof this.seenPruneTimer.unref === "function") this.seenPruneTimer.unref();
    this.unsubs.push(
      this.deps.bus.subscribe("OrderPlaced", async () => {
        this.refreshSubscribedConditions();
        await this.flushOrphanBuffer();
      }),
    );
    this.unsubs.push(
      this.deps.bus.subscribe("OrderCancelled", async () => {
        this.refreshSubscribedConditions();
      }),
    );
    this.unsubs.push(
      this.deps.bus.subscribe("FillReceived", async () => {
        this.refreshSubscribedConditions();
      }),
    );

    if (typeof this.deps.gateway.createUserEventStream !== "function") {
      this.log.info("user websocket stream unavailable on current gateway — module disabled");
      return;
    }

    this.stream = this.deps.gateway.createUserEventStream({
      onTradeEvents: async (events) => {
        await this.handleTradeEvents(events);
      },
      onOrderEvents: async (events) => {
        await this.handleOrderEvents(events);
      },
      onGapDetected: async ({ reason, timestamp }) => {
        this.rotateWindow(timestamp);
        this.window.wsEventGapDetected++;
        this.window.reconnectCount++;
        this.log.warn({ reason }, "user websocket gap detected — running catch-up sync");
        await this.runCatchupSync("gap");
        this.refreshSubscribedConditions();
      },
      onError: async (error) => {
        this.log.warn({ err: error }, "user websocket stream error");
      },
    }) as ManagedUserEventStream;

    this.refreshSubscribedConditions();
    await this.runCatchupSync("startup");
    await this.flushOrphanBuffer();
    this.log.info("user websocket stream module started");
  }

  async stop(): Promise<void> {
    this.stream?.close();
    this.stream = null;
    if (this.seenPruneTimer) {
      clearInterval(this.seenPruneTimer);
      this.seenPruneTimer = null;
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.started = false;
    this.log.info("user websocket stream module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.started) return { ok: false, detail: "not started" };
    if (typeof this.deps.gateway.createUserEventStream !== "function") {
      return { ok: true, detail: "disabled: gateway has no user stream" };
    }
    const metrics = this.getMetricsSnapshot();
    return {
      ok: true,
      detail: `events=${metrics.wsEventsReceived} wsFills=${metrics.wsFills} orphanBuffer=${metrics.orphanBufferSize} reconnects=${metrics.reconnectCount}`,
    };
  }

  getMetricsSnapshot(): UserOrderStreamMetricsSnapshot {
    const nowMs = this.now();
    this.rotateWindow(nowMs);
    this.pruneSeenEventKeys(nowMs);
    this.pruneExpiredOrphans(nowMs);
    const elapsedSeconds = Math.max(1, Math.floor((nowMs - this.window.windowStartMs) / 1000));
    return {
      windowStartMs: this.window.windowStartMs,
      wsEventsReceived: this.window.wsEventsReceived,
      wsEventsReceivedPerSec: Number((this.window.wsEventsReceived / elapsedSeconds).toFixed(3)),
      wsFills: this.window.wsFills,
      pollingFills: this.window.pollingFills,
      wsLatencyMs: summarizeLatency(this.window.latencySamplesMs),
      orphanBufferSize: this.orphanBuffer.size,
      dedupeHits: this.window.dedupeHits,
      reconnectCount: this.window.reconnectCount,
      wsEventGapDetected: this.window.wsEventGapDetected,
    };
  }

  recordPollingFills(imported: number): void {
    if (imported <= 0) return;
    this.rotateWindow(this.now());
    this.window.pollingFills += imported;
  }

  private async handleTradeEvents(events: readonly ExchangeUserTradeEvent[]): Promise<void> {
    for (const event of events) {
      const nowMs = this.now();
      this.noteEvent(nowMs, event.timestamp);
      const dedupeKey = buildTradeDedupeKey(event);
      if (this.isDuplicateEvent(dedupeKey, nowMs)) {
        this.window.dedupeHits++;
        continue;
      }
      this.rememberEvent(dedupeKey, nowMs);

      if (!this.hasLocalOrderForTrade(event)) {
        this.orphanBuffer.set(dedupeKey, { event, firstSeenAt: nowMs });
        continue;
      }

      await this.importTradeEvent(event);
    }

    await this.flushOrphanBuffer();
  }

  private async handleOrderEvents(events: readonly ExchangeUserOrderEvent[]): Promise<void> {
    for (const event of events) {
      const nowMs = this.now();
      this.noteEvent(nowMs, event.timestamp);
      const dedupeKey = buildOrderDedupeKey(event);
      if (this.isDuplicateEvent(dedupeKey, nowMs)) {
        this.window.dedupeHits++;
        continue;
      }
      this.rememberEvent(dedupeKey, nowMs);
      await this.applyOrderEvent(event);
    }

    await this.flushOrphanBuffer();
  }

  private async importTradeEvent(event: ExchangeUserTradeEvent): Promise<void> {
    const result = await importExchangeFills([...event.fills], {
      fillRepo: this.deps.fillRepo,
      orderRepo: this.deps.orderRepo,
      bus: this.deps.bus,
      log: this.log,
      gateway: this.deps.gateway,
    });
    this.window.wsFills += result.imported;
    if (result.skipped > 0) {
      this.window.dedupeHits += result.skipped;
    }
  }

  private async applyOrderEvent(event: ExchangeUserOrderEvent): Promise<void> {
    const localOrder = this.findLocalOrderForOrderEvent(event);
    if (!localOrder) {
      this.log.debug(
        {
          exchangeOrderId: event.orderId,
          clientOrderId: event.clientOrderId,
          event: event.event,
        },
        "user websocket order event has no matching local order",
      );
      return;
    }

    const nextStatus = resolveLocalOrderStatus(event);
    const currentStatus = localOrder.status;
    if (!shouldApplyOrderStatusTransition(currentStatus, nextStatus)) {
      return;
    }
    const shouldPublishCancel =
      nextStatus === "cancelled" && currentStatus !== "cancelled" && currentStatus !== "filled";

    if (nextStatus != null || localOrder.exchangeOrderId !== event.orderId) {
      // Only stamp cancel reason + telemetry on the FIRST transition into
      // `cancelled`. WS echoes for already-cancelled orders must not
      // overwrite a prior cancel reason (e.g. `stale_entry_ttl`) or
      // telemetry payload written by ExecutionModule / Reconciler.
      if (shouldPublishCancel) {
        const telemetry = buildCancelTelemetry({
          order: localOrder,
          nowMs: Date.now(),
          fillRepo: this.deps.fillRepo,
          marketRepo: this.deps.marketRepo,
        });
        this.deps.orderRepo.updateStatus(
          localOrder.orderId,
          nextStatus ?? currentStatus,
          event.orderId,
          "exchange-user-ws-cancelled",
          telemetry,
        );
      } else {
        this.deps.orderRepo.updateStatus(
          localOrder.orderId,
          nextStatus ?? currentStatus,
          event.orderId,
        );
      }
    }

    if (shouldPublishCancel) {
      await this.deps.bus.publish("OrderCancelled", {
        commandId: createCommandId(`user-ws-cancel-${event.orderId}-${event.timestamp}`),
        orderId: localOrder.orderId,
        tokenId: localOrder.tokenId,
        conditionId: localOrder.conditionId,
        reason: "exchange-user-ws-cancelled",
        signalReason: localOrder.signalReason ?? null,
        timestamp: event.timestamp,
      });
    }
  }

  private async flushOrphanBuffer(): Promise<void> {
    const nowMs = this.now();
    this.rotateWindow(nowMs);
    for (const [key, buffered] of [...this.orphanBuffer.entries()]) {
      if (nowMs - buffered.firstSeenAt > this.orphanTtlMs) {
        this.orphanBuffer.delete(key);
        this.log.warn(
          { tradeId: buffered.event.tradeId },
          "dropping expired orphan websocket trade",
        );
        continue;
      }
      if (!this.hasLocalOrderForTrade(buffered.event)) continue;
      this.orphanBuffer.delete(key);
      await this.importTradeEvent(buffered.event);
    }
  }

  private async runCatchupSync(reason: "startup" | "gap"): Promise<void> {
    if (this.catchupInFlight) return;
    this.catchupInFlight = true;
    try {
      const latestFillTimestamp = this.deps.fillRepo.getLatestTimestamp() ?? 0;
      await reconcileFills(
        {
          gateway: this.deps.gateway,
          fillRepo: this.deps.fillRepo,
          orderRepo: this.deps.orderRepo,
          bus: this.deps.bus,
          log: this.log,
        },
        Math.max(0, latestFillTimestamp - this.fillCatchupOverlapMs),
      );
      await reconcileOrders({
        gateway: this.deps.gateway,
        orderRepo: this.deps.orderRepo,
        fillRepo: this.deps.fillRepo,
        marketRepo: this.deps.marketRepo,
        log: this.log,
        phantomGraceMs: PHANTOM_GRACE_MS,
      });
      this.refreshSubscribedConditions();
      await this.flushOrphanBuffer();
      this.log.info({ reason }, "user websocket catch-up sync complete");
    } catch (err) {
      this.log.warn({ err, reason }, "user websocket catch-up sync failed");
    } finally {
      this.catchupInFlight = false;
    }
  }

  private hasLocalOrderForTrade(event: ExchangeUserTradeEvent): boolean {
    return event.fills.some(
      (fill) => findLocalOrderForExchangeFill(this.deps.orderRepo, fill, this.log) != null,
    );
  }

  private findLocalOrderForOrderEvent(event: ExchangeUserOrderEvent): Order | null {
    if (event.clientOrderId) {
      const byClientOrderId = this.deps.orderRepo.findByClientOrderId(event.clientOrderId);
      if (byClientOrderId) return byClientOrderId;
    }
    return this.deps.orderRepo.findByExchangeOrderId(event.orderId);
  }

  private noteEvent(nowMs: number, eventTimestampMs: number): void {
    this.rotateWindow(nowMs);
    this.window.wsEventsReceived++;
    if (eventTimestampMs > 0) {
      this.window.latencySamplesMs.push(Math.max(0, nowMs - eventTimestampMs));
    }
  }

  private rotateWindow(nowMs: number): void {
    if (nowMs - this.window.windowStartMs <= METRICS_WINDOW_MS) return;
    this.window.windowStartMs = nowMs;
    this.window.wsEventsReceived = 0;
    this.window.wsFills = 0;
    this.window.pollingFills = 0;
    this.window.latencySamplesMs = [];
    this.window.dedupeHits = 0;
    this.window.reconnectCount = 0;
    this.window.wsEventGapDetected = 0;
  }

  private pruneExpiredOrphans(nowMs: number): void {
    for (const [key, buffered] of this.orphanBuffer.entries()) {
      if (nowMs - buffered.firstSeenAt <= this.orphanTtlMs) continue;
      this.orphanBuffer.delete(key);
    }
  }

  private pruneSeenEventKeys(nowMs: number): void {
    for (const [key, seenAt] of this.seenEventKeys.entries()) {
      if (nowMs - seenAt <= DEDUPE_TTL_MS) continue;
      this.seenEventKeys.delete(key);
    }
  }

  private isDuplicateEvent(key: string, nowMs: number): boolean {
    const seenAt = this.seenEventKeys.get(key);
    return seenAt != null && nowMs - seenAt <= DEDUPE_TTL_MS;
  }

  private rememberEvent(key: string, nowMs: number): void {
    this.seenEventKeys.set(key, nowMs);
  }

  private createEmptyWindow(nowMs: number): UserOrderStreamWindow {
    return {
      windowStartMs: nowMs,
      wsEventsReceived: 0,
      wsFills: 0,
      pollingFills: 0,
      latencySamplesMs: [],
      dedupeHits: 0,
      reconnectCount: 0,
      wsEventGapDetected: 0,
    };
  }

  private refreshSubscribedConditions(): void {
    if (!this.stream) return;
    const conditionIds = new Set<string>();
    for (const order of this.deps.orderRepo.findOpen()) {
      const market = this.deps.marketRepo.findByTokenId(order.tokenId);
      if (!market) continue;
      conditionIds.add(market.conditionId);
    }
    this.stream.setConditionIds([...conditionIds]);
  }
}

function buildTradeDedupeKey(event: ExchangeUserTradeEvent): string {
  return `trade:${event.tradeId}:${event.status}`;
}

function buildOrderDedupeKey(event: ExchangeUserOrderEvent): string {
  return [
    "order",
    event.orderId,
    event.event,
    event.status ?? "unknown",
    event.sizeFilled ?? "na",
    event.sizeRemaining ?? "na",
  ].join(":");
}

function resolveLocalOrderStatus(
  event: ExchangeUserOrderEvent,
): "open" | "partially-filled" | "filled" | "cancelled" | null {
  if (
    event.event === "CANCELLATION" ||
    event.status === "CANCELLED" ||
    event.status === "EXPIRED"
  ) {
    return "cancelled";
  }
  if (event.status === "FILLED") {
    return "filled";
  }
  if (event.status === "PARTIALLY_FILLED") {
    return "partially-filled";
  }
  if ((event.sizeFilled ?? 0) > 0 && (event.sizeRemaining ?? 0) > 0) {
    return "partially-filled";
  }
  if (event.status === "OPEN" || event.event === "PLACEMENT") {
    return "open";
  }
  return null;
}

function shouldApplyOrderStatusTransition(
  currentStatus: Order["status"],
  nextStatus: "open" | "partially-filled" | "filled" | "cancelled" | null,
): boolean {
  if (nextStatus == null) return true;
  if (currentStatus === "filled" || currentStatus === "cancelled" || currentStatus === "rejected") {
    return nextStatus === currentStatus;
  }
  const rank = (status: Order["status"] | "open" | "partially-filled" | "filled" | "cancelled") => {
    switch (status) {
      case "pending":
        return 0;
      case "open":
        return 1;
      case "partially-filled":
        return 2;
      case "filled":
      case "cancelled":
      case "rejected":
        return 3;
      default:
        return 0;
    }
  };
  return rank(nextStatus) >= rank(currentStatus);
}

function summarizeLatency(samplesMs: readonly number[]): LatencySummary | null {
  if (samplesMs.length === 0) return null;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    avgMs: Math.round(sum / sorted.length),
    minMs: sorted[0]!,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1]!,
  };
}

function percentile(sortedSamplesMs: readonly number[], q: number): number {
  if (sortedSamplesMs.length === 0) return 0;
  const index = Math.min(
    sortedSamplesMs.length - 1,
    Math.max(0, Math.ceil(sortedSamplesMs.length * q) - 1),
  );
  return sortedSamplesMs[index]!;
}
