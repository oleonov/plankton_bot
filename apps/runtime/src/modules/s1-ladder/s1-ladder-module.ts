import type {
  EventBus,
  Fill,
  FillRepository,
  RuntimeEventMap,
  RuntimeModule,
  NormalizedMarket,
  Order,
  OrderBookSnapshot,
  OrderRepository,
  Position,
  PositionRepository,
  RiskEventRepository,
  S1OwnershipSnapshot,
  TokenId,
  TrackS1WalkingLadderPolicy,
} from "@krabs/domain";
import {
  buildLadder,
  DEFAULT_TRACK_S1_WALKING_LADDER_POLICY,
  isS1Eligible,
  S1_LADDER_RULE_ID,
  buildS1SignalId,
  createCommandId,
  createTokenId,
  PositionStatus,
} from "@krabs/domain";
import { buildClientOrderId } from "@krabs/domain/node";
import { isBounceOwned } from "../exit-ownership/is-bounce-owned.js";
import {
  findS1CoverageWorkingSells,
  parseS1CoverageCleanup,
  resolveExactS1CoverageCleanupState,
  s1CoverageFillLookup,
} from "../../exit-coverage-cleanup.js";
import { MAKER_CAPTURE_BOOK_MAX_AGE_MS } from "../../maker-capture-reprice.js";
import { validateExecutablePrice } from "../../executable-price.js";
import { buildReservationSnapshot, getReservedSellSize } from "../execution/reservation-utils.js";
import type { Logger } from "../../logger.js";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";

export { S1_LADDER_RULE_ID };

export interface S1LadderModuleDeps {
  bus: EventBus;
  positionRepo: Pick<PositionRepository, "findOpen" | "findByTokenId">;
  orderRepo: Pick<OrderRepository, "findOpen" | "findByTokenId"> & {
    updateMetadataBulk: NonNullable<OrderRepository["updateMetadataBulk"]>;
  };
  fillRepo?: Pick<FillRepository, "findByOrderId" | "findByOrderIds"> | undefined;
  policy: () => TrackS1WalkingLadderPolicy;
  runtimeMetrics?: Pick<RuntimeMetricWriter, "writeCounter"> | undefined;
  riskEventRepo?: RiskEventRepository | undefined;
  log: Logger;
  now?: () => number;
}

interface ActivePlacement {
  expiresAtMs: number;
}

interface ActiveLadder {
  tokenId: TokenId;
  conditionId: string;
  ladderId: string;
  assumedAtMs: number;
  reason: S1OwnershipSnapshot["reason"];
  handoffStartedAtMs: number | null;
}

const ACTIVE_PLACEMENT_TTL_MS = 60_000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const SIZE_EPSILON = 1e-9;
const WORKING_ORDER_STATUSES = new Set(["pending", "open", "partially-filled"]);

interface ExactS1Ladder {
  ladderId: string;
  tierIndex: number;
  targetPrice: number;
}

interface S1OrderPlacement extends ExactS1Ladder {
  signalId: string;
  size: number;
  minOrderSize?: number;
  cleanup?: ReturnType<typeof parseS1CoverageCleanup>;
}

export class S1LadderModule implements RuntimeModule {
  readonly name = "s1-ladder";

  private readonly activePlacements = new Map<string, ActivePlacement>();
  private readonly activeLadders = new Map<string, ActiveLadder>();
  private readonly placementHistoryByToken = new Map<string, number[]>();
  private readonly handoffStartedTokens = new Set<string>();
  private unsubs: Array<() => void> = [];

  constructor(private readonly deps: S1LadderModuleDeps) {}

