import { randomUUID } from "node:crypto";
import type {
  AlgoRulesRepository,
  EventBus,
  Fill,
  FillRepository,
  LegStateRepository,
  MakerCaptureRepriceIntent,
  MakerCaptureTriggerProofV1,
  MultiBuyLadderPolicy,
  NormalizedMarket,
  Order,
  OrderRepository,
  PositionRepository,
  RuntimeEventMap,
  RuntimeModule,
  Signal,
  SignalReason as SignalReasonType,
  TokenId,
  ExecutionPolicy,
} from "@krabs/domain";
import {
  ENTRY_REASONS,
  canPlaceBuyOrderForMarket,
  createCommandId,
  createConditionId,
  deriveState,
  evaluateSize,
  parseEntryFreshEdgeAttribution,
  resolveSignalReason,
  parseMakerCaptureRepriceProofV1,
} from "@krabs/domain";
import { resolveMakerMicroLiveFillDeadlineMs } from "../../buy-order-lifecycle.js";
import {
  buildMakerCaptureRepriceIdentity,
  buildMakerCaptureBookDecisionProof,
  computeMakerCaptureCandidate,
  parseMakerCaptureLineage,
  primeFreshMakerCaptureBook,
  type MakerCaptureBookCache,
} from "../../maker-capture-reprice.js";
import { parseQuoteMotionOrigin } from "../../quote-motion-shadow.js";
import { applyOrderBookToMarket } from "../strategy/candidate-book-cache.js";
import { buildClientOrderId } from "@krabs/domain/node";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import type { Logger } from "../../logger.js";

// Lifecycle-generated BUYs intentionally bypass AlgoDecision's drop-trigger gate:
// they are continuations of an already-approved entry path and still traverse
// RiskInventory, same-price cooldown, wallet/order capacity, and signal-to-order.
const OUTBID_REPRICED_REASON = "outbid_repriced";
const OUTBID_REPRICE_SIGNAL_PREFIX = "outbid-reprice";
const EPSILON = 1e-9;
const SIGNAL_KEYED_STATE_TTL_MS = 24 * 60 * 60_000;
const LADDER_RESET_ANCHOR_TTL_MS = 24 * 60 * 60_000;
const STATE_GC_MIN_INTERVAL_MS = 5 * 60_000;

type TimerHandle = ReturnType<typeof setTimeout>;

interface LadderState {
  attemptedSteps: number;
  filledSteps: number;
  firstFillPrice: number;
  anchorMs: number;
}

interface EntryLifecycleMetrics {
  outbidRepriceCancels: number;
  outbidRepriceSignals: number;
  outbidRepriceFills: number;
  ladderSignals: number;
  ladderFills: number;
  ladderCooldownPaused: number;
  ladderStopped: Record<string, number>;
  ladderSignalsByStep: Record<string, number>;
  ladderFillsByStep: Record<string, number>;
}

