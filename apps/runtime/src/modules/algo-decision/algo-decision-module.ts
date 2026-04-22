/**
 * AlgoDecisionModule — subscribes to market updates and evaluates tokens against
 * the algo decision engine, emitting SignalProduced / RedeemRequested events.
 *
 * Subscribes to:
 *  - NormalizedMarketUpdated → update market cache, evaluate affected tokens
 *  - OrderPlaced (buy side) → track pending entries for deduplication
 *  - FillReceived (buy side) → clear pending entry on fill
 *  - OrderCancelled → clear pending entry by orderId
 *  - OrderRejected → clear pending entry by clientOrderId
 *
 * On sweep interval:
 *  - Prune expired pending entries (120s timeout)
 *  - Evaluate all eligible tokens against all leg states
 */

import { randomUUID } from "node:crypto";
import type {
  EventBus,
  RuntimeModule,
  LegStateRepository,
  AlgoRulesRepository,
  NormalizedMarket,
  AlgoDecisionRule,
  AlgoSizeRule,
  RuntimeEventMap,
  TokenId,
  ConditionId,
  OrderRepository,
  ProfileId,
} from "@plankton/domain";
import {
  deriveState,
  evaluateDecision,
  evaluateRedeem,
  evaluateSize,
  resolveSignalReason,
  evaluateContinuation,
  matchRule,
  isAlive,
} from "@plankton/domain";
import type { EvalContext } from "@plankton/domain";
import type { RuntimeControl } from "@plankton/domain";
import type { Logger } from "../../logger.js";
import {
  hasWalletBuyBudget,
  resolveWalletBuyBudget,
  type WalletBudgetControlDb,
} from "../../wallet-buy-budget.js";

// ─── SelectedMarketCache ─────────────────────────────────────────────────────

/**
 * External cache of markets selected for trading — used to gate new entries.
 * Tokens with an existing LegState bypass isEligible (see evaluateToken).
 */
export interface SelectedMarketCache {
  isEligible(tokenId: TokenId): boolean;
  getEligibleTokenIds(): TokenId[];
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface PendingEntry {
  tokenId: string;
  signalId: string;
  sizeUsdc: number;
  reservedAt: number;
  persisted: boolean;
  clientOrderId: string | null;
  orderId: string | null;
}

type TokenEvalResult =
  | { type: "redeem"; conditionId: string }
  | { type: "signal"; signal: import("@plankton/domain").Signal }
  | null;

// ─── Deps ────────────────────────────────────────────────────────────────────

export interface AlgoDecisionModuleDeps {
  bus: EventBus;
  legStateRepo: LegStateRepository;
  algoRulesRepo: AlgoRulesRepository;
  orderRepo?: Pick<OrderRepository, "sumOpenBuyNotional"> | undefined;
  selectedMarketCache: SelectedMarketCache;
  runtimeControl?: RuntimeControl;
  controlDb?: WalletBudgetControlDb | undefined;
  activeProfile?: ProfileId | undefined;
  walletBufferPct?: number | undefined;
  walletBufferMinUsdc?: number | undefined;
  log: Logger;
  sweepIntervalMs: number;
}

// ─── Module ──────────────────────────────────────────────────────────────────

const PENDING_ENTRY_TIMEOUT_MS = 120_000;
const SELL_ONLY = new Set(["SELL"]);

export class AlgoDecisionModule implements RuntimeModule {
  private readonly log: Logger;

  // Market cache — updated on every NormalizedMarketUpdated
  private readonly marketCache = new Map<string, NormalizedMarket>();

  // Rules — loaded once on start()
  private decisionRules: readonly AlgoDecisionRule[] = [];
  private buySizeRules: readonly AlgoSizeRule[] = [];
  private sellSizeRules: readonly AlgoSizeRule[] = [];

  // Pending entries — prevents re-signalling while a buy order is in-flight
  private readonly pendingEntries = new Map<string, PendingEntry>(); // tokenId → entry
  private readonly clientOrderToToken = new Map<string, string>(); // clientOrderId → tokenId
  private readonly orderIdToToken = new Map<string, string>(); // orderId → tokenId

