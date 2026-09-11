import type {
  BounceAskCaptureBookDecisionProofV1,
  BounceAskCaptureIntent,
  BounceAskCaptureLineageV1,
  BounceAskCaptureTriggerProofV1,
  EventBus,
  ExecutionPolicy,
  FillRepository,
  InventoryLotRepository,
  NormalizedMarket,
  Order,
  OrderRepository,
  PositionRepository,
  RuntimeEventMap,
  RuntimeModule,
  Signal,
} from "@krabs/domain";
import { CAPTURE_READ_RETRY_MS, CaptureWorkRunner } from "../../capture-work-runner.js";
import { buildClientOrderId } from "@krabs/domain/node";
import {
  BOUNCE_EXIT_TARGET_RULE_ID,
  createCommandId,
  parseBounceAskCaptureProofV1,
} from "@krabs/domain";
import {
  buildBounceAskCaptureIdentity,
  computeBounceAskCaptureCandidate,
  isOrdinaryBounceAskRoot,
  loadBounceAskFills,
  parseBounceAskCaptureLineage,
  resolveBounceAskPolicyOrigin,
  evaluateBounceAskPositionOrigin,
  sameBounceAskRoots,
} from "../../bounce-ask-capture.js";
import {
  MAKER_CAPTURE_BOOK_MAX_AGE_MS,
  primeFreshMakerCaptureBook,
  isFreshMakerCaptureEntry,
  resolveMakerCaptureCancellationAnchorMs,
  type MakerCaptureBookCache,
} from "../../maker-capture-reprice.js";
import { parseQuoteMotionOrigin } from "../../quote-motion-shadow.js";
import type { Logger } from "../../logger.js";
import { prepareSuccessorMinimum } from "../../min-order-size.js";
import { isLocalMinimumReason } from "../../internal-order-reasons.js";
import { hasNeverPostedMinimumEvidence, type ExchangeGateway } from "@krabs/domain";

const EPSILON = 1e-9;

export interface BounceAskCaptureLifecycleDeps {
  readonly runtimeControl?: { isPaused(): boolean; generation?(): number } | undefined;
  readonly gateway?: ExchangeGateway | undefined;
  readonly bus: EventBus;
  readonly orderRepo: OrderRepository;
  readonly fillRepo: Pick<FillRepository, "findByOrderId" | "findByOrderIds" | "findByTokenId">;
  readonly positionRepo: Pick<PositionRepository, "findById">;
  readonly inventoryLotRepo: Pick<InventoryLotRepository, "findOpen">;
  readonly policySnapshot: () => { policy: ExecutionPolicy; controlRevision: number | null };
  readonly candidateBookCache?: MakerCaptureBookCache;
  readonly log: Logger;
  readonly now?: () => number;
}