export interface EntryLifecycleModuleDeps {
  bus: EventBus;
  orderRepo: OrderRepository;
  // Release A Phase 3: read the current cycle's positionId to stamp ladder-step BUYs.
  positionRepo: Pick<PositionRepository, "findByTokenId">;
  fillRepo: Pick<FillRepository, "findByOrderId" | "findByTokenId">;
  legStateRepo: LegStateRepository;
  algoRulesRepo: AlgoRulesRepository;
  policy: () => ExecutionPolicy;
  policySnapshot?: () => { policy: ExecutionPolicy; controlRevision: number | null };
  candidateBookCache?: MakerCaptureBookCache | undefined;
  runtimeMetrics?: RuntimeMetricWriter | undefined;
  log: Logger;
  now?: () => number;
  setTimer?: (fn: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export class EntryLifecycleModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly repriceCountBySignalId = new Map<string, number>();
  private readonly repricedSignalIds = new Set<string>();
  private readonly ladderSignalSteps = new Map<string, number>();
  private readonly signalStateTouchedAt = new Map<string, number>();
  private readonly ladderStateByToken = new Map<string, LadderState>();
  private readonly ladderResetAnchorByToken = new Map<string, number>();
  private readonly ladderTimers = new Map<string, TimerHandle>();
  private readonly marketCache = new Map<string, NormalizedMarket>();
  private readonly unsubs: Array<() => void> = [];
  private readonly captureSignalsPublished = new Set<string>();
  private started = false;
  private lastStateGcAt = 0;
  private metrics: EntryLifecycleMetrics = createMetrics();

  constructor(private readonly deps: EntryLifecycleModuleDeps) {
    this.log = deps.log.child({ module: "entry-lifecycle" });
  }

  getRepriceCount(signalId: string | null): number {
    if (!signalId) return 0;
    return this.repriceCountBySignalId.get(signalId) ?? parseRepriceCount(signalId);
  }

  getMarket(tokenId: TokenId): NormalizedMarket | null {
    return this.marketCache.get(String(tokenId)) ?? null;
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (event) =>
        this.handleMarketUpdated(event),
      ),
      this.deps.bus.subscribe("TrackedMarketsChanged", (event) =>
        this.handleTrackedMarketsChanged(event),
      ),
      this.deps.bus.subscribe("OrderCancelled", (event) => this.handleOrderCancelled(event)),
      this.deps.bus.subscribe("FillReceived", (event) => this.handleFillReceived(event)),
      this.deps.bus.subscribe("SignalConversionSkipped", (event) =>
        this.handleSignalConversionSkipped(event),
      ),
      this.deps.bus.subscribe("SignalRejected", (event) =>
        this.safeCaptureReprice(() => this.handleCaptureTerminalSignal(event.signal, event.reason)),
      ),
      this.deps.bus.subscribe("OrderSkipped", (event) =>
        this.safeCaptureReprice(() =>
          this.handleCaptureTerminalBySignal(event.signalId, event.reasonCode),
        ),
      ),
      this.deps.bus.subscribe("OrderRejected", (event) =>
        this.safeCaptureReprice(() => this.handleCaptureOrderRejected(event)),
      ),
      this.deps.bus.subscribe("OrderPlaced", (event) =>
        this.safeCaptureReprice(() => this.handleCaptureOrderPlaced(event)),
      ),
      this.deps.bus.subscribe("PositionUpdated", (event) => this.handlePositionUpdated(event)),
      this.deps.bus.subscribe("MarketResolvedHint", (event) => this.handleMarketResolved(event)),
    );
    this.started = true;
    await this.cancelExpiredMakerCaptures();
    await this.recoverMakerCaptureRepricesAtStartup();
    this.log.info("entry lifecycle module started");
  }

  private async cancelExpiredMakerCaptures(): Promise<void> {
    const now = this.now();
    for (const order of this.deps.orderRepo.findOpen()) {
      const deadlineMs = resolveMakerMicroLiveFillDeadlineMs(order);
      if (deadlineMs == null || now < deadlineMs) continue;
      await this.deps.bus.publish("CancelOrderRequested", {
        command: {
          type: "CancelOrderCommand",
          commandId: createCommandId(`maker-capture-startup-${String(order.orderId)}-${now}`),
          orderId: order.orderId,
          reason: "stale_entry_ttl",
        },
        timestamp: now,
      });
    }
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    for (const timer of this.ladderTimers.values()) this.clearTimer(timer);
    this.ladderTimers.clear();
    this.started = false;
    this.log.info("entry lifecycle module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: this.started,
      detail: `repriced=${this.metrics.outbidRepriceSignals} ladder=${this.metrics.ladderSignals} scheduled=${this.ladderTimers.size}`,
    };
  }

  private async handleOrderCancelled(event: RuntimeEventMap["OrderCancelled"]): Promise<void> {
    await this.safeCaptureReprice(() => this.advanceCaptureByPredecessor(event.orderId, false));
    if (event.reason !== OUTBID_REPRICED_REASON) return;
    this.metrics.outbidRepriceCancels++;
    const order = this.deps.orderRepo.findById(event.orderId);
    if (!order || order.side !== "buy" || !isEntryReason(order.signalReason)) return;
    const market = this.getMarket(order.tokenId);
    if (!market) return;
    const priorCount = this.getRepriceCount(order.signalId ?? null);
    const policy = this.deps.policy().repriceOnOutbid;
    if (!policy.enabled || priorCount >= policy.maxRepriceCount) return;

    const signal = this.buildRepriceSignal(order, market, priorCount + 1, event.timestamp);
    if (!signal) return;
    this.repriceCountBySignalId.set(signal.signalId, priorCount + 1);
    this.repricedSignalIds.add(signal.signalId);
    this.touchSignalState(signal.signalId, event.timestamp);
    this.metrics.outbidRepriceSignals++;
    this.writeMetrics(event.timestamp);
    await this.publishSignal(signal, market);
  }

  private async handleFillReceived(event: RuntimeEventMap["FillReceived"]): Promise<void> {
    await this.safeCaptureReprice(() => this.advanceCaptureByPredecessor(event.orderId, false));
    if (event.side !== "buy") return;
    if (event.signalId && this.repricedSignalIds.has(event.signalId)) {
      this.metrics.outbidRepriceFills++;
    }
    const ladderStep = event.signalId ? this.ladderSignalSteps.get(event.signalId) : undefined;
    if (ladderStep != null) {
      this.metrics.ladderFills++;
      increment(this.metrics.ladderFillsByStep, String(ladderStep));
      const state = this.ensureLadderState(
        event.tokenId,
        event.price,
        this.resolveAnchorForFill(event),
      );
      state.filledSteps++;
    }
    if (!isLadderEligibleFill(event)) {
      this.writeMetrics(event.timestamp);
      return;
    }
    this.scheduleNextLadderBuy(event);
    this.writeMetrics(event.timestamp);
  }

  private async handleSignalConversionSkipped(
    event: RuntimeEventMap["SignalConversionSkipped"],
  ): Promise<void> {
    await this.safeCaptureReprice(() =>
      this.handleCaptureTerminalSignal(event.signal, event.reasons.join(",")),
    );
    if (!this.ladderSignalSteps.has(event.signal.signalId)) return;
    if (!event.reasons.includes("same-price-cooldown")) return;
    this.metrics.ladderCooldownPaused++;
    this.scheduleLadderRetryAfterCooldown(event);
    this.writeMetrics(event.skippedAt);
  }

  private async handleMarketUpdated(
    event: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    for (const market of event.markets) {
      const key = String(market.tokenId);
      if (market.active) {
        this.marketCache.set(key, market);
      } else {
        this.marketCache.delete(key);
      }
    }
    await this.safeCaptureReprice(() => this.handleCaptureMarketEvent(event));
  }

  private async handleCaptureMarketEvent(
    event: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    const now = this.now();
    if (!freshEvent(event.timestamp, now)) return;
    const markets = new Map(event.markets.map((market) => [String(market.tokenId), market]));
    await this.recoverMakerCaptureReprices(false, new Set(markets.keys()));
    for (const order of this.deps.orderRepo.findOpen()) {
      const market = markets.get(String(order.tokenId));
      if (!market) continue;
      const trigger = this.captureOrderTriggerProof(order, market, event.timestamp, now);
      if (!trigger) continue;
      const lineage = parseMakerCaptureLineage(order);
      if (!lineage) continue;
      const identity = buildMakerCaptureRepriceIdentity(
        lineage.rootOrderId,
        order.orderId,
        lineage.replacementIndex + 1,
      );
      const nowIso = new Date(now).toISOString();
      const intent: MakerCaptureRepriceIntent = {
        intentId: identity.intentId,
        predecessorOrderId: order.orderId,
        lifecycleSignalId: identity.lifecycleSignalId,
        rootOrderId: lineage.rootOrderId,
        tokenId: order.tokenId,
        conditionId: order.conditionId,
        replacementIndex: lineage.replacementIndex + 1,
        status: "cancel_pending",
        candidatePrice: null,
        replacementSize: null,
        childOrderId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        failure: null,
        proof: { version: 1, trigger, prepared: null, submit: null },
      };
      if (!this.deps.orderRepo.claimMakerCaptureRepriceIntent?.(intent)) continue;
      await this.publishCaptureCancel(intent, order);
    }
  }

  private captureOrderTriggerProof(
    order: Order,
    market: NormalizedMarket,
    eventTimestampMs: number,
    now: number,
  ): MakerCaptureTriggerProofV1 | null {
    if (order.status !== "open" && order.status !== "partially-filled") return null;
    if (!canPlaceBuyOrderForMarket(market, now).allowed) return null;
    if (
      order.side !== "buy" ||
      order.entryStyle !== "maker" ||
      order.postOnly !== true ||
      order.decisionRuleId !== "R23_DIP_TRIGGER" ||
      order.signalReason !== "probe-entry"
    ) {
      return null;
    }
    const snapshot = this.capturePolicySnapshot();
    const reprice = snapshot?.policy.makerEntry.captureBookReprice;
    const window = snapshot?.policy.makerEntry.microLiveWindow;
    if (
      !snapshot ||
      !reprice?.enabled ||
      snapshot.controlRevision === null ||
      snapshot.policy.makerEntry.mode !== "micro_live" ||
      window?.captureNextR23 !== true ||
      !activeWindow(window.activatedAtUtc, window.expiresAtUtc, now)
    ) {
      return null;
    }
    const lineage = parseMakerCaptureLineage(order);
    const usage = this.deps.orderRepo.getMakerCaptureChainUsage?.(order.orderId);
    const root = lineage ? this.deps.orderRepo.findById(lineage.rootOrderId) : null;
    const origin = root ? parseQuoteMotionOrigin(root) : null;
    const deadline = root ? resolveMakerMicroLiveFillDeadlineMs(root) : null;
    if (
      !lineage ||
      !usage?.trusted ||
      String(usage.rootOrderId) !== String(lineage.rootOrderId) ||
      usage.replacementIndex !== lineage.replacementIndex ||
      lineage.replacementIndex >= reprice.maxRepricesPerRoot ||
      !root ||
      deadline === null ||
      now >= deadline ||
      origin?.kind !== "r23_capture" ||
      origin.policySchemaVersion !== snapshot.policy.version ||
      origin.policyControlRevision !== snapshot.controlRevision ||
      origin.cohortId !== window.activatedAtUtc ||
      origin.entryPriceCeiling !== snapshot.policy.entryPriceCeiling ||
      origin.entryPriceCeiling === null ||
      Math.min(origin.originalSuggestedPrice, origin.entryPriceCeiling) + EPSILON <
        order.price + market.tickSize ||
      !frozenWindowMatches(root, window.activatedAtUtc, window.expiresAtUtc) ||
      market.conditionId !== String(order.conditionId) ||
      !Number.isFinite(market.tickSize) ||
      market.tickSize <= 0 ||
      market.bestBid == null ||
      market.bestBid + EPSILON < order.price + market.tickSize
    ) {
      return null;
    }
    return {
      eventTimestampMs,
      evaluatedAtMs: now,
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      tickSize: market.tickSize,
      bookSource: market.bookSource ?? null,
      policySchemaVersion: snapshot.policy.version,
      policyControlRevision: snapshot.controlRevision,
      activatedAtUtc: window.activatedAtUtc,
      expiresAtUtc: window.expiresAtUtc,
      originalSuggestedPrice: origin.originalSuggestedPrice,
      entryPriceCeiling: origin.entryPriceCeiling,
      rootNotionalUsdc: usage.rootNotionalUsdc,
      chainFilledUsdc: usage.chainFilledUsdc,
      predecessorRemainingShares: usage.predecessorRemainingShares,
    };
  }

  private async recoverMakerCaptureRepricesAtStartup(): Promise<void> {
    await this.safeCaptureReprice(() => this.recoverMakerCaptureReprices(true));
  }

  private async recoverMakerCaptureReprices(
    startup: boolean,
    tokenIds?: ReadonlySet<string>,
  ): Promise<void> {
    const intents = this.deps.orderRepo.findRecoverableMakerCaptureRepriceIntents?.() ?? [];
    for (const intent of intents) {
      if (!this.captureIntentProofValid(intent)) {
        this.failCaptureIntent(intent, "proof-invalid-or-incomplete");
        continue;
      }
      if (!tokenIds || tokenIds.has(String(intent.tokenId))) {
        await this.advanceCaptureIntent(intent, startup);
      }
    }
  }

  private async advanceCaptureByPredecessor(orderId: Order["orderId"], startup: boolean) {
    const childIntent = this.deps.orderRepo.findMakerCaptureRepriceIntentByChild?.(orderId);
    if (childIntent) {
      const child = this.deps.orderRepo.findById(orderId);
      if (child?.status === "rejected") this.failCaptureIntent(childIntent, "child-rejected");
      else if (child && child.status !== "pending") this.completeCaptureIntent(childIntent);
    }
    const intent = this.deps.orderRepo.findMakerCaptureRepriceIntentByPredecessor?.(orderId);
    if (intent) await this.advanceCaptureIntent(intent, startup);
  }

  private async advanceCaptureIntent(
    intent: MakerCaptureRepriceIntent,
    startup: boolean,
  ): Promise<void> {
    let child = intent.childOrderId ? this.deps.orderRepo.findById(intent.childOrderId) : null;
    if (!child && intent.status === "ready") {
      child = this.deps.orderRepo.findByClientOrderId(
        buildClientOrderId({
          signalId: intent.lifecycleSignalId,
          tokenId: intent.tokenId,
          side: "buy",
        }),
      );
      if (child) {
        this.failCaptureIntent(intent, "child-before-submit-proof");
        return;
      }
    }
    if (child) {
      if (child.status === "rejected") this.failCaptureIntent(intent, "child-rejected");
      else if (child.status !== "pending") this.completeCaptureIntent(intent);
      return;
    }
    if (intent.status === "submitted") {
      this.failCaptureIntent(intent, "submitted-child-missing");
      return;
    }
    const predecessor = this.deps.orderRepo.findById(intent.predecessorOrderId);
    if (!predecessor) return;
    if (predecessor.status === "filled" || predecessor.status === "rejected") {
      this.failCaptureIntent(intent, `predecessor-${predecessor.status}`);
      return;
    }
    if (intent.status === "cancel_pending" && isWorking(predecessor)) {
      await this.publishCaptureCancel(intent, predecessor);
      return;
    }
    if (predecessor.status !== "cancelled" || startup) return;
    if (intent.status === "cancel_pending") {
      const ready = await this.prepareCaptureReplacement(intent, predecessor);
      if (!ready) return;
      intent = ready;
    }
    if (intent.status === "ready") await this.publishCaptureSignal(intent, predecessor);
  }

  private async prepareCaptureReplacement(
    intent: MakerCaptureRepriceIntent,
    predecessor: Order,
  ): Promise<MakerCaptureRepriceIntent | null> {
    const now = this.now();
    if (!this.captureIntentProofValid(intent)) {
      this.failCaptureIntent(intent, "proof-invalid-or-incomplete");
      return null;
    }
    const market = this.getMarket(intent.tokenId);
    if (!market) {
      this.failCaptureIntent(intent, "policy-or-lineage-drift");
      return null;
    }
    const entry = await primeFreshMakerCaptureBook(
      this.deps.candidateBookCache,
      String(intent.tokenId),
      now,
    );
    const minOrderSize = entry?.book.minOrderSize;
    if (!entry || minOrderSize == null || !Number.isFinite(minOrderSize) || minOrderSize <= 0) {
      this.failCaptureIntent(intent, "fresh-book-or-minimum-unavailable");
      return null;
    }
    const state = this.captureIntentState(intent, predecessor, this.now());
    if (!state) {
      this.failCaptureIntent(intent, "policy-or-lineage-drift");
      return null;
    }
    const { origin, usage, snapshot, window } = state;
    this.marketCache.set(String(intent.tokenId), applyOrderBookToMarket(market, entry));
    const candidate = computeMakerCaptureCandidate({
      book: entry.book,
      tickSize: market.tickSize,
      predecessorPrice: predecessor.price,
      predecessorVisibleShares: usage.predecessorRemainingShares,
      originalSuggestedPrice: origin.originalSuggestedPrice,
      entryPriceCeiling: origin.entryPriceCeiling!,
    });
    if (!candidate.ok) {
      this.failCaptureIntent(intent, candidate.reason);
      return null;
    }
    const rootResidualShares = Math.max(
      0,
      (usage.rootNotionalUsdc - usage.chainFilledUsdc) / candidate.price,
    );
    const size = Math.min(usage.predecessorRemainingShares, rootResidualShares);
    if (!Number.isFinite(size) || size + EPSILON < minOrderSize) {
      this.failCaptureIntent(intent, "replacement-below-minimum");
      return null;
    }
    const preparedProof = buildMakerCaptureBookDecisionProof({
      evaluatedAtMs: this.now(),
      entry,
      tickSize: market.tickSize,
      predecessorPrice: predecessor.price,
      predecessorRemainingShares: usage.predecessorRemainingShares,
      rootNotionalUsdc: usage.rootNotionalUsdc,
      chainFilledUsdc: usage.chainFilledUsdc,
      originalSuggestedPrice: origin.originalSuggestedPrice,
      entryPriceCeiling: origin.entryPriceCeiling!,
      candidate,
      replacementSize: size,
      minOrderSize,
      policySchemaVersion: snapshot.policy.version,
      policyControlRevision: snapshot.controlRevision!,
      activatedAtUtc: window.activatedAtUtc,
      expiresAtUtc: window.expiresAtUtc,
    });
    if (
      !this.deps.orderRepo.markMakerCaptureRepriceReady?.(
        intent.intentId,
        candidate.price,
        size,
        preparedProof,
      )
    ) {
      return (
        this.deps.orderRepo.findMakerCaptureRepriceIntentBySignal?.(intent.lifecycleSignalId) ??
        null
      );
    }
    return {
      ...intent,
      status: "ready",
      candidatePrice: candidate.price,
      replacementSize: size,
      proof: { ...intent.proof!, prepared: preparedProof },
    };
  }

  private captureIntentState(intent: MakerCaptureRepriceIntent, predecessor: Order, now: number) {
    const snapshot = this.capturePolicySnapshot();
    const maker = snapshot?.policy.makerEntry;
    const window = maker?.microLiveWindow;
    const root = this.deps.orderRepo.findById(intent.rootOrderId);
    const lineage = parseMakerCaptureLineage(predecessor);
    const origin = root ? parseQuoteMotionOrigin(root) : null;
    const usage = this.deps.orderRepo.getMakerCaptureChainUsage?.(predecessor.orderId);
    const deadline = root ? resolveMakerMicroLiveFillDeadlineMs(root) : null;
    if (
      !snapshot ||
      snapshot.controlRevision === null ||
      maker?.mode !== "micro_live" ||
      !maker.captureBookReprice.enabled ||
      intent.replacementIndex > maker.captureBookReprice.maxRepricesPerRoot ||
      window?.captureNextR23 !== true ||
      !activeWindow(window.activatedAtUtc, window.expiresAtUtc, now) ||
      !root ||
      String(root.orderId) !== String(intent.rootOrderId) ||
      !lineage ||
      String(predecessor.orderId) !== String(intent.predecessorOrderId) ||
      String(predecessor.tokenId) !== String(intent.tokenId) ||
      String(predecessor.conditionId) !== String(intent.conditionId) ||
      String(lineage.rootOrderId) !== String(intent.rootOrderId) ||
      lineage.replacementIndex + 1 !== intent.replacementIndex ||
      !usage?.trusted ||
      usage.replacementIndex + 1 !== intent.replacementIndex ||
      String(usage.rootOrderId) !== String(intent.rootOrderId) ||
      deadline === null ||
      now >= deadline ||
      origin?.kind !== "r23_capture" ||
      origin.policySchemaVersion !== snapshot.policy.version ||
      origin.policyControlRevision !== snapshot.controlRevision ||
      origin.cohortId !== window.activatedAtUtc ||
      origin.entryPriceCeiling !== snapshot.policy.entryPriceCeiling ||
      !frozenWindowMatches(root, window.activatedAtUtc, window.expiresAtUtc)
    )
      return null;
    return { origin, usage, snapshot, window };
  }

  private async publishCaptureSignal(
    intent: MakerCaptureRepriceIntent,
    predecessor: Order,
  ): Promise<void> {
    if (!this.captureIntentProofValid(intent)) {
      this.failCaptureIntent(intent, "proof-invalid-or-incomplete");
      return;
    }
    if (
      intent.candidatePrice == null ||
      intent.replacementSize == null ||
      this.captureSignalsPublished.has(intent.lifecycleSignalId)
    ) {
      return;
    }
    const identity = buildMakerCaptureRepriceIdentity(
      intent.rootOrderId,
      intent.predecessorOrderId,
      intent.replacementIndex,
    );
    if (
      identity.intentId !== intent.intentId ||
      identity.lifecycleSignalId !== intent.lifecycleSignalId
    ) {
      this.failCaptureIntent(intent, "identity-drift");
      return;
    }
    const market = this.getMarket(intent.tokenId);
    if (!market) return;
    const signal: Signal = {
      signalId: intent.lifecycleSignalId,
      tokenId: intent.tokenId,
      conditionId: intent.conditionId,
      positionId: predecessor.positionId ?? null,
      side: "buy",
      suggestedPrice: intent.candidatePrice,
      suggestedSize: intent.replacementSize,
      suggestedSizeUsdc: intent.candidatePrice * intent.replacementSize,
      reason: "probe-entry",
      strategyTick: this.now(),
      sequenceInTick: intent.replacementIndex,
      decisionRuleId: "R23_DIP_TRIGGER",
      sizingRuleId: null,
      generatedAt: new Date(this.now()).toISOString(),
      makerCaptureReprice: {
        version: 1,
        intentId: intent.intentId,
        rootOrderId: intent.rootOrderId,
        predecessorOrderId: intent.predecessorOrderId,
        replacementIndex: intent.replacementIndex,
      },
      ...(parseEntryFreshEdgeAttribution(predecessor.metadata?.entryFreshEdgeAttribution)
        ? {
            entryFreshEdgeAttribution: parseEntryFreshEdgeAttribution(
              predecessor.metadata?.entryFreshEdgeAttribution,
            )!,
          }
        : {}),
    };
    this.captureSignalsPublished.add(intent.lifecycleSignalId);
    let keepPublished = false;
    try {
      await this.publishSignal(signal, market);
    } finally {
      try {
        const current = this.deps.orderRepo.findMakerCaptureRepriceIntentBySignal?.(
          intent.lifecycleSignalId,
        );
        keepPublished =
          current != null && (current.status !== "ready" || current.childOrderId !== null);
      } finally {
        if (!keepPublished) this.captureSignalsPublished.delete(intent.lifecycleSignalId);
      }
    }
  }

  private async publishCaptureCancel(
    intent: MakerCaptureRepriceIntent,
    predecessor: Order,
  ): Promise<void> {
    if (!this.captureIntentProofValid(intent)) {
      this.failCaptureIntent(intent, "proof-invalid-or-incomplete");
      return;
    }
    if (!this.captureIntentState(intent, predecessor, this.now())) {
      this.failCaptureIntent(intent, "policy-or-lineage-drift");
      return;
    }
    const identity = buildMakerCaptureRepriceIdentity(
      intent.rootOrderId,
      intent.predecessorOrderId,
      intent.replacementIndex,
    );
    if (
      identity.intentId !== intent.intentId ||
      identity.lifecycleSignalId !== intent.lifecycleSignalId
    )
      return;
    await this.deps.bus.publish("CancelOrderRequested", {
      command: {
        type: "CancelOrderCommand",
        commandId: createCommandId(identity.cancelCommandId),
        orderId: intent.predecessorOrderId,
        reason: "maker_capture_reprice",
      },
      timestamp: this.now(),
    });
  }

  private async handleCaptureTerminalSignal(signal: Signal, reason: string): Promise<void> {
    if (!signal.makerCaptureReprice) return;
    await this.handleCaptureTerminalBySignal(signal.signalId, reason);
  }

  private async handleCaptureTerminalBySignal(
    signalId: string | null | undefined,
    reason: string,
  ): Promise<void> {
    if (!signalId) return;
    const intent = this.deps.orderRepo.findMakerCaptureRepriceIntentBySignal?.(signalId);
    if (!intent) return;
    const child = this.deps.orderRepo.findByClientOrderId(
      buildClientOrderId({ signalId, tokenId: intent.tokenId, side: "buy" }),
    );
    if (child && child.status !== "rejected") {
      this.deps.orderRepo.markMakerCaptureRepriceSubmitted?.(intent.intentId, child.orderId);
      this.completeCaptureIntent(intent);
    } else {
      this.failCaptureIntent(intent, reason);
    }
  }

  private async handleCaptureOrderRejected(event: RuntimeEventMap["OrderRejected"]): Promise<void> {
    const intent = event.signalId
      ? this.deps.orderRepo.findMakerCaptureRepriceIntentBySignal?.(event.signalId)
      : (() => {
          const child = this.deps.orderRepo.findByClientOrderId(event.clientOrderId);
          return child
            ? this.deps.orderRepo.findMakerCaptureRepriceIntentByChild?.(child.orderId)
            : null;
        })();
    if (!intent) return;
    const child = this.deps.orderRepo.findByClientOrderId(event.clientOrderId);
    if (child && child.status !== "rejected") this.completeCaptureIntent(intent);
    else this.failCaptureIntent(intent, event.reason);
  }

  private async handleCaptureOrderPlaced(event: RuntimeEventMap["OrderPlaced"]): Promise<void> {
    const intent = this.deps.orderRepo.findMakerCaptureRepriceIntentByChild?.(event.orderId);
    const child = intent ? this.deps.orderRepo.findById(event.orderId) : null;
    if (intent && child && isWorking(child)) this.completeCaptureIntent(intent);
  }

  private failCaptureIntent(intent: MakerCaptureRepriceIntent, reason: string): void {
    this.deps.orderRepo.markMakerCaptureRepriceTerminal?.(intent.intentId, "failed", reason);
    this.captureSignalsPublished.delete(intent.lifecycleSignalId);
  }

  private completeCaptureIntent(intent: MakerCaptureRepriceIntent): void {
    this.deps.orderRepo.markMakerCaptureRepriceTerminal?.(intent.intentId, "completed");
    this.captureSignalsPublished.delete(intent.lifecycleSignalId);
  }

  private captureIntentProofValid(intent: MakerCaptureRepriceIntent): boolean {
    const proof = parseMakerCaptureRepriceProofV1(intent.proof);
    if (!proof) return false;
    if (intent.status === "cancel_pending") return proof.prepared === null && proof.submit === null;
    if (intent.status === "ready") return proof.prepared !== null && proof.submit === null;
    if (intent.status === "submitted") {
      if (proof.prepared === null || intent.childOrderId === null) return false;
      if (proof.submit === null) return true;
    }
    if (intent.status === "submitted" || intent.status === "completed") {
      const expectedClientOrderId = buildClientOrderId({
        signalId: intent.lifecycleSignalId,
        tokenId: intent.tokenId,
        side: "buy",
      });
      return (
        proof.prepared !== null &&
        proof.submit?.childOrderId === String(intent.childOrderId) &&
        proof.submit.clientOrderId === String(expectedClientOrderId)
      );
    }
    return true;
  }

  private capturePolicySnapshot() {
    return this.deps.policySnapshot?.() ?? null;
  }

  private async safeCaptureReprice(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (err) {
      this.log.error({ err }, "maker capture reprice handler failed; durable intent retained");
    }
  }

  private async handleTrackedMarketsChanged(
    event: RuntimeEventMap["TrackedMarketsChanged"],
  ): Promise<void> {
    for (const tokenId of event.removedTokenIds) this.marketCache.delete(String(tokenId));
  }

  private async handlePositionUpdated(event: RuntimeEventMap["PositionUpdated"]): Promise<void> {
    if (event.position.status !== "closed" && event.position.size > 0) return;
    this.resetToken(event.position.tokenId, "position_closed");
  }

  private async handleMarketResolved(event: RuntimeEventMap["MarketResolvedHint"]): Promise<void> {
    for (const tokenId of event.tokenIds) this.resetToken(tokenId, "market_resolved");
  }

  private scheduleNextLadderBuy(event: RuntimeEventMap["FillReceived"]): void {
    const policy = this.deps.policy().multiBuyLadder;
    if (!policy.enabled) return;
    const tokenKey = String(event.tokenId);
    if (this.ladderTimers.has(tokenKey)) return;
    this.ensureLadderState(event.tokenId, event.price, this.resolveAnchorForFill(event));
    const decision = this.evaluateLadderReadiness(event.tokenId, event.price, policy);
    if (!decision.allowed) {
      this.recordLadderStop(decision.reason);
      return;
    }
    const timer = this.setTimer(() => {
      this.ladderTimers.delete(tokenKey);
      this.fireLadderBuy(event.tokenId).catch((err) =>
        this.log.error({ err, tokenId: tokenKey }, "multi-buy ladder fire failed"),
      );
    }, policy.ladderGapMs);
    this.ladderTimers.set(tokenKey, timer);
  }

  private scheduleLadderRetryAfterCooldown(
    event: RuntimeEventMap["SignalConversionSkipped"],
  ): void {
    const policy = this.deps.policy().multiBuyLadder;
    if (!policy.enabled) return;
    const tokenKey = String(event.signal.tokenId);
    if (this.ladderTimers.has(tokenKey)) return;
    const cooldownUntil = numericDiagnostic(event.diagnostics.cooldownUntilTsUtc);
    const now = this.now();
    const cooldownDelay = cooldownUntil != null ? Math.max(cooldownUntil - now, 0) : 0;
    const delayMs = Math.max(policy.ladderGapMs, cooldownDelay);
    const timer = this.setTimer(() => {
      this.ladderTimers.delete(tokenKey);
      this.fireLadderBuy(event.signal.tokenId).catch((err) =>
        this.log.error({ err, tokenId: tokenKey }, "multi-buy ladder cooldown retry failed"),
      );
    }, delayMs);
    this.ladderTimers.set(tokenKey, timer);
  }

  private async fireLadderBuy(tokenId: TokenId): Promise<void> {
    if (!this.started) return;
    const now = this.now();
    const policy = this.deps.policy().multiBuyLadder;
    if (!policy.enabled) return;
    const readiness = this.evaluateLadderReadiness(tokenId, null, policy);
    if (!readiness.allowed) {
      this.recordLadderStop(readiness.reason);
      this.writeMetrics(now);
      return;
    }
    const market = readiness.market;
    const price = readiness.ladderTargetPrice;
    if (price == null || price <= 0 || !Number.isFinite(price)) {
      this.recordLadderStop("price_unavailable");
      this.writeMetrics(now);
      return;
    }
    const legState = this.deps.legStateRepo.get(tokenId);
    const buyFills = this.buyFills(tokenId);
    const buyCount = legState?.buyCount ?? buyFills.length;
    const state = deriveState(legState);
    const sizeResult = evaluateSize(
      "BUY",
      { state, price, nthBuy: buyCount + 1, buyCount },
      this.deps.algoRulesRepo.getSizeRules("BUY"),
    );
    // Ladder steps are new strategy attempts, not replacements of one existing order;
    // use a fresh signal id so the bridge/client-order-id dedupe treats each step independently.
    const signalId = randomUUID();
    const reason = resolveSignalReason("buy", buyCount);
    const suggestedSizeUsdc = sizeResult.sizeUsdc;
    const signal: Signal = {
      signalId,
      tokenId,
      conditionId: createConditionId(market.conditionId),
      // Release A Phase 3: capture the EXACT current cycle identity at ladder-fire
      // time (not deferred to the bridge — a later token lookup could bind to a
      // reopened cycle). null on the first step (opens a new cycle).
      positionId: this.deps.positionRepo.findByTokenId(tokenId)?.positionId ?? null,
      side: "buy",
      suggestedPrice: price,
      ladderTargetPrice: price,
      suggestedSize: suggestedSizeUsdc / price,
      suggestedSizeUsdc,
      reason,
      strategyTick: now,
      sequenceInTick: 0,
      decisionRuleId: "LADDER",
      sizingRuleId: sizeResult.ruleId,
      generatedAt: new Date(now).toISOString(),
    };
    const stateForToken = this.ensureLadderState(
      tokenId,
      buyFills[0]?.price ?? price,
      this.resolveCurrentAnchorMs(tokenId) ?? now - 1,
    );
    stateForToken.attemptedSteps++;
    const step = stateForToken.attemptedSteps;
    this.ladderSignalSteps.set(signalId, step);
    this.touchSignalState(signalId, now);
    this.metrics.ladderSignals++;
    increment(this.metrics.ladderSignalsByStep, String(step));
    this.writeMetrics(now);
    await this.publishSignal(signal, market);
  }

  private evaluateLadderReadiness(
    tokenId: TokenId,
    fallbackFirstPrice: number | null,
    policy: MultiBuyLadderPolicy,
  ):
    | { allowed: true; market: NormalizedMarket; ladderTargetPrice: number }
    | { allowed: false; reason: string } {
    const market = this.getMarket(tokenId);
    if (!market) return { allowed: false, reason: "market_missing" };
    if (!canPlaceBuyOrderForMarket(market, this.now()).allowed) {
      return { allowed: false, reason: "market_not_buyable" };
    }
    const buyFills = this.buyFills(tokenId);
    const existingState = this.ladderStateByToken.get(String(tokenId));
    const firstFillPrice =
      buyFills[0]?.price ?? fallbackFirstPrice ?? existingState?.firstFillPrice;
    if (firstFillPrice == null || !Number.isFinite(firstFillPrice) || firstFillPrice <= 0) {
      return { allowed: false, reason: "price_unavailable" };
    }
    const totalUsdc = buyFills.reduce((sum, fill) => sum + fill.sizeUsdc, 0);
    if (buyFills.length >= policy.maxLadderFillsPerToken) {
      return { allowed: false, reason: "max_ladder_fills" };
    }
    if (totalUsdc >= policy.perTokenUsdcCap) return { allowed: false, reason: "per_token_cap" };
    const currentPrice = market.bestBid ?? market.midPrice;
    // R55 treats >=5 ticks away from the first fill as a new regime in either direction.
    if (
      currentPrice != null &&
      Number.isFinite(currentPrice) &&
      Number.isFinite(market.tickSize) &&
      market.tickSize > 0 &&
      Math.abs(currentPrice - firstFillPrice) >=
        policy.maxPriceDriftTicks * market.tickSize - EPSILON
    ) {
      return { allowed: false, reason: "price_drift" };
    }
    const state = this.ensureLadderState(
      tokenId,
      firstFillPrice ?? currentPrice ?? 0,
      this.resolveCurrentAnchorMs(tokenId) ?? this.now() - 1,
    );
    if (state.attemptedSteps >= 3) {
      const fillRate = state.filledSteps / state.attemptedSteps;
      if (fillRate < policy.minStepFillRate) return { allowed: false, reason: "low_fill_rate" };
    }
    return { allowed: true, market, ladderTargetPrice: firstFillPrice };
  }

  private buildRepriceSignal(
    order: Order,
    market: NormalizedMarket,
    repriceCount: number,
    nowMs: number,
  ): Signal | null {
    const price = market.bestBid ?? order.price;
    const remainingSize = this.remainingOrderSize(order);
    if (!isExecutableRemainingSize(remainingSize, market.minOrderSize)) {
      this.log.info(
        {
          orderId: String(order.orderId),
          tokenId: String(order.tokenId),
          remainingSize,
          minOrderSize: market.minOrderSize ?? null,
        },
        "outbid reprice skipped — remaining order size below exchange minimum",
      );
      return null;
    }
    const suggestedSizeUsdc = remainingSize * price;
    const entryFreshEdgeAttribution = this.resolveRepriceAttribution(order);
    return {
      signalId: buildRepriceSignalId(repriceCount),
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      // Release A Phase 3: repricing a position-bound add must PRESERVE the exact
      // cycle identity of the order being repriced (write-once, not re-derived).
      positionId: order.positionId ?? null,
      side: "buy",
      suggestedPrice: price,
      suggestedSize: remainingSize,
      suggestedSizeUsdc,
      reason: order.signalReason as SignalReasonType,
      strategyTick: nowMs,
      sequenceInTick: repriceCount,
      decisionRuleId: "OUTBID_REPRICE",
      sizingRuleId: null,
      generatedAt: new Date(nowMs).toISOString(),
      ...(entryFreshEdgeAttribution ? { entryFreshEdgeAttribution } : {}),
    };
  }

  private resolveRepriceAttribution(order: Order) {
    const attribution = parseEntryFreshEdgeAttribution(order.metadata?.entryFreshEdgeAttribution);
    if (!attribution) return null;
    if (order.decisionRuleId === "R23_DIP_TRIGGER") {
      return order.signalId === attribution.originSignalId ? attribution : null;
    }
    if (order.decisionRuleId !== "OUTBID_REPRICE") return null;
    const origins = this.deps.orderRepo.findByTokenId(order.tokenId).filter((candidate) => {
      const parsed = parseEntryFreshEdgeAttribution(candidate.metadata?.entryFreshEdgeAttribution);
      return (
        candidate.side === "buy" &&
        candidate.conditionId === order.conditionId &&
        candidate.decisionRuleId === "R23_DIP_TRIGGER" &&
        candidate.signalId === attribution.originSignalId &&
        JSON.stringify(parsed) === JSON.stringify(attribution)
      );
    });
    return origins.length === 1 ? attribution : null;
  }

  private async publishSignal(signal: Signal, market: NormalizedMarket): Promise<void> {
    await this.deps.bus.publish("SignalProduced", { signal, market });
  }

  private remainingOrderSize(order: Order): number {
    const filledSize = this.deps.fillRepo
      .findByOrderId(order.orderId)
      .filter((fill) => fill.side === order.side)
      .reduce((sum, fill) => sum + fill.size, 0);
    return Math.max(order.size - filledSize, 0);
  }

  private buyFills(tokenId: TokenId): Fill[] {
    const anchorMs = this.resolveCurrentAnchorMs(tokenId);
    return this.deps.fillRepo
      .findByTokenId(tokenId)
      .filter((fill) => fill.side === "buy")
      .filter((fill) => anchorMs == null || Date.parse(fill.filledAt) >= anchorMs)
      .sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt));
  }

  private ensureLadderState(
    tokenId: TokenId,
    firstFillPrice: number,
    anchorMs: number,
  ): LadderState {
    const key = String(tokenId);
    let state = this.ladderStateByToken.get(key);
    if (!state) {
      state = { attemptedSteps: 0, filledSteps: 0, firstFillPrice, anchorMs };
      this.ladderStateByToken.set(key, state);
    }
    return state;
  }

  private resolveAnchorForFill(event: RuntimeEventMap["FillReceived"]): number {
    return this.resolveCurrentAnchorMs(event.tokenId, event.timestamp) ?? event.timestamp - 1;
  }

  private resolveCurrentAnchorMs(
    tokenId: TokenId,
    beforeOrAtMs = Number.POSITIVE_INFINITY,
  ): number | null {
    const key = String(tokenId);
    const anchors = [
      this.ladderStateByToken.get(key)?.anchorMs,
      this.ladderResetAnchorByToken.get(key),
      parseOptionalIsoMs(this.deps.legStateRepo.get(tokenId)?.firstTradeAt),
    ].filter((value): value is number => value != null && value <= beforeOrAtMs);
    return anchors.length > 0 ? Math.max(...anchors) : null;
  }

  private resetToken(tokenId: TokenId, reason: string): void {
    const key = String(tokenId);
    const timer = this.ladderTimers.get(key);
    if (timer) this.clearTimer(timer);
    this.ladderTimers.delete(key);
    this.ladderStateByToken.delete(key);
    const now = this.now();
    if (reason === "market_resolved") {
      this.ladderResetAnchorByToken.delete(key);
    } else {
      this.ladderResetAnchorByToken.set(key, now);
    }
    this.recordLadderStop(reason);
    this.collectStaleState(now);
    this.writeMetrics(now);
  }

  private recordLadderStop(reason: string): void {
    increment(this.metrics.ladderStopped, reason);
  }

  private writeMetrics(nowMs: number): void {
    this.deps.runtimeMetrics?.writeLatest(
      "entry_lifecycle_activity",
      this.metrics.outbidRepriceSignals + this.metrics.ladderSignals,
      JSON.stringify({ ...this.metrics, capturedAt: new Date(nowMs).toISOString() }),
      new Date(nowMs).toISOString(),
    );
  }

  private touchSignalState(signalId: string, nowMs: number): void {
    this.signalStateTouchedAt.set(signalId, nowMs);
    this.collectStaleState(nowMs);
  }

  // Activity-driven GC is enough here: these maps only grow when signal state
  // is written, so a separate timer would wake the module during quiet periods
  // without reclaiming anything new.
  private collectStaleState(nowMs: number): void {
    if (nowMs - this.lastStateGcAt < STATE_GC_MIN_INTERVAL_MS) return;
    this.lastStateGcAt = nowMs;

    for (const [signalId, touchedAt] of this.signalStateTouchedAt) {
      if (nowMs - touchedAt <= SIGNAL_KEYED_STATE_TTL_MS) continue;
      this.repriceCountBySignalId.delete(signalId);
      this.repricedSignalIds.delete(signalId);
      this.ladderSignalSteps.delete(signalId);
      this.signalStateTouchedAt.delete(signalId);
    }

    for (const [tokenKey, anchorMs] of this.ladderResetAnchorByToken) {
      if (nowMs - anchorMs <= LADDER_RESET_ANCHOR_TTL_MS) continue;
      if (this.ladderStateByToken.has(tokenKey) || this.ladderTimers.has(tokenKey)) continue;
      this.ladderResetAnchorByToken.delete(tokenKey);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private setTimer(fn: () => void, delayMs: number): TimerHandle {
    return this.deps.setTimer ? this.deps.setTimer(fn, delayMs) : setTimeout(fn, delayMs);
  }

  private clearTimer(handle: TimerHandle): void {
    if (this.deps.clearTimer) {
      this.deps.clearTimer(handle);
      return;
    }
    clearTimeout(handle);
  }
}

function createMetrics(): EntryLifecycleMetrics {
  return {
    outbidRepriceCancels: 0,
    outbidRepriceSignals: 0,
    outbidRepriceFills: 0,
    ladderSignals: 0,
    ladderFills: 0,
    ladderCooldownPaused: 0,
    ladderStopped: {},
    ladderSignalsByStep: {},
    ladderFillsByStep: {},
  };
}

function isEntryReason(reason: string | null): reason is SignalReasonType {
  return reason != null && ENTRY_REASONS.has(reason);
}

function isLadderEligibleFill(event: RuntimeEventMap["FillReceived"]): boolean {
  return event.signalId != null && isEntryReason(event.signalReason);
}

function buildRepriceSignalId(repriceCount: number): string {
  return `${OUTBID_REPRICE_SIGNAL_PREFIX}:${repriceCount}:${randomUUID()}`;
}

function parseRepriceCount(signalId: string): number {
  const match = new RegExp(`^${OUTBID_REPRICE_SIGNAL_PREFIX}:(\\d+):`).exec(signalId);
  if (!match) return 0;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function parseOptionalIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isExecutableRemainingSize(size: number, minOrderSize: number | null | undefined): boolean {
  if (!Number.isFinite(size) || size <= EPSILON) return false;
  if (minOrderSize == null || !Number.isFinite(minOrderSize) || minOrderSize <= 0) return true;
  return size + EPSILON >= minOrderSize;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function numericDiagnostic(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isWorking(order: Order): boolean {
  return (
    order.status === "pending" || order.status === "open" || order.status === "partially-filled"
  );
}

function freshEvent(timestamp: number, nowMs: number): boolean {
  return Number.isFinite(timestamp) && timestamp <= nowMs + 1_000 && nowMs - timestamp <= 3_000;
}

function activeWindow(activatedAtUtc: string, expiresAtUtc: string, nowMs: number): boolean {
  const activatedAtMs = Date.parse(activatedAtUtc);
  const expiresAtMs = Date.parse(expiresAtUtc);
  return (
    Number.isFinite(activatedAtMs) &&
    Number.isFinite(expiresAtMs) &&
    nowMs >= activatedAtMs &&
    nowMs < expiresAtMs
  );
}

function frozenWindowMatches(order: Order, activatedAtUtc: string, expiresAtUtc: string): boolean {
  const value = order.metadata?.makerMicroLiveLifecycle;
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).activatedAtUtc === activatedAtUtc &&
    (value as Record<string, unknown>).expiresAtUtc === expiresAtUtc
  );
}