  async start(): Promise<void> {
    this.recoverActiveLadders();
    this.recoverPhantomOwnerships();
    this.unsubs.push(
      this.deps.bus.subscribe("MarketSnapshotHeartbeat", (payload) => this.onHeartbeat(payload)),
      this.deps.bus.subscribe("OrderCancelled", async (payload) => {
        this.releaseIfTerminal(payload.tokenId, payload.timestamp, "order_cancelled");
      }),
      this.deps.bus.subscribe("FillReceived", async (payload) => {
        this.onFill(payload);
      }),
      this.deps.bus.subscribe("PositionUpdated", async (payload) => {
        this.onPositionUpdated(payload.position);
      }),
    );
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.activePlacements.clear();
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: `activeLadders=${this.activeLadders.size}` };
  }

  isS1OwnedToken(tokenId: TokenId): boolean {
    return this.getSnapshot(tokenId)?.owned === true;
  }

  getSnapshot(tokenId: TokenId): S1OwnershipSnapshot | null {
    const active = this.activeLadders.get(String(tokenId));
    if (!active) return null;
    return {
      owned: true,
      ladderId: active.ladderId,
      assumedAtMs: active.assumedAtMs,
      reason: active.reason,
    };
  }

  private async onHeartbeat(payload: RuntimeEventMap["MarketSnapshotHeartbeat"]): Promise<void> {
    const policy = this.policy();
    this.pruneExpiredPlacements();
    for (const market of payload.markets) {
      const position = this.findOpenPosition(market.tokenId);
      if (!position) continue;
      const activeOrders = this.findActiveS1Orders(market.tokenId);
      if (activeOrders.length > 0) {
        const existing = this.activeLadders.get(String(market.tokenId));
        if (!existing || existing.reason !== "handoff") {
          this.assumeOwnership(position, market, this.resolveLadderIdFromOrders(activeOrders), {
            reason: "active_ladder",
            riskEvent: false,
          });
        }
        if (this.isHandoffTimedOut(market.tokenId, payload.timestamp, policy)) {
          await this.forceHandoffTimeout(position, market, activeOrders, payload.timestamp);
          continue;
        }
        if (this.shouldHandoff(market, payload.timestamp, policy)) {
          await this.initiateHandoff(position, market, activeOrders, payload.timestamp, policy);
          continue;
        }
        await this.placeCoverageCleanup(
          position,
          market,
          this.resolveBook(payload.booksByToken, market),
          payload.timestamp,
          policy,
        );
        continue;
      }
      const active = this.activeLadders.get(String(market.tokenId));
      if (active) {
        if (this.isHandoffTimedOut(market.tokenId, payload.timestamp, policy)) {
          this.releaseOwnership(market.tokenId, payload.timestamp, "handoff_timeout");
        } else if (
          active.reason !== "handoff" &&
          !this.hasActivePlacement(market.tokenId, payload.timestamp) &&
          payload.timestamp - active.assumedAtMs > policy.phantomOwnershipReleaseSeconds * 1000
        ) {
          this.releaseOwnership(market.tokenId, payload.timestamp, "phantom_release");
        }
        continue;
      }
      if (!policy.enabled) continue;
      if (this.activeLadders.size >= policy.maxOpenLadderTokens) {
        this.deps.runtimeMetrics?.writeCounter("track_s1_skipped_capacity_total", 1);
        continue;
      }
      if (this.isFrequencyLimited(market.tokenId, payload.timestamp, policy)) {
        this.deps.runtimeMetrics?.writeCounter("track_s1_frequency_limit_blocked", 1);
        continue;
      }
      if (this.hasActivePlacement(market.tokenId, payload.timestamp)) {
        this.deps.runtimeMetrics?.writeCounter("track_s1_frequency_limit_blocked", 1);
        continue;
      }
      const book = this.resolveBook(payload.booksByToken, market);
      const eligibility = isS1Eligible({
        position,
        book,
        marketEndDate: market.endDate,
        nowMs: payload.timestamp,
        policy,
        hasActiveS1Ladder: false,
      });
      if (!eligibility.eligible) {
        this.countEligibilitySkip(eligibility.reason);
        continue;
      }
      const plan = buildLadder({
        tokenId: market.tokenId,
        openedAt: position.openedAt,
        avgEntryPrice: position.avgEntryPrice,
        positionSize: position.size,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        tickSize: market.tickSize,
        minOrderSize: book.minOrderSize ?? 0,
        policy,
      });
      if (!plan.ok) {
        this.countEligibilitySkip(plan.reason);
        continue;
      }
      await this.placeLadder(position, market, plan, payload.timestamp);
    }
  }

  private policy(): TrackS1WalkingLadderPolicy {
    return { ...DEFAULT_TRACK_S1_WALKING_LADDER_POLICY, ...this.deps.policy() };
  }

  private findOpenPosition(tokenId: TokenId): Position | null {
    const direct = this.deps.positionRepo.findByTokenId(tokenId);
    if (direct?.status === PositionStatus.Open && direct.size > 0) return direct;
    return (
      this.deps.positionRepo
        .findOpen()
        .find((position) => position.tokenId === tokenId && position.size > 0) ?? null
    );
  }

  private findActiveS1Orders(tokenId: TokenId): Order[] {
    return this.deps.orderRepo
      .findByTokenId(tokenId)
      .filter(
        (order) =>
          order.side === "sell" &&
          order.decisionRuleId === S1_LADDER_RULE_ID &&
          WORKING_ORDER_STATUSES.has(order.status),
      );
  }

  private async placeCoverageCleanup(
    position: Position,
    market: NormalizedMarket,
    book: OrderBookSnapshot,
    timestamp: number,
    policy: TrackS1WalkingLadderPolicy,
  ): Promise<void> {
    if (isBounceOwned(position) || !this.deps.fillRepo) return;
    const allOrders = this.deps.orderRepo.findByTokenId(market.tokenId);
    const fills = this.readFills(allOrders);
    if (!fills) return;
    const working = findS1CoverageWorkingSells(allOrders, position);
    const reservedSellSize = getReservedSellSize(
      buildReservationSnapshot([...working], s1CoverageFillLookup(fills)),
      position.tokenId,
    );
    const state = resolveExactS1CoverageCleanupState({
      position,
      orders: allOrders,
      fills,
      reservedSellSize,
      numTiers: policy.numTiers,
      nowMs: timestamp,
    });
    if (
      !state ||
      !isExecutableCleanup(state.residualSize, state.targetPrice, book, market, timestamp)
    ) {
      return;
    }
    if (!this.acquirePlacement(market.tokenId, timestamp)) return;
    await this.publishCoverageCleanup(
      position,
      market,
      state,
      state.residualSize,
      book.minOrderSize!,
      state.attempt,
      timestamp,
    );
  }

  private readFills(orders: readonly Order[]): Fill[] | null {
    const unique = [...new Map(orders.map((order) => [String(order.orderId), order])).values()];
    try {
      return (
        this.deps.fillRepo?.findByOrderIds?.(unique.map((order) => order.orderId)) ??
        unique.flatMap((order) => this.deps.fillRepo?.findByOrderId(order.orderId) ?? [])
      );
    } catch (error) {
      this.deps.log.warn({ err: error }, "S1 cleanup fill evidence unavailable");
      return null;
    }
  }

  private async publishCoverageCleanup(
    position: Position,
    market: NormalizedMarket,
    ladder: ExactS1Ladder,
    residual: number,
    minOrderSize: number,
    attempt: number,
    timestamp: number,
  ): Promise<void> {
    const signalId = `s1_cleanup_${String(market.tokenId)}_${ladder.ladderId}_${attempt}`;
    await this.publishS1Order(position, market, timestamp, {
      ...ladder,
      signalId,
      size: residual,
      minOrderSize,
      cleanup: {
        version: 1,
        positionId: String(position.positionId),
        residualSize: residual,
        attempt,
      },
    });
    this.deps.runtimeMetrics?.writeCounter("track_s1_coverage_cleanup_placed", 1);
  }

  private onFill(payload: RuntimeEventMap["FillReceived"]): void {
    if (payload.side !== "sell" || payload.decisionRuleId !== S1_LADDER_RULE_ID) return;
    this.deps.runtimeMetrics?.writeCounter("track_s1_tiers_filled", 1);
    this.deps.riskEventRepo?.insert({
      eventType: "s1_ladder_filled",
      payload: {
        tokenId: String(payload.tokenId),
        conditionId: String(payload.conditionId),
        orderId: String(payload.orderId),
        price: payload.price,
        size: payload.size,
        liquidityRole: payload.liquidityRole,
        signalTimestamp: new Date(payload.timestamp).toISOString(),
      },
    });
    this.releaseIfTerminal(payload.tokenId, payload.timestamp, "fill");
  }

  private onPositionUpdated(position: Position): void {
    if (position.status !== PositionStatus.Open || position.size <= 0) {
      this.releaseOwnership(position.tokenId, this.now(), "position_closed");
    }
  }

  private recoverActiveLadders(): void {
    const ordersByToken = new Map<string, Order[]>();
    for (const order of this.deps.orderRepo.findOpen()) {
      if (order.side !== "sell" || order.decisionRuleId !== S1_LADDER_RULE_ID) continue;
      const key = String(order.tokenId);
      ordersByToken.set(key, [...(ordersByToken.get(key) ?? []), order]);
    }
    for (const [key, orders] of ordersByToken) {
      const sorted = [...orders].sort((a, b) => String(a.orderId).localeCompare(String(b.orderId)));
      const first = sorted[0];
      if (!first) continue;
      const position = this.findOpenPosition(first.tokenId);
      if (!position) continue;
      const handoffStartedAtMs = this.resolveCanonicalHandoffStartedAt(sorted);
      this.activeLadders.set(key, {
        tokenId: first.tokenId,
        conditionId: String(first.conditionId),
        ladderId: this.resolveLadderId(first),
        assumedAtMs: Date.parse(first.createdAt),
        reason: handoffStartedAtMs == null ? "active_ladder" : "handoff",
        handoffStartedAtMs,
      });
      if (handoffStartedAtMs != null) this.handoffStartedTokens.add(key);
    }
  }

  private recoverPhantomOwnerships(): void {
    const orphans = this.deps.riskEventRepo?.findOrphanS1Ownerships?.() ?? [];
    for (const orphan of orphans) {
      const tokenId = createTokenId(orphan.tokenId);
      const key = String(tokenId);
      if (this.activeLadders.has(key) || this.hasActivePlacement(tokenId, this.now())) continue;
      const activeOrders = this.findActiveS1Orders(tokenId);
      if (activeOrders.length > 0) {
        const position = this.findOpenPosition(tokenId);
        const firstOrder = activeOrders
          .slice()
          .sort((a, b) => String(a.orderId).localeCompare(String(b.orderId)))[0];
        if (!position || !firstOrder) continue;
        this.activeLadders.set(key, {
          tokenId,
          conditionId: orphan.conditionId || String(position.conditionId),
          ladderId: orphan.ladderId || this.resolveLadderId(firstOrder),
          assumedAtMs: parseTimestamp(orphan.assumedAtIso, this.now()),
          reason: "active_ladder",
          handoffStartedAtMs: null,
        });
        continue;
      }
      this.insertOwnershipRelease(tokenId, {
        conditionId: orphan.conditionId,
        ladderId: orphan.ladderId,
        reason: "phantom_release_recovery",
        timestamp: this.now(),
      });
      this.countPhantomRelease();
    }
  }

  private async placeLadder(
    position: Position,
    market: NormalizedMarket,
    plan: Extract<ReturnType<typeof buildLadder>, { ok: true }>,
    timestamp: number,
  ): Promise<void> {
    // Release A Phase 3: a bounce owner is serviced exclusively by the bounce ladder
    // — no S1 claim, no placement.
    if (isBounceOwned(position)) return;
    if (!this.acquirePlacement(market.tokenId, timestamp)) return;
    this.assumeOwnership(position, market, plan.ladderId, {
      reason: "eligible",
      riskEvent: true,
    });
    this.deps.runtimeMetrics?.writeCounter("track_s1_ladder_placed", 1);
    this.deps.runtimeMetrics?.writeCounter("track_s1_tiers_placed", plan.tiers.length);
    this.deps.runtimeMetrics?.writeCounter("track_s1_orders_placed", plan.tiers.length);

    for (const tier of plan.tiers) {
      const signalId = buildS1SignalId(market.tokenId, plan.ladderId, tier.tierIndex);
      await this.publishS1Order(position, market, timestamp, {
        ladderId: plan.ladderId,
        tierIndex: tier.tierIndex,
        targetPrice: tier.price,
        signalId,
        size: tier.size,
      });
    }

    this.deps.riskEventRepo?.insert({
      eventType: "s1_ladder_placed",
      payload: {
        tokenId: String(market.tokenId),
        conditionId: String(position.conditionId),
        ladderId: plan.ladderId,
        tiers: plan.tiers.map((tier) => ({
          tierIndex: tier.tierIndex,
          price: tier.price,
          size: tier.size,
          fraction: plan.volumeDistribution[tier.tierIndex] ?? null,
        })),
        signalTimestamp: new Date(timestamp).toISOString(),
      },
    });
  }

  private async publishS1Order(
    position: Position,
    market: NormalizedMarket,
    timestamp: number,
    placement: S1OrderPlacement,
  ): Promise<void> {
    const metadata = {
      ...(placement.minOrderSize ? { marketData: { minOrderSize: placement.minOrderSize } } : {}),
      s1: {
        ladderId: placement.ladderId,
        tierIndex: placement.tierIndex,
        targetPrice: placement.targetPrice,
        positionSizeTotal: position.size,
        handoffStartedAt: null,
        ...(placement.cleanup ? { coverageCleanupV1: placement.cleanup } : {}),
      },
    };
    await this.deps.bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId(placement.signalId),
        clientOrderId: buildClientOrderId({
          signalId: placement.signalId,
          tokenId: market.tokenId,
          side: "sell",
        }),
        source: "strategy",
        tokenId: market.tokenId,
        conditionId: position.conditionId,
        side: "sell",
        size: placement.size,
        price: placement.targetPrice,
        postOnly: true,
        orderType: "GTC",
        tickSize: market.tickSize,
        negRisk: market.negRisk,
        sequenceInTick: placement.tierIndex,
        signalReason: "repricing-exit",
        signalId: placement.signalId,
        decisionRuleId: S1_LADDER_RULE_ID,
        signalTimestamp: new Date(timestamp).toISOString(),
        positionId: position.positionId,
        metadata,
      },
      timestamp,
    });
  }

  private async initiateHandoff(
    position: Position,
    market: NormalizedMarket,
    activeOrders: readonly Order[],
    timestamp: number,
    policy: TrackS1WalkingLadderPolicy,
  ): Promise<void> {
    const key = String(market.tokenId);
    if (this.handoffStartedTokens.has(key)) return;
    const handoffStartedAt = new Date(timestamp).toISOString();
    try {
      this.deps.orderRepo.updateMetadataBulk(
        activeOrders.map((order) => ({
          orderId: order.orderId,
          metadata: withS1HandoffStartedAt(order.metadata ?? null, handoffStartedAt),
        })),
      );
    } catch (error) {
      this.deps.log.error(
        { err: error, tokenId: String(market.tokenId), orderCount: activeOrders.length },
        "Failed to persist S1 handoff metadata",
      );
      return;
    }
    this.handoffStartedTokens.add(key);
    const active = this.activeLadders.get(key);
    if (active) {
      active.reason = "handoff";
      active.handoffStartedAtMs = timestamp;
    }
    this.deps.runtimeMetrics?.writeCounter("track_s1_handed_off_to_qd", 1);
    this.deps.riskEventRepo?.insert({
      eventType: "s1_handoff_to_qd",
      payload: {
        tokenId: String(market.tokenId),
        conditionId: String(position.conditionId),
        orderCount: activeOrders.length,
        timeoutSeconds: policy.handoffTimeoutSeconds,
        signalTimestamp: new Date(timestamp).toISOString(),
      },
    });
    for (const order of activeOrders) {
      await this.deps.bus.publish("CancelOrderRequested", {
        command: {
          type: "CancelOrderCommand",
          commandId: createCommandId(`s1_handoff_${String(order.orderId)}_${timestamp}`),
          orderId: order.orderId,
          reason: "s1_handoff_to_qd",
        },
        timestamp,
      });
    }
  }

  private async forceHandoffTimeout(
    position: Position,
    market: NormalizedMarket,
    activeOrders: readonly Order[],
    timestamp: number,
  ): Promise<void> {
    this.deps.runtimeMetrics?.writeCounter("track_s1_handoff_timeout_force_cancel", 1);
    for (const order of activeOrders) {
      await this.deps.bus.publish("CancelOrderRequested", {
        command: {
          type: "CancelOrderCommand",
          commandId: createCommandId(`s1_handoff_timeout_${String(order.orderId)}_${timestamp}`),
          orderId: order.orderId,
          reason: "s1_handoff_to_qd",
        },
        timestamp,
      });
    }
    this.deps.riskEventRepo?.insert({
      eventType: "s1_ladder_cancelled",
      payload: {
        tokenId: String(market.tokenId),
        conditionId: String(position.conditionId),
        orderCount: activeOrders.length,
        reason: "handoff_timeout_force_cancel",
        signalTimestamp: new Date(timestamp).toISOString(),
      },
    });
    this.releaseOwnership(market.tokenId, timestamp, "handoff_timeout_force_cancel");
  }

  private shouldHandoff(
    market: Pick<NormalizedMarket, "endDate">,
    nowMs: number,
    policy: TrackS1WalkingLadderPolicy,
  ): boolean {
    if (!market.endDate) return false;
    const endMs = Date.parse(market.endDate);
    if (!Number.isFinite(endMs)) return false;
    return (endMs - nowMs) / 1000 <= policy.handoffTimeToResolutionSeconds;
  }

  private isHandoffTimedOut(
    tokenId: TokenId,
    nowMs: number,
    policy: TrackS1WalkingLadderPolicy,
  ): boolean {
    const active = this.activeLadders.get(String(tokenId));
    if (!active?.handoffStartedAtMs) return false;
    return nowMs - active.handoffStartedAtMs >= policy.handoffTimeoutSeconds * 1000;
  }

  private assumeOwnership(
    position: Position,
    market: NormalizedMarket,
    ladderId: string,
    opts: { reason: S1OwnershipSnapshot["reason"]; riskEvent: boolean },
  ): void {
    const key = String(market.tokenId);
    if (!this.activeLadders.has(key)) {
      this.activeLadders.set(key, {
        tokenId: market.tokenId,
        conditionId: String(position.conditionId),
        ladderId,
        assumedAtMs: this.now(),
        reason: opts.reason,
        handoffStartedAtMs: null,
      });
      if (opts.riskEvent) {
        this.deps.riskEventRepo?.insert({
          eventType: "s1_ownership_assumed",
          payload: {
            tokenId: String(market.tokenId),
            conditionId: String(position.conditionId),
            ladderId,
            reason: opts.reason,
            signalTimestamp: new Date(this.now()).toISOString(),
          },
        });
      }
      return;
    }
    const active = this.activeLadders.get(key);
    if (active) {
      active.reason = opts.reason;
      if (opts.reason !== "handoff") active.handoffStartedAtMs = null;
    }
  }

  private releaseIfTerminal(
    tokenId: TokenId,
    timestamp: number,
    reason: "fill" | "order_cancelled",
  ): void {
    if (!this.activeLadders.has(String(tokenId))) return;
    const activeOrders = this.findActiveS1Orders(tokenId);
    if (activeOrders.length > 0) return;
    this.releaseOwnership(tokenId, timestamp, reason);
  }

  private releaseOwnership(tokenId: TokenId, timestamp: number, reason: string): void {
    const key = String(tokenId);
    const active = this.activeLadders.get(key);
    if (!active) return;
    this.activeLadders.delete(key);
    this.handoffStartedTokens.delete(key);
    if (reason === "fill") {
      this.deps.runtimeMetrics?.writeCounter("track_s1_ladder_completed", 1);
    }
    if (reason === "phantom_release" || reason === "phantom_release_recovery") {
      this.countPhantomRelease();
    }
    this.insertOwnershipRelease(tokenId, {
      conditionId: active.conditionId,
      ladderId: active.ladderId,
      reason,
      timestamp,
    });
  }

  private insertOwnershipRelease(
    tokenId: TokenId,
    input: { conditionId: string; ladderId: string; reason: string; timestamp: number },
  ): void {
    this.deps.riskEventRepo?.insert({
      eventType: "s1_ownership_released",
      payload: {
        tokenId: String(tokenId),
        conditionId: input.conditionId,
        ladderId: input.ladderId,
        reason: input.reason,
        signalTimestamp: new Date(input.timestamp).toISOString(),
      },
    });
  }

  private countPhantomRelease(): void {
    this.deps.runtimeMetrics?.writeCounter("track_s1_ownership_released_phantom", 1);
  }

  private acquirePlacement(tokenId: TokenId, nowMs: number): boolean {
    const key = String(tokenId);
    if (this.hasActivePlacement(tokenId, nowMs)) return false;
    this.activePlacements.set(key, { expiresAtMs: nowMs + ACTIVE_PLACEMENT_TTL_MS });
    this.recordPlacement(tokenId, nowMs);
    return true;
  }

  private hasActivePlacement(tokenId: TokenId, nowMs: number): boolean {
    const placement = this.activePlacements.get(String(tokenId));
    return placement != null && placement.expiresAtMs > nowMs;
  }

  private pruneExpiredPlacements(): void {
    const now = this.now();
    for (const [tokenId, placement] of this.activePlacements) {
      if (placement.expiresAtMs <= now) this.activePlacements.delete(tokenId);
    }
    for (const [tokenId, timestamps] of this.placementHistoryByToken) {
      const recent = timestamps.filter((timestamp) => now - timestamp < ONE_HOUR_MS);
      if (recent.length === 0) {
        this.placementHistoryByToken.delete(tokenId);
      } else {
        this.placementHistoryByToken.set(tokenId, recent);
      }
    }
  }

  private isFrequencyLimited(
    tokenId: TokenId,
    nowMs: number,
    policy: TrackS1WalkingLadderPolicy,
  ): boolean {
    const history = this.placementHistoryByToken.get(String(tokenId)) ?? [];
    return (
      history.filter((timestamp) => nowMs - timestamp < ONE_HOUR_MS).length >=
      policy.maxLadderReplacementsPerHour
    );
  }

  private recordPlacement(tokenId: TokenId, nowMs: number): void {
    const key = String(tokenId);
    const recent = (this.placementHistoryByToken.get(key) ?? []).filter(
      (timestamp) => nowMs - timestamp < ONE_HOUR_MS,
    );
    recent.push(nowMs);
    this.placementHistoryByToken.set(key, recent);
  }

  private resolveBook(
    booksByToken: ReadonlyMap<string, OrderBookSnapshot> | undefined,
    market: NormalizedMarket,
  ): OrderBookSnapshot {
    return (
      booksByToken?.get(String(market.tokenId)) ?? {
        tokenId: market.tokenId,
        bids:
          market.bestBid != null ? [{ price: market.bestBid, size: market.bestBidSize ?? 0 }] : [],
        asks:
          market.bestAsk != null ? [{ price: market.bestAsk, size: market.bestAskSize ?? 0 }] : [],
        bestBid: market.bestBid,
        bestAsk: market.bestAsk,
        midPrice: market.midPrice,
        spread: market.spread,
        minOrderSize: market.minOrderSize ?? null,
        timestamp: market.snapshotTs,
      }
    );
  }

  private countEligibilitySkip(reason: string): void {
    if (reason === "dead_market") {
      this.deps.runtimeMetrics?.writeCounter("track_s1_skipped_dead_market", 1, reason);
      return;
    }
    this.deps.runtimeMetrics?.writeCounter("track_s1_skipped_below_threshold", 1, reason);
  }

  private resolveLadderIdFromOrders(orders: readonly Order[]): string {
    return this.resolveLadderId(orders[0]);
  }

  private resolveLadderId(order: Order | undefined): string {
    const metadata = order?.metadata;
    const s1 = metadata && typeof metadata === "object" ? metadata.s1 : null;
    if (s1 && typeof s1 === "object" && "ladderId" in s1) {
      const ladderId = (s1 as { ladderId?: unknown }).ladderId;
      if (typeof ladderId === "string" && ladderId.length > 0) return ladderId;
    }
    return `recovered_${String(order?.tokenId ?? "unknown")}`;
  }

  private resolveCanonicalHandoffStartedAt(orders: readonly Order[]): number | null {
    const sorted = [...orders].sort((a, b) => String(a.orderId).localeCompare(String(b.orderId)));
    const values = sorted
      .map((order) => this.resolveHandoffStartedAt(order))
      .filter((value): value is number => value != null);
    if (values.length === 0) return null;
    const unique = new Set(values);
    if (unique.size > 1) {
      this.deps.log.warn(
        { tokenId: String(sorted[0]?.tokenId ?? "unknown"), orderCount: sorted.length },
        "Conflicting S1 handoffStartedAt metadata recovered",
      );
    }
    return values[0] ?? null;
  }

  private resolveHandoffStartedAt(order: Order): number | null {
    const metadata = order.metadata;
    const s1 = metadata && typeof metadata === "object" ? metadata.s1 : null;
    if (!s1 || typeof s1 !== "object") return null;
    const raw = (s1 as { handoffStartedAt?: unknown }).handoffStartedAt;
    if (typeof raw !== "string") return null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}