export class BounceAskCaptureLifecycleModule implements RuntimeModule {
  private readonly markets = new Map<string, NormalizedMarket>();
  private readonly publishing = new Set<string>();
  private readonly failedClaims = new Set<string>();
  private readonly unsubs: Array<() => void> = [];
  private readonly terminalUnsubs: Array<() => void> = [];
  private readonly captureWork: CaptureWorkRunner;
  private readonly log: Logger;
  private started = false;
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: BounceAskCaptureLifecycleDeps) {
    this.log = deps.log.child({ module: "bounce-ask-capture-lifecycle" });
    this.captureWork = new CaptureWorkRunner(this.log, () => this.now(), deps.runtimeControl);
  }

  async start(): Promise<void> {
    this.disposeTerminalListeners();
    this.captureWork.start();
    this.listen("NormalizedMarketUpdated", (event) => this.onMarket(event));
    this.listen("TokenMinimumChanged", async ({ tokenId }) => {
      if (this.started && this.markets.has(tokenId) && !this.deps.runtimeControl?.isPaused())
        this.schedule(tokenId, () => this.recover(new Set([tokenId])));
    });
    this.listen("TrackedMarketsChanged", (event) => this.onTrackedMarketsChanged(event));
    this.listen("OrderCancelled", (event) => this.onCancelled(event));
    this.listen("FillReceived", async (event) => {
      this.schedule(String(event.tokenId), () => this.recover(new Set([String(event.tokenId)])));
    });
    this.listen("OrderPlaced", (event) => this.onPlaced(event));
    this.listen("OrderRejected", (event) => this.failBySignal(event.signalId, event.reason));
    this.listen("OrderSkipped", (event) => this.failBySignal(event.signalId, event.reasonCode));
    this.listen("SignalRejected", (event) =>
      this.failBySignal(event.signal.signalId, event.reason),
    );
    this.listen("SignalConversionSkipped", (event) =>
      this.failBySignal(event.signal.signalId, event.reasons.join(",")),
    );
    this.listen("MarketResolvedHint", (event) => this.failResolved(event));
    this.started = true;
    await this.safe(() => this.recover());
    this.log.info("bounce ASK capture lifecycle started");
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const id of this.expiryTimers.keys()) this.clearExpiry(id);
    const draining = this.captureWork.stop();
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.markets.clear();
    await draining;
  }

  disposeTerminalListeners(): void {
    for (const unsub of this.terminalUnsubs) unsub();
    this.terminalUnsubs.length = 0;
  }

  private schedule(tokenId: string, operation: () => Promise<void>): void {
    this.captureWork.schedule(tokenId, () => this.safe(operation, tokenId));
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return { ok: this.started, detail: `markets=${this.markets.size}` };
  }

  private async onMarket(event: RuntimeEventMap["NormalizedMarketUpdated"]): Promise<void> {
    for (const market of event.markets) {
      if (!market.active) this.captureWork.invalidate();
      this.markets.set(String(market.tokenId), market);
      this.schedule(String(market.tokenId), () =>
        this.captureMarket({ ...event, markets: [market] }),
      );
    }
  }

  private async captureMarket(event: RuntimeEventMap["NormalizedMarketUpdated"]): Promise<void> {
    const current = this.captureWork.guard();
    const now = this.now();
    if (!fresh(event.timestamp, now)) return;
    const [eventMarket] = event.markets;
    if (!eventMarket) return;
    const tokenIds = new Set(event.markets.map((market) => String(market.tokenId)));
    await this.recover(tokenIds);
    const snapshot = this.deps.policySnapshot();
    const policy = snapshot.policy.bounceAskCapture;
    if (!policy.enabled || snapshot.controlRevision === null) return;
    for (const order of this.deps.orderRepo.findOpen(eventMarket.tokenId)) {
      if (!current() || !fresh(event.timestamp, this.now())) return;
      if (!tokenIds.has(String(order.tokenId))) continue;
      await this.safe(() => this.tryClaim(order, event.timestamp, snapshot), String(order.tokenId));
    }
  }

  private async onTrackedMarketsChanged(
    event: RuntimeEventMap["TrackedMarketsChanged"],
  ): Promise<void> {
    if (event.removedTokenIds.length) this.captureWork.invalidate();
    for (const tokenId of event.removedTokenIds) this.markets.delete(String(tokenId));
  }

  private async tryClaim(
    order: Order,
    eventTimestampMs: number,
    snapshot: { policy: ExecutionPolicy; controlRevision: number | null },
  ): Promise<void> {
    const current = this.captureWork.guard();
    const policy = snapshot.policy.bounceAskCapture;
    if (this.deps.orderRepo.isOrderManagedByNonterminalBounceAskCaptureIntent?.(order.orderId))
      return;
    let lineage = parseBounceAskCaptureLineage(order);
    if (!lineage) lineage = this.stampRootLineage(order, policy);
    if (!lineage || lineage.replacementIndex >= policy.maxRepricesPerRoot) return;
    let state = this.validateState(order, lineage, snapshot);
    if (!state) return;
    const entry = await primeFreshMakerCaptureBook(
      this.deps.candidateBookCache,
      String(order.tokenId),
      () => this.now(),
    );
    if (!entry || !current() || !fresh(eventTimestampMs, this.now())) return;
    const latest = this.deps.orderRepo.findById(order.orderId);
    snapshot = this.deps.policySnapshot();
    if (!latest || !["open", "partially-filled"].includes(latest.status)) return;
    order = latest;
    state = this.validateState(order, lineage, snapshot);
    if (!state) return;
    const candidate = this.candidate(order, lineage, entry.book, state.market.tickSize);
    if (!candidate.ok) return;
    const identity = buildBounceAskCaptureIdentity(
      lineage.rootOrderId,
      order.orderId,
      lineage.replacementIndex + 1,
    );
    const trigger: BounceAskCaptureTriggerProofV1 = {
      eventTimestampMs,
      evaluatedAtMs: this.now(),
      policySchemaVersion: snapshot.policy.version,
      policyControlRevision: snapshot.controlRevision!,
      sourceCohortActivatedAtUtc: lineage.sourceCohortActivatedAtUtc,
      originalTargetPrice: lineage.originalTargetPrice,
      candidatePrice: candidate.price,
      externalBestBid: candidate.externalBestBid,
      externalBestAsk: candidate.externalBestAsk,
      tickSize: state.market.tickSize,
      positionResidualShares: state.positionResidualShares,
      sourceBuyRootOrderIds: lineage.sourceBuyRootOrderIds,
    };
    const nowIso = new Date(this.now()).toISOString();
    const intent: BounceAskCaptureIntent = {
      intentId: identity.intentId,
      predecessorOrderId: order.orderId,
      lifecycleSignalId: identity.lifecycleSignalId,
      rootOrderId: lineage.rootOrderId,
      positionId: state.position.positionId,
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      replacementIndex: lineage.replacementIndex + 1,
      status: "cancel_pending",
      candidatePrice: null,
      replacementSize: null,
      childOrderId: null,
      failure: null,
      proof: { version: 1, trigger, prepared: null, submit: null },
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    if (!this.deps.orderRepo.claimBounceAskCaptureIntent?.(intent)) return;
    if (!this.markClaimed(intent)) return;
    await this.publishCancel(intent);
  }

  private markClaimed(intent: BounceAskCaptureIntent): boolean {
    try {
      if (this.diagnose(intent, "claimed", "claimed", "data")) return true;
    } catch (err) {
      this.log.error(
        { err, intentId: intent.intentId, reason: "diagnostic-write-conflict" },
        "bounce ASK capture handler failed; durable state retained",
      );
    }
    this.failClaim(intent);
    return false;
  }

  private failClaim(intent: BounceAskCaptureIntent): void {
    // A failed terminal write must not let this known failed claim recover as legacy.
    this.failedClaims.add(intent.intentId);
    this.terminal(intent, "failed", "diagnostic-write-conflict");
    this.failedClaims.delete(intent.intentId);
  }

  private stampRootLineage(
    order: Order,
    source: ExecutionPolicy["bounceAskCapture"],
  ): BounceAskCaptureLineageV1 | null {
    if (!isOrdinaryBounceAskRoot(order) || !order.positionId) return null;
    const origin = parseQuoteMotionOrigin(order);
    const proven = resolveBounceAskPolicyOrigin(order.positionId, order.tokenId, source, this.deps);
    if (origin?.originalTargetPrice == null || !proven) return null;
    const lineage: BounceAskCaptureLineageV1 = {
      version: 1,
      rootOrderId: order.orderId,
      predecessorOrderId: null,
      replacementIndex: 0,
      positionId: proven.position.positionId,
      sourceCohortActivatedAtUtc: proven.sourceCohortActivatedAtUtc,
      permanentR23ActivationId: proven.permanentR23ActivationId,
      permanentR23ActivatedAtUtc: proven.permanentR23ActivatedAtUtc,
      originalTargetPrice: origin.originalTargetPrice,
      sourceBuyRootOrderIds: proven.sourceBuyRootOrderIds,
    };
    const updated = this.deps.orderRepo.updateMetadataIfUnchanged?.(
      order.orderId,
      order.metadata ?? null,
      { ...(order.metadata ?? {}), bounceAskCaptureLineageV1: lineage },
    );
    return updated ? parseBounceAskCaptureLineage(updated) : null;
  }

  private validateState(...args: Parameters<BounceAskCaptureLifecycleModule["evaluateState"]>) {
    const result = this.evaluateState(...args);
    return result.kind === "valid" ? result : null;
  }

  private evaluateState(
    order: Order,
    lineage: BounceAskCaptureLineageV1,
    snapshot: { policy: ExecutionPolicy; controlRevision: number | null },
    recovering = false,
  ) {
    const market = this.markets.get(String(order.tokenId));
    const policy = snapshot.policy.bounceAskCapture;
    const permanent = lineage.permanentR23ActivationId != null;
    const lineageSource = permanent
      ? {
          sourceCohortActivatedAtUtc: lineage.sourceCohortActivatedAtUtc,
          permanentR23ActivationId: lineage.permanentR23ActivationId,
          permanentR23ActivatedAtUtc: lineage.permanentR23ActivatedAtUtc!,
        }
      : lineage.sourceCohortActivatedAtUtc;
    const terminal = (reason: string) => ({ kind: "terminal" as const, reason });
    if (!policy.enabled && !(recovering && permanent)) return terminal("policy-disabled");
    if (snapshot.controlRevision === null) return terminal("null-control-revision");
    if (
      !(recovering && permanent) &&
      (permanent
        ? lineage.permanentR23ActivationId !== policy.permanentR23ActivationId ||
          lineage.permanentR23ActivatedAtUtc !== policy.permanentR23ActivatedAtUtc
        : lineage.sourceCohortActivatedAtUtc !== policy.sourceCohortActivatedAtUtc)
    )
      return terminal("invalid-cohort");
    if (!order.positionId || String(lineage.positionId) !== String(order.positionId))
      return terminal("invalid-position");
    const proven = evaluateBounceAskPositionOrigin(
      order.positionId,
      order.tokenId,
      lineageSource,
      this.deps,
    );
    if (!proven.ok) return terminal(proven.reason);
    if (!sameBounceAskRoots(proven.sourceBuyRootOrderIds, lineage.sourceBuyRootOrderIds))
      return terminal("invalid-root-set");
    if (!market) return { kind: "defer" as const, reason: "normalized-data-missing" };
    if (!market.active || !market.tradable || !market.acceptingOrders || !market.enableOrderBook)
      return terminal("market-prohibited");
    if (market.conditionId !== String(order.conditionId))
      return terminal("market-condition-mismatch");
    if (!Number.isFinite(market.tickSize) || market.tickSize <= 0)
      return terminal("malformed-tick");
    if (!fresh(market.snapshotTs, this.now()))
      return {
        kind: "defer" as const,
        reason:
          !Number.isFinite(market.snapshotTs) || market.snapshotTs > this.now() + 1_000
            ? "normalized-timestamp-invalid"
            : "normalized-data-stale",
      };
    return {
      kind: "valid" as const,
      market,
      position: proven.position,
      positionResidualShares: proven.position.size,
    };
  }

  private candidate(
    order: Order,
    lineage: BounceAskCaptureLineageV1,
    book: Parameters<typeof computeBounceAskCaptureCandidate>[0]["book"],
    tickSize: number,
  ) {
    const own = this.deps.orderRepo
      .findOpen()
      .filter(
        (candidate) =>
          String(candidate.tokenId) === String(order.tokenId) && candidate.side === "sell",
      );
    return computeBounceAskCaptureCandidate({
      book,
      tickSize,
      ownSellOrders: own,
      fillsByOrder: loadBounceAskFills(this.deps.fillRepo, own),
      predecessorPrice: order.price,
      originalTargetPrice: lineage.originalTargetPrice,
    });
  }

  private async onCancelled(event: RuntimeEventMap["OrderCancelled"]): Promise<void> {
    const intent = this.deps.orderRepo.findBounceAskCaptureIntentByPredecessor?.(event.orderId);
    if (!intent) return;
    if (event.reason !== "bounce_ask_capture_reprice") {
      this.terminal(intent, "failed", `senior-cancel:${event.reason}`);
      return;
    }
    this.checkDataWindow(intent);
    this.schedule(String(intent.tokenId), () => this.advance(intent));
  }

  private async recover(tokenIds?: ReadonlySet<string>): Promise<void> {
    for (const intent of this.deps.orderRepo.findRecoverableBounceAskCaptureIntents?.() ?? []) {
      if (!tokenIds || tokenIds.has(String(intent.tokenId)))
        await this.safe(() => this.advance(intent), String(intent.tokenId));
    }
  }

  private async advance(intent: BounceAskCaptureIntent): Promise<void> {
    if (this.failedClaims.has(intent.intentId)) {
      this.failClaim(intent);
      return;
    }
    if (!this.checkDataWindow(intent)) return;
    if (!this.captureWork.guard()()) return;
    const durable = this.deps.orderRepo.findBounceAskCaptureIntentBySignal?.(
      intent.lifecycleSignalId,
    );
    if (!durable || !["cancel_pending", "ready", "submitted"].includes(durable.status)) return;
    intent = durable;
    const child = this.findChild(intent);
    if (intent.status === "submitted" && child && hasNeverPostedMinimumEvidence(child)) {
      if (!this.deps.orderRepo.resetBounceAskCaptureSubmitted?.(intent.intentId, child.orderId))
        return;
      intent = { ...intent, status: "ready", childOrderId: null };
    }
    if (child && !hasNeverPostedMinimumEvidence(child)) {
      if (child.status === "rejected") this.terminal(intent, "failed", "child-rejected");
      else if (child.status === "pending") {
        const predecessor = this.deps.orderRepo.findById(intent.predecessorOrderId);
        if (predecessor) await this.publishSignal(intent, predecessor);
      } else this.terminal(intent, "completed");
      return;
    }
    if (intent.status === "submitted") {
      return;
    }
    const predecessor = this.deps.orderRepo.findById(intent.predecessorOrderId);
    if (!predecessor) return;
    if (predecessor.status === "open" || predecessor.status === "partially-filled") {
      if (!this.markets.has(String(intent.tokenId))) return;
      const lineage = parseBounceAskCaptureLineage(predecessor);
      const state = lineage && this.evaluateState(predecessor, lineage, this.deps.policySnapshot());
      if (!state || state.kind !== "valid") {
        this.terminal(intent, "failed", state?.reason ?? "invalid-lineage");
        return;
      }
      if (intent.status === "cancel_pending") await this.publishCancel(intent);
      return;
    }
    if (predecessor.status !== "cancelled") {
      this.terminal(intent, "failed", `predecessor-${predecessor.status}`);
      return;
    }
    let current = intent;
    if (intent.status === "cancel_pending") {
      const ready = await this.prepare(intent, predecessor);
      if (!ready) return;
      current = ready;
    }
    if (current.status === "ready") await this.publishSignal(current, predecessor);
  }

  private async prepare(
    intent: BounceAskCaptureIntent,
    predecessor: Order,
  ): Promise<BounceAskCaptureIntent | null> {
    const current = this.captureWork.guard();
    const proof = parseBounceAskCaptureProofV1(intent.proof);
    if (!proof) {
      this.terminal(intent, "failed", "malformed-proof");
      return null;
    }
    if (!this.recoveryState(intent, predecessor)) return null;
    let entry;
    try {
      entry = await primeFreshMakerCaptureBook(
        this.deps.candidateBookCache,
        String(intent.tokenId),
        () => this.now(),
      );
    } catch (err) {
      if (current()) {
        const latest = this.unsubmitted(intent);
        const order = this.deps.orderRepo.findById(intent.predecessorOrderId);
        if (latest && order && this.recoveryState(latest, order))
          this.deferData(latest, "book-read-failed");
      }
      throw err;
    }
    if (!current()) return null;
    const latest = this.unsubmitted(intent);
    const latestOrder = this.deps.orderRepo.findById(predecessor.orderId);
    if (latest?.status !== "cancel_pending" || !latestOrder) return null;
    predecessor = latestOrder;
    const state = this.recoveryState(latest, predecessor);
    if (!state) return null;
    const lineage = parseBounceAskCaptureLineage(predecessor)!;
    const minOrderSize = entry?.book.minOrderSize;
    if (!entry) {
      this.deferData(intent, "book-data-missing");
      return null;
    }
    const replacementSize = bounceCaptureResidual(
      predecessor.size,
      state.position.size,
      this.deps.fillRepo.findByOrderId(predecessor.orderId),
    );
    if (
      minOrderSize == null ||
      !Number.isFinite(minOrderSize) ||
      minOrderSize <= 0 ||
      replacementSize + EPSILON < minOrderSize
    ) {
      if (
        this.diagnose(
          intent,
          "deferred",
          minOrderSize == null || !Number.isFinite(minOrderSize) || minOrderSize <= 0
            ? "minimum-unknown"
            : "residual-below-minimum",
          "minimum",
          { residualShares: replacementSize, minOrderSize: minOrderSize ?? null },
        )
      )
        this.clearExpiry(intent.intentId);
      return null;
    }
    const candidate = this.candidate(predecessor, lineage, entry.book, state.market.tickSize);
    if (!candidate.ok) {
      this.terminal(intent, "failed", candidate.reason);
      return null;
    }
    const trigger = proof.trigger;
    const prepared: BounceAskCaptureBookDecisionProofV1 = {
      ...trigger,
      evaluatedAtMs: this.now(),
      candidatePrice: candidate.price,
      externalBestBid: candidate.externalBestBid,
      externalBestAsk: candidate.externalBestAsk,
      positionResidualShares: state.position.size,
      snapshotTs: entry.snapshotTs,
      cachedAtMs: entry.cachedAtMs,
      sourcePolledAtMs: entry.sourcePolledAtMs,
      minOrderSize,
      replacementSize,
    };
    if (
      !this.deps.orderRepo.markBounceAskCaptureReady?.(
        intent.intentId,
        candidate.price,
        replacementSize,
        prepared,
      )
    )
      return null;
    this.diagnose(intent, "ready", "ready", undefined, {
      residualShares: replacementSize,
      minOrderSize,
    });
    return {
      ...intent,
      status: "ready",
      candidatePrice: candidate.price,
      replacementSize,
      proof: { ...proof, prepared },
    };
  }

  private async publishSignal(intent: BounceAskCaptureIntent, predecessor: Order): Promise<void> {
    if (!this.captureWork.guard()()) return;
    const durable = this.deps.orderRepo.findBounceAskCaptureIntentBySignal?.(
      intent.lifecycleSignalId,
    );
    if (!durable || !["ready", "submitted"].includes(durable.status)) return;
    intent = durable;
    if (this.unsubmitted(intent) && intent.status === "ready") {
      const latest = this.deps.orderRepo.findById(intent.predecessorOrderId);
      const state = latest && this.recoveryState(intent, latest);
      if (!latest || !state) return;
      const residual = bounceCaptureResidual(
        latest.size,
        state.position.size,
        this.deps.fillRepo.findByOrderId(latest.orderId),
      );
      if (residual !== intent.replacementSize) {
        this.terminal(intent, "failed", "prepared-residual-changed");
        return;
      }
      predecessor = latest;
    }
    if (
      intent.candidatePrice == null ||
      intent.replacementSize == null ||
      this.publishing.has(intent.lifecycleSignalId)
    )
      return;
    const market = this.markets.get(String(intent.tokenId));
    if (!market) return;
    const signal: Signal = {
      signalId: intent.lifecycleSignalId,
      tokenId: intent.tokenId,
      conditionId: intent.conditionId,
      positionId: intent.positionId,
      side: "sell",
      suggestedPrice: intent.candidatePrice,
      suggestedSize: intent.replacementSize,
      suggestedSizeUsdc: intent.candidatePrice * intent.replacementSize,
      reason: predecessor.signalReason as Signal["reason"],
      strategyTick: this.now(),
      sequenceInTick: intent.replacementIndex,
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      sizingRuleId: null,
      generatedAt: new Date(this.now()).toISOString(),
      bounceAskCaptureReprice: {
        version: 1,
        intentId: intent.intentId,
        rootOrderId: intent.rootOrderId,
        predecessorOrderId: intent.predecessorOrderId,
        replacementIndex: intent.replacementIndex,
      },
    };
    this.publishing.add(intent.lifecycleSignalId);
    this.captureWork.discardPending(String(intent.tokenId));
    try {
      await this.deps.bus.publish("SignalProduced", { signal, market });
    } finally {
      this.publishing.delete(intent.lifecycleSignalId);
    }
  }

  private async publishCancel(intent: BounceAskCaptureIntent): Promise<void> {
    const current = this.captureWork.guard();
    const successorMinimum = () =>
      current()
        ? this.captureWork.read(String(intent.tokenId), () =>
            this.prepareCancelMinimum(intent, current),
          )
        : Promise.resolve(null);
    if (!(await successorMinimum())?.()) return;
    const identity = buildBounceAskCaptureIdentity(
      intent.rootOrderId,
      intent.predecessorOrderId,
      intent.replacementIndex,
    );
    await this.deps.bus.publish("CancelOrderRequested", {
      successorMinimum,
      command: {
        type: "CancelOrderCommand",
        commandId: createCommandId(identity.cancelCommandId),
        orderId: intent.predecessorOrderId,
        reason: "bounce_ask_capture_reprice",
      },
      timestamp: this.now(),
    });
  }

  private async onPlaced(event: RuntimeEventMap["OrderPlaced"]): Promise<void> {
    const intent = this.deps.orderRepo.findBounceAskCaptureIntentByChild?.(event.orderId);
    if (intent) this.terminal(intent, "completed");
  }

  private async prepareCancelMinimum(intent: BounceAskCaptureIntent, current: () => boolean) {
    const market = this.markets.get(String(intent.tokenId));
    if (!market || !current()) return null;
    const entry = await primeFreshMakerCaptureBook(
      this.deps.candidateBookCache,
      String(intent.tokenId),
      () => this.now(),
    );
    if (!current() || !entry || !this.deps.gateway) return null;
    return prepareSuccessorMinimum(this.deps.gateway, () => {
      const predecessor = this.deps.orderRepo.findById(intent.predecessorOrderId);
      const lineage = predecessor && parseBounceAskCaptureLineage(predecessor);
      const policy = this.deps.policySnapshot();
      const state = predecessor && lineage && this.validateState(predecessor, lineage, policy);
      if (
        !current() ||
        !isFreshMakerCaptureEntry(entry, this.now()) ||
        this.deps.orderRepo.findBounceAskCaptureIntentBySignal?.(intent.lifecycleSignalId)
          ?.status !== "cancel_pending" ||
        this.deps.runtimeControl?.isPaused() ||
        this.markets.get(String(intent.tokenId)) !== market ||
        !predecessor ||
        !lineage ||
        !state ||
        !["open", "partially-filled"].includes(predecessor.status)
      )
        return null;
      const candidate = this.candidate(predecessor, lineage, entry.book, state.market.tickSize);
      if (!candidate.ok) return null;
      const fills = this.deps.fillRepo.findByOrderId(predecessor.orderId);
      const size = bounceCaptureResidual(predecessor.size, state.position.size, fills);
      return {
        params: {
          clientOrderId: intent.lifecycleSignalId,
          tokenId: intent.tokenId,
          side: "sell" as const,
          size,
          price: candidate.price,
          orderType: predecessor.orderType,
          postOnly: true,
          tickSize: state.market.tickSize,
          negRisk: state.market.negRisk,
        },
        state: JSON.stringify([predecessor, fills, state.position, state.market, policy]),
      };
    });
  }

  private async failBySignal(signalId: string | null | undefined, reason: string): Promise<void> {
    if (isLocalMinimumReason(reason)) return;
    if (!signalId) return;
    const intent = this.deps.orderRepo.findBounceAskCaptureIntentBySignal?.(signalId);
    if (intent) this.terminal(intent, "failed", reason);
  }

  private async failResolved(event: RuntimeEventMap["MarketResolvedHint"]): Promise<void> {
    this.captureWork.invalidate();
    const tokens = new Set(event.tokenIds.map(String));
    for (const tokenId of tokens) this.markets.delete(tokenId);
    for (const intent of this.deps.orderRepo.findRecoverableBounceAskCaptureIntents?.() ?? []) {
      if (tokens.has(String(intent.tokenId))) this.terminal(intent, "failed", "market-resolved");
    }
  }

  private terminal(
    intent: BounceAskCaptureIntent,
    status: "completed" | "failed" | "dust",
    failure?: string,
  ): void {
    if (
      !this.deps.orderRepo.markBounceAskCaptureTerminal?.(intent.intentId, status, failure ?? null)
    ) {
      const latest = this.deps.orderRepo.findBounceAskCaptureIntentBySignal?.(
        intent.lifecycleSignalId,
      );
      if (latest && ["cancel_pending", "ready", "submitted"].includes(latest.status))
        throw new Error("bounce ASK capture terminal write failed; durable ownership retained");
      this.clearExpiry(intent.intentId);
      return;
    }
    this.clearExpiry(intent.intentId);
    this.publishing.delete(intent.lifecycleSignalId);
    try {
      this.diagnose(intent, status, failure ?? status);
    } catch (err) {
      this.log.error(
        { err, intentId: intent.intentId },
        "bounce ASK capture terminal diagnostic failed",
      );
    }
  }

  private findChild(intent: BounceAskCaptureIntent): Order | null {
    const linked = intent.childOrderId ? this.deps.orderRepo.findById(intent.childOrderId) : null;
    return (
      linked ??
      this.deps.orderRepo.findByClientOrderId?.(
        buildClientOrderId({
          signalId: intent.lifecycleSignalId,
          tokenId: intent.tokenId,
          side: "sell",
        }),
      ) ??
      null
    );
  }

  private unsubmitted(intent: BounceAskCaptureIntent): BounceAskCaptureIntent | null {
    const latest = this.deps.orderRepo.findBounceAskCaptureIntentBySignal?.(
      intent.lifecycleSignalId,
    );
    if (
      !latest ||
      latest.intentId !== intent.intentId ||
      !["cancel_pending", "ready"].includes(latest.status)
    )
      return null;
    const child = this.findChild(latest);
    return child && !hasNeverPostedMinimumEvidence(child) ? null : latest;
  }

  private recoveryMarker(intent: BounceAskCaptureIntent) {
    const marker = this.deps.orderRepo.findById(intent.predecessorOrderId)?.metadata
      ?.bounceAskCaptureRecoveryV1 as Record<string, unknown> | undefined;
    return marker?.version === 1 && marker.intentId === intent.intentId ? marker : undefined;
  }

  private diagnose(
    intent: BounceAskCaptureIntent,
    phase: string,
    reason: string,
    recoveryClass?: "data" | "minimum",
    scalars: Record<string, unknown> = {},
  ): boolean {
    const order = this.deps.orderRepo.findById(intent.predecessorOrderId);
    if (!order) return false;
    const prior = this.recoveryMarker(intent);
    if (
      prior?.phase === phase &&
      prior.reason === reason &&
      (!recoveryClass || prior.recoveryClass === recoveryClass)
    )
      return true;
    const anchor =
      order.status === "cancelled" ? resolveMakerCaptureCancellationAnchorMs(order) : null;
    const marker = {
      ...prior,
      version: 1,
      intentId: intent.intentId,
      ...(recoveryClass ? { recoveryClass } : {}),
      phase,
      reason,
      startedAtMs: prior?.startedAtMs ?? this.now(),
      updatedAtMs: this.now(),
      cancellationAnchorMs: anchor,
      deadlineMs: anchor == null ? null : anchor + MAKER_CAPTURE_BOOK_MAX_AGE_MS,
      ...scalars,
    };
    return Boolean(
      this.deps.orderRepo.updateMetadataIfUnchanged?.(order.orderId, order.metadata ?? null, {
        ...order.metadata,
        bounceAskCaptureRecoveryV1: marker,
      }),
    );
  }

  private clearExpiry(id: string): void {
    clearTimeout(this.expiryTimers.get(id));
    this.expiryTimers.delete(id);
  }

  private checkDataWindow(intent: BounceAskCaptureIntent): boolean {
    if (!this.started) return false;
    if (this.preserveMinimumWait(intent)) return true;
    const latest = this.unsubmitted(intent);
    if (!latest || this.recoveryMarker(latest)?.recoveryClass !== "data") {
      this.clearExpiry(intent.intentId);
      return true;
    }
    const order = this.deps.orderRepo.findById(latest.predecessorOrderId);
    if (!order || order.status !== "cancelled") return true;
    const anchor = resolveMakerCaptureCancellationAnchorMs(order);
    if (
      anchor === null ||
      anchor > this.now() ||
      this.now() >= anchor + MAKER_CAPTURE_BOOK_MAX_AGE_MS
    ) {
      this.terminal(
        latest,
        "failed",
        anchor === null || anchor > this.now()
          ? "invalid-cancellation-anchor"
          : "post-cancel-data-expired",
      );
      return false;
    }
    this.armExpiry(intent, anchor + MAKER_CAPTURE_BOOK_MAX_AGE_MS - this.now());
    return true;
  }

  private preserveMinimumWait(intent: BounceAskCaptureIntent): boolean {
    const latest = this.deps.orderRepo.findBounceAskCaptureIntentBySignal?.(
      intent.lifecycleSignalId,
    );
    if (!latest || !["cancel_pending", "ready", "submitted"].includes(latest.status)) return false;
    const child = this.findChild(latest);
    if (!child || !hasNeverPostedMinimumEvidence(child)) return false;
    if (
      this.recoveryMarker(latest)?.recoveryClass === "data" &&
      !this.diagnose(latest, "deferred", child.exchangeErrorMessage!, "minimum")
    )
      throw new Error("bounce ASK capture minimum recovery classification write failed");
    this.clearExpiry(intent.intentId);
    return true;
  }

  private armExpiry(intent: BounceAskCaptureIntent, delayMs: number, retry = true): void {
    if (!this.started || this.expiryTimers.has(intent.intentId)) return;
    const timer = setTimeout(() => {
      this.clearExpiry(intent.intentId);
      try {
        this.checkDataWindow(intent);
      } catch (err) {
        this.log.error(
          { err, intentId: intent.intentId, retry },
          retry
            ? "bounce ASK capture expiry failed; retry scheduled"
            : "bounce ASK capture expiry retry failed; durable ownership retained for event or restart recovery",
        );
        if (retry) this.armExpiry(intent, CAPTURE_READ_RETRY_MS, false);
      }
    }, delayMs);
    timer.unref?.();
    this.expiryTimers.set(intent.intentId, timer);
  }

  private deferData(intent: BounceAskCaptureIntent, reason: string): void {
    if (this.checkDataWindow(intent)) this.diagnose(intent, "deferred", reason);
  }

  private recoveryState(intent: BounceAskCaptureIntent, order: Order) {
    if (!this.checkDataWindow(intent)) return null;
    const marker = this.recoveryMarker(intent);
    if (marker?.recoveryClass !== "data" && !this.markets.has(String(intent.tokenId))) return null;
    const lineage = parseBounceAskCaptureLineage(order);
    const state = lineage
      ? this.evaluateState(order, lineage, this.deps.policySnapshot(), true)
      : ({ kind: "terminal", reason: "invalid-lineage" } as const);
    if (order.status !== "cancelled") {
      this.terminal(intent, "failed", `predecessor-${order.status}`);
      return null;
    }
    if (state.kind === "valid") return state;
    if (state.kind === "terminal" || marker?.recoveryClass !== "data")
      this.terminal(intent, "failed", state.reason);
    else this.deferData(intent, state.reason);
    return null;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async safe(operation: () => Promise<void>, tokenId?: string): Promise<void> {
    try {
      if (tokenId) await this.captureWork.read(tokenId, operation);
      else await operation();
    } catch (err) {
      this.log.error({ err }, "bounce ASK capture handler failed; durable state retained");
    }
  }

  private listen<K extends keyof RuntimeEventMap>(
    event: K,
    handler: (payload: RuntimeEventMap[K]) => Promise<void>,
  ): void {
    const terminal = [
      "OrderCancelled",
      "OrderPlaced",
      "OrderRejected",
      "OrderSkipped",
      "SignalRejected",
      "SignalConversionSkipped",
    ].includes(event);
    (terminal ? this.terminalUnsubs : this.unsubs).push(
      this.deps.bus.subscribe(event, (payload) => this.safe(() => handler(payload))),
    );
  }
}

function bounceCaptureResidual(
  size: number,
  positionSize: number,
  fills: readonly { size: number }[],
): number {
  return Math.min(
    Math.max(0, size - fills.reduce((sum, fill) => sum + fill.size, 0)),
    positionSize,
  );
}

function fresh(timestamp: number, now: number): boolean {
  return (
    Number.isFinite(timestamp) &&
    timestamp <= now + 1_000 &&
    now - timestamp <= MAKER_CAPTURE_BOOK_MAX_AGE_MS
  );
}