  private tickCounter = 0;
  private unsubs: Array<() => void> = [];
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(private readonly deps: AlgoDecisionModuleDeps) {
    this.log = deps.log.child({ module: "algo-decision" });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.decisionRules = this.deps.algoRulesRepo.getDecisionRules();
    this.buySizeRules = this.deps.algoRulesRepo.getSizeRules("BUY");
    this.sellSizeRules = this.deps.algoRulesRepo.getSizeRules("SELL");

    // Fail-closed at startup: without a FALLBACK decision rule, evaluateDecision
    // will throw on every sweep once an unmatched state appears. Refuse to
    // start so the operator sees a clean config error rather than a deferred
    // runtime crash.
    if (!this.decisionRules.some((r) => r.ruleId === "FALLBACK")) {
      throw new Error("FALLBACK rule missing from algo_decision_rules — supervisor cannot start");
    }

    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) => this.handleMarketUpdate(p)),
      this.deps.bus.subscribe("TrackedMarketsChanged", (p) => this.handleTrackedMarketsChanged(p)),
      this.deps.bus.subscribe("SignalRejected", (p) => this.handleSignalRejected(p)),
      this.deps.bus.subscribe("SignalConversionSkipped", (p) => this.handleSignalConversionSkipped(p)),
      this.deps.bus.subscribe("PlaceOrderRequested", (p) => this.handlePlaceOrderRequested(p)),
      this.deps.bus.subscribe("OrderPlaced", (p) => this.handleOrderPlaced(p)),
      this.deps.bus.subscribe("FillReceived", (p) => this.handleFillReceived(p)),
      this.deps.bus.subscribe("OrderCancelled", (p) => this.handleOrderCancelled(p)),
      this.deps.bus.subscribe("OrderRejected", (p) => this.handleOrderRejected(p)),
    );

    this.sweepHandle = setInterval(() => {
      this.sweep().catch((err) => this.log.error({ err }, "algo-decision sweep error"));
    }, this.deps.sweepIntervalMs);

    this.started = true;
    this.log.info({ sweepIntervalMs: this.deps.sweepIntervalMs }, "algo-decision module started");
  }

  async stop(): Promise<void> {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.started = false;
    this.log.info("algo-decision module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.started) return { ok: false, detail: "not started" };
    return {
      ok: true,
      detail: `ticks=${this.tickCounter} markets=${this.marketCache.size} pending=${this.pendingEntries.size}`,
    };
  }

  // ─── Event handlers ─────────────────────────────────────────────────────────

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    for (const market of payload.markets) {
      if (!market.active) {
        this.marketCache.delete(String(market.tokenId));
      } else {
        this.marketCache.set(String(market.tokenId), market);
      }
    }
    const tokenIds = payload.markets.filter((m) => m.active).map((m) => m.tokenId);
    await this.evaluateTokens(tokenIds);
  }

  private async handleTrackedMarketsChanged(
    payload: RuntimeEventMap["TrackedMarketsChanged"],
  ): Promise<void> {
    // Tokens leaving the tracked universe never get a final NormalizedMarketUpdated
    // delivery, so marketCache would retain them forever. Evict on scanner churn.
    for (const tokenId of payload.removedTokenIds) {
      this.marketCache.delete(String(tokenId));
    }
  }

  private async handleOrderPlaced(payload: RuntimeEventMap["OrderPlaced"]): Promise<void> {
    if (payload.side !== "buy") return;
    const tokenId = String(payload.tokenId);
    const existing = this.pendingEntries.get(tokenId);
    if (!existing) return;
    existing.persisted = true;
    existing.clientOrderId = String(payload.clientOrderId);
    existing.orderId = String(payload.orderId);
    this.clientOrderToToken.set(existing.clientOrderId, tokenId);
    this.orderIdToToken.set(existing.orderId, tokenId);
  }

  private async handlePlaceOrderRequested(
    payload: RuntimeEventMap["PlaceOrderRequested"],
  ): Promise<void> {
    if (payload.command.side !== "buy") return;
    const tokenId = String(payload.command.tokenId);
    const existing = this.pendingEntries.get(tokenId);
    if (!existing) return;
    existing.clientOrderId = String(payload.command.clientOrderId);
    this.clientOrderToToken.set(existing.clientOrderId, tokenId);
  }

  private async handleFillReceived(payload: RuntimeEventMap["FillReceived"]): Promise<void> {
    if (payload.side !== "buy") return;
    const tokenId = String(payload.tokenId);
    this.clearPendingByTokenId(tokenId);
  }

  private async handleSignalRejected(
    payload: RuntimeEventMap["SignalRejected"],
  ): Promise<void> {
    this.clearPendingByTokenId(String(payload.signal.tokenId));
  }

  private async handleSignalConversionSkipped(
    payload: RuntimeEventMap["SignalConversionSkipped"],
  ): Promise<void> {
    this.clearPendingByTokenId(String(payload.signal.tokenId));
  }

  private async handleOrderCancelled(payload: RuntimeEventMap["OrderCancelled"]): Promise<void> {
    const orderId = String(payload.orderId);
    const tokenId = this.orderIdToToken.get(orderId);
    if (tokenId) this.clearPendingByTokenId(tokenId);
  }

  private async handleOrderRejected(payload: RuntimeEventMap["OrderRejected"]): Promise<void> {
    const clientOrderId = String(payload.clientOrderId);
    const tokenId = this.clientOrderToToken.get(clientOrderId);
    if (tokenId) this.clearPendingByTokenId(tokenId);
  }

  // ─── Sweep ─────────────────────────────────────────────────────────────────

  /** Prune stale pending entries and evaluate all eligible tokens. */
  async sweep(): Promise<void> {
    if (this.deps.runtimeControl?.isPaused()) return;
    this.pruneExpiredPending();

    const allLegStates = this.deps.legStateRepo.getAll();
    const legStateTokenIds = new Set(allLegStates.map((ls) => String(ls.tokenId)));
    const eligibleTokenIds = this.deps.selectedMarketCache.getEligibleTokenIds();
    const eligibleSet = new Set(eligibleTokenIds.map(String));

    // Union of tokens that have a position + eligible tokens from the cache
    const allTokenIds = new Set([...legStateTokenIds, ...eligibleSet]);
    await this.evaluateTokens([...allTokenIds] as TokenId[]);
  }

  // ─── Core evaluation ────────────────────────────────────────────────────────

  /** Evaluate a list of token IDs in one pass, emit signals and redeem events. */
  async evaluateTokens(tokenIds: readonly TokenId[]): Promise<void> {
    if (this.deps.runtimeControl?.isPaused()) return;
    this.tickCounter++;
    const now = Date.now();
    let reservedBuyUsdc =
      (this.deps.orderRepo?.sumOpenBuyNotional() ?? 0) + this.getPendingReservedBuyUsdc();
    const walletBudgetConfig = {
      controlDb: this.deps.controlDb,
      activeProfile: this.deps.activeProfile,
      walletBufferPct: this.deps.walletBufferPct,
      walletBufferMinUsdc: this.deps.walletBufferMinUsdc,
    };

    // seqMap tracks sequence numbers: `${tokenId}|${side}` → next seq
    const seqMap = new Map<string, number>();
    const nextSeq = (key: string): number => {
      const n = seqMap.get(key) ?? 0;
      seqMap.set(key, n + 1);
      return n;
    };

    const redeemConditionIds = new Set<string>();
    const signals: import("@plankton/domain").Signal[] = [];

    for (const tokenId of tokenIds) {
      const result = this.evaluateToken(String(tokenId) as TokenId, now, nextSeq);
      if (!result) continue;
      if (result.type === "redeem") {
        redeemConditionIds.add(result.conditionId);
      } else {
        if (
          result.signal.side === "buy" &&
          !hasWalletBuyBudget(
            resolveWalletBuyBudget(walletBudgetConfig, reservedBuyUsdc),
            result.signal.suggestedSizeUsdc,
          )
        ) {
          continue;
        }
        if (result.signal.side === "buy") {
          this.reservePendingSignal(result.signal, now);
          reservedBuyUsdc += result.signal.suggestedSizeUsdc;
        }
        signals.push(result.signal);
      }
    }

    // Emit grouped RedeemRequested — one event per sweep with deduplicated conditionIds
    if (redeemConditionIds.size > 0) {
      await this.deps.bus.publish("RedeemRequested", {
        conditionIds: [...redeemConditionIds],
        timestamp: now,
      });
    }

    for (const signal of signals) {
      await this.deps.bus.publish("SignalProduced", { signal });
    }
  }

  /** Evaluate a single token. Returns a signal, redeem, or null. */
  private evaluateToken(
    tokenId: TokenId,
    now: number,
    nextSeq: (key: string) => number,
  ): TokenEvalResult {
    const market = this.marketCache.get(String(tokenId));
    if (!market) return null;

    const price = market.midPrice;
    if (price === null || price === undefined) return null;

    const legState = this.deps.legStateRepo.get(tokenId);
    const state = deriveState(legState);

    // Skip tokens with no position that aren't in the selected market cache
    if (!legState && !this.deps.selectedMarketCache.isEligible(tokenId)) return null;

    // Skip tokens that already have a pending buy order in-flight
    if (!legState && this.pendingEntries.has(String(tokenId))) return null;

    const buyCount = legState?.buyCount ?? 0;
    const timeSinceLastSeconds = legState
      ? (now - new Date(legState.lastTradeAt).getTime()) / 1000
      : null;
    const holdDurationSeconds = legState
      ? (now - new Date(legState.firstTradeAt).getTime()) / 1000
      : null;

    const ctx: EvalContext = {
      state,
      price,
      timeSinceLastSeconds,
      buyCount,
      holdDurationSeconds,
    };

    // Redeem check first — if conditions met, skip signal generation
    const redeemResult = evaluateRedeem(ctx, this.decisionRules);
    if (redeemResult) {
      return { type: "redeem", conditionId: market.conditionId };
    }

    // Hard-liveness gate for CLOB signals. REDEEM (above) uses a separate
    // NegRisk contract path and is allowed on unhealthy markets. Any other
    // signal — new-entry BUY, scale-in BUY, exit SELL — must traverse the
    // signal-to-order bridge, which calls this same `isAlive` and rejects
    // regardless of side. Suppress here to eliminate allocation churn from
    // producing signals the bridge will reject anyway. Shared `isAlive` keeps
    // the two gates in lockstep so they can't drift.
    if (!isAlive(market).healthy) return null;

    // Preserved-for-lifecycle gate: market has an open leg but the CLOB no
    // longer accepts new entries (tradable=false). Per spec v2.2 §0 the
    // pre-entry filter is a NEW-BUY gate — preserved markets only emit SELL.
    // Keyed directly on market.tradable, not !isEligible(...), so unrelated
    // eligibility reasons (slug mismatch, etc.) do not force SELL-only.
    const preservedOnly = legState !== null && !market.tradable;

    // Post-entry continuation gate — only applies when we have a leg.
    // Per market-selection-layer-design.md:53, pre-entry filter is separate from
    // position management: legState tokens are gated by continuation, not eligibility.
    if (legState) {
      const legTradeCount = legState.buyCount + legState.sellCount;
      const stop = !evaluateContinuation(legTradeCount, legState.firstTradePrice);
      if (stop) return null; // spec §0: fail continuation → full STOP (no more signals)
      if (preservedOnly) {
        // preserved-only: market de-listed for new entries, exit-only via SELL
        const sellMatch = matchRule(ctx, this.decisionRules, SELL_ONLY);
        if (!sellMatch) return null;
        return this.buildSignal(market, sellMatch, ctx, buyCount, now, nextSeq);
      }
    }

    // Decide action + size
    const decision = evaluateDecision(ctx, this.decisionRules);
    return this.buildSignal(market, decision, ctx, buyCount, now, nextSeq);
  }

  private buildSignal(
    market: NormalizedMarket,
    decision: { action: string; ruleId: string },
    ctx: EvalContext,
    buyCount: number,
    now: number,
    nextSeq: (key: string) => number,
  ): TokenEvalResult {
    const sizeRules = decision.action === "BUY" ? this.buySizeRules : this.sellSizeRules;
    const nthBuy = buyCount + 1;
    const sizeResult = evaluateSize(
      decision.action as "BUY" | "SELL",
      { state: ctx.state, price: ctx.price, nthBuy, buyCount },
      sizeRules,
    );

    const side = decision.action === "BUY" ? "buy" : ("sell" as const);
    const reason = resolveSignalReason(side, buyCount);

    const seqKey = `${market.tokenId}|${side}`;
    const sequenceInTick = nextSeq(seqKey);

    const suggestedSizeUsdc = sizeResult.sizeUsdc;
    const suggestedSize = ctx.price > 0 ? suggestedSizeUsdc / ctx.price : 0;

    const signal: import("@plankton/domain").Signal = {
      signalId: randomUUID(),
      tokenId: market.tokenId,
      conditionId: market.conditionId as ConditionId,
      side,
      suggestedPrice: ctx.price,
      suggestedSize,
      suggestedSizeUsdc,
      reason,
      strategyTick: now,
      sequenceInTick,
      decisionRuleId: decision.ruleId,
      generatedAt: new Date(now).toISOString(),
    };

    return { type: "signal", signal };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private pruneExpiredPending(): void {
    const cutoff = Date.now() - PENDING_ENTRY_TIMEOUT_MS;
    for (const [tokenId, entry] of this.pendingEntries) {
      if (entry.reservedAt < cutoff) {
        this.clearPendingByTokenId(tokenId);
      }
    }
  }

  private clearPendingByTokenId(tokenId: string): void {
    const entry = this.pendingEntries.get(tokenId);
    if (!entry) return;
    this.pendingEntries.delete(tokenId);
    if (entry.clientOrderId) this.clientOrderToToken.delete(entry.clientOrderId);
    if (entry.orderId) this.orderIdToToken.delete(entry.orderId);
  }

  private reservePendingSignal(signal: import("@plankton/domain").Signal, now: number): void {
    this.pendingEntries.set(String(signal.tokenId), {
      tokenId: String(signal.tokenId),
      signalId: signal.signalId,
      sizeUsdc: signal.suggestedSizeUsdc,
      reservedAt: now,
      persisted: false,
      clientOrderId: null,
      orderId: null,
    });
  }

  private getPendingReservedBuyUsdc(): number {
    let reservedBuyUsdc = 0;
    for (const entry of this.pendingEntries.values()) {
      if (!entry.persisted) reservedBuyUsdc += entry.sizeUsdc;
    }
    return reservedBuyUsdc;
  }
}