function isExecutableCleanup(
  residual: number,
  targetPrice: number,
  book: OrderBookSnapshot,
  market: NormalizedMarket,
  nowMs: number,
): boolean {
  return (
    market.active &&
    market.tradable &&
    market.acceptingOrders &&
    isPositiveNumber(market.tickSize) &&
    isPositiveNumber(book.bestBid) &&
    isPositiveNumber(book.bestAsk) &&
    book.bestBid < book.bestAsk &&
    Number.isFinite(book.timestamp) &&
    book.timestamp <= nowMs + 1_000 &&
    nowMs - book.timestamp <= MAKER_CAPTURE_BOOK_MAX_AGE_MS &&
    validateExecutablePrice(targetPrice, market.tickSize).ok &&
    targetPrice > book.bestBid + SIZE_EPSILON &&
    targetPrice < 1 &&
    isPositiveNumber(book.minOrderSize) &&
    residual + SIZE_EPSILON >= book.minOrderSize
  );
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function withS1HandoffStartedAt(
  metadata: Readonly<Record<string, unknown>> | null,
  handoffStartedAt: string,
): Readonly<Record<string, unknown>> {
  const base = metadata && typeof metadata === "object" ? { ...metadata } : {};
  const s1 =
    base.s1 && typeof base.s1 === "object" ? { ...(base.s1 as Record<string, unknown>) } : {};
  return {
    ...base,
    s1: {
      ...s1,
      handoffStartedAt,
    },
  };
}

function parseTimestamp(value: string, fallbackMs: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}
