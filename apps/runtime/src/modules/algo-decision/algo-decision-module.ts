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
import type Database from "better-sqlite3";
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
  DecisionSignalLog,
  DecisionSignalLogRepository,
  RiskEventRepository,
  MarketTradeCountProvider,
  ContinuationMode,
  ExecutionPolicy,
} from "@plankton/domain";
import {
  deriveState,
  evaluateDecision,
  evaluateRedeem,
  evaluateSize,
  resolveSignalReason,
  evaluateContinuation,
  evaluateMinMarketAge,
  matchRule,
  isAlive,
} from "@plankton/domain";
import { readContinuationMode, readContinuationModeVersion } from "@plankton/db";
import type { EvalContext } from "@plankton/domain";
import type { RuntimeControl } from "@plankton/domain";
import type { Logger } from "../../logger.js";
import {
  hasWalletBuyBudget,
  resolveWalletBuyBudget,
  type WalletBudgetControlDb,
} from "../../wallet-buy-budget.js";
import { classifyNotionalBucket } from "../../executable-price.js";

// ─── SelectedMarketCache ─────────────────────────────────────────────────────

/**
 * External cache of markets selected for trading — used to gate new entries.
 * Tokens with an existing LegState bypass isEligible (see evaluateToken).
 */
export interface SelectedMarketCache {
  isEligible(tokenId: TokenId): boolean;
  getEligibleTokenIds(): TokenId[];
  /**
   * ADR-018 §D2 — optional Step 1 universe-filter funnel snapshot. Implemented
   * by `MarketSelectionCache`; absent on test stubs that don't need telemetry.
   */
  getUniverseFilterSnapshot?(): {
    readonly seen: number;
    readonly volumeZeroDropped: number;
    readonly volumeNullEvaluated: number;
    readonly volumePositiveEvaluated: number;
    readonly selectionRuleAdmitted: number;
    readonly selectionRuleRejected: number;
  };
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
  | {
      type: "signal";
      signal: import("@plankton/domain").Signal;
      market: NormalizedMarket;
      // Deferred persistence of decision_signal_log + signal_emitted risk_event.
      // The wallet-budget filter in `evaluateTokensInner` may drop the signal
      // after `evaluateToken` returns; only call this once the signal is
      // committed to the emit queue, otherwise telemetry overcounts emissions
      // by the silently-dropped tail and operators cannot trust
      // signal_emitted/signal_suppressed parity.
      commitLog: () => void;
    }
  | null;

/**
 * ADR-016: which source the continuation gate consulted for `trade_count`.
 *  - `market_wide` — fresh value from `MarketTradeCountProvider`.
 *  - `leg_local_fallback` — provider returned `null` (network/timeout/parse);
 *    we degraded to ADR-010 D1 (per-leg `buyCount + sellCount`).
 *  - `leg_local` — operator policy is `leg_local`; provider was not consulted.
 */
type TradeCountSource = "market_wide" | "leg_local_fallback" | "leg_local";

type EmissionFacts = {
  firstTradePrice: number | null;
  legTradeCount: number;
  continuationStop?: boolean | null;
  continuationTradeCount?: number | null;
  continuationTradeCountSource?: TradeCountSource | null;
};

/**
 * ADR-022 §D-F — entry-price bucket categories aligned with R24 §9.6 buckets.
 * Buckets are right-closed: `<=0.005`, `(0.005-0.05]`, `(0.05-0.20]`, `>0.20`.
 */
type EntryPriceBucket = "<=0.005" | "0.005-0.05" | "0.05-0.20" | ">0.20";

function classifyEntryPriceBucket(price: number): EntryPriceBucket {
  if (price <= 0.005) return "<=0.005";
  if (price <= 0.05) return "0.005-0.05";
  if (price <= 0.2) return "0.05-0.20";
  return ">0.20";
}

/**
 * ADR-022 §D-F — F-telemetry derived facts captured at signal-emission time.
 * `dropFromLastSeen` is `(price - prevMidPrice) / prevMidPrice` against the
 * immediately prior `NormalizedMarketUpdated` for this token; `null` on the
 * first observation. Sign convention: negative = price went down, positive =
 * price went up. `entryPriceBucket` mirrors R24 §9.6 buckets.
 */
type TriggerTelemetry = {
  dropFromLastSeen: number | null;
  entryPriceBucket: EntryPriceBucket;
};

type ContinuationFacts = {
  tradeCount: number;
  tradeCountSource: TradeCountSource;
  stop: boolean;
};

type SuppressionFacts = {
  tokenId: TokenId;
  conditionId: string | null;
  /**
   * Free-string code identifying the suppression reason. Currently emitted
   * by the AlgoDecisionModule sweep:
   *
   * - `market-cache-miss` — token in selection but no NormalizedMarket yet.
   * - `mid-price-unavailable` — market lacks a usable mid for the gate.
   * - `pending-buy-order` — open BUY order already exists for token.
   * - `redeem-before-end-date` — REDEEM blocked by endDate guard.
   * - `market-not-live` — hard-liveness gate (acceptingOrders / book / spread).
   * - `continuation-stop` — leg failed R1/R2 continuation gate.
   * - `preserved-only-no-sell-rule` — preserved leg with no SELL rule match.
   * - `market_too_young` — Step 0 §P3, age < `entryMinMarketAgeSeconds`
   *   (spec §1.7 R1, `06:423`). Sticky → deduped via
   *   `DEDUPED_SUPPRESSION_REASONS`.
   * - `market_age_unknown` — Step 0 §P3, gammaCreatedAt is null/unparseable
   *   while the gate is enabled. Sticky → deduped.
   *
   * Adding a new reason: pick a kebab/snake-case identifier, document it
   * here, and decide whether it should join `DEDUPED_SUPPRESSION_REASONS`
   * (sticky reasons that fire on every sweep tick must, or they flood
   * `risk_events` ~1/sec).
   */
  reasonCode: string;
  reasons?: readonly string[];
  side?: "BUY" | "SELL" | "REDEEM" | null;
  decisionRuleId?: string | null;
  state: DecisionSignalLog["state"];
  price: number | null;
  buyCount: number;
  timeSinceLastSeconds: number | null;
  emissionFacts: EmissionFacts;
  timestamp: string;
  tradeCount?: number | null;
  tradeCountSource?: TradeCountSource | null;
};

// ─── Deps ────────────────────────────────────────────────────────────────────

export interface AlgoDecisionModuleDeps {
  bus: EventBus;
  legStateRepo: LegStateRepository;
  algoRulesRepo: AlgoRulesRepository;
  orderRepo?: Pick<OrderRepository, "sumOpenBuyNotional"> | undefined;
  decisionSignalLogRepo?: DecisionSignalLogRepository | undefined;
  riskEventRepo?: RiskEventRepository | undefined;
  selectedMarketCache: SelectedMarketCache;
  runtimeControl?: RuntimeControl;
  controlDb?: WalletBudgetControlDb | undefined;
  activeProfile?: ProfileId | undefined;
  walletBufferPct?: number | undefined;
  walletBufferMinUsdc?: number | undefined;
  /**
   * ADR-016 dependency. When provided AND the runtime_control_state policy is
   * `market_wide`, the post-entry continuation gate consults this provider
   * instead of the per-leg `buyCount + sellCount`. `null` returns from the
   * provider degrade transparently to leg-local (logged in suppression facts).
   */
  tradeCountProvider?: MarketTradeCountProvider | undefined;
  /**
   * Step 0 §P3 — DB-backed execution policy snapshot used by the min-age gate.
   * Reads `entryMinMarketAgeSeconds` to suppress first-BUY signals on markets
   * younger than the spec floor (2,504 s). When omitted, the gate is skipped
   * entirely (e.g. tests that don't supply a provider).
   */
  executionPolicy?: (() => ExecutionPolicy) | undefined;
  log: Logger;
  sweepIntervalMs: number;
}

// ─── Module ──────────────────────────────────────────────────────────────────

const PENDING_ENTRY_TIMEOUT_MS = 120_000;
const SELL_ONLY = new Set(["SELL"]);
/**
 * ADR-016: trade-count cap passed to the provider; matches R1 (`>= 6`) so the
 * provider can early-exit and never has to page beyond a single response.
 */
const CONTINUATION_TRADE_COUNT_CAP = 6;
/**
 * Cooperative yield interval inside the per-token evaluation loop. Sweep ticks
 * over 1000+ tokens were holding the event loop for hundreds of ms, delaying
 * AbortSignal timers behind their deadline. Yielding every 50 tokens keeps
 * loop p99 in baseline range without measurably affecting throughput
 * (one setImmediate hop per 50 token evaluations is cheap).
 */
const EVALUATE_YIELD_BATCH = 50;
const NOISY_SUPPRESSION_DEDUPE_MS = 10 * 60 * 1000;
const MAX_SUPPRESSION_DEDUPE_KEYS = 50_000;
const DEDUPED_SUPPRESSION_REASONS = new Set([
  "market-cache-miss",
  "mid-price-unavailable",
  "pending-buy-order",
  "redeem-before-end-date",
  "market-not-live",
  // continuation-stop is sticky: once a leg fails R1 it fails on every sweep
  // tick (≈1/sec) until the leg clears. Without dedupe, a handful of stuck
  // legs floods decision_signal_log with thousands of identical rows per hour
  // and drowns the genuine signal stream operators look at.
  "continuation-stop",
  // Step 0 §P3 min-age gate: both reasons are sticky on the legState==null
  // path — `market_too_young` repeats every sweep tick (≈1/sec) for up to
  // 2 504 s after first sighting; `market_age_unknown` repeats indefinitely
  // for legacy/null gammaCreatedAt rows. Both must dedupe like other sticky
  // suppressions to keep decision_signal_log readable.
  "market_too_young",
  "market_age_unknown",
]);

export class AlgoDecisionModule implements RuntimeModule {
  private readonly log: Logger;

  // Market cache — updated on every NormalizedMarketUpdated
  private readonly marketCache = new Map<string, NormalizedMarket>();

  // ADR-022 §D-F — F-telemetry: previous midPrice per token, captured on each
  // NormalizedMarketUpdated BEFORE the cache is updated. Drives
  // `signal_emitted.payload.dropFromLastSeen`. Cleared on token eviction
  // (TrackedMarketsChanged.removedTokenIds) and on inactive markets so the
  // map stays bounded by the watch-set capacity.
  private readonly prevMidPrices = new Map<string, number>();

  // ADR-022 §D-F — F-telemetry: per-tick decisionRuleId histogram for the
  // healthcheck `triggerMix` segment. `lastTickRuleMix` is the snapshot from
  // the most recently completed evaluation pass, exposed read-only via
  // healthCheck; `currentTickRuleMix` is being filled by the in-flight pass
  // and swapped in at its end. Both reset on module restart.
  private lastTickRuleMix = new Map<string, number>();
  private currentTickRuleMix = new Map<string, number>();

  // Rules — loaded once on start()
  private decisionRules: readonly AlgoDecisionRule[] = [];
  private buySizeRules: readonly AlgoSizeRule[] = [];
  private sellSizeRules: readonly AlgoSizeRule[] = [];

  // Pending entries — prevents re-signalling while a buy order is in-flight
  private readonly pendingEntries = new Map<string, PendingEntry>(); // tokenId → entry
  private readonly clientOrderToToken = new Map<string, string>(); // clientOrderId → tokenId
  private readonly orderIdToToken = new Map<string, string>(); // orderId → tokenId
  private readonly suppressionDedupe = new Map<string, number>();

  private tickCounter = 0;
  private unsubs: Array<() => void> = [];
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private started = false;
  // Skip-on-overlap guard for evaluateTokens. The same pass can be triggered
  // from `setInterval(sweep)` and from `handleMarketUpdate`/`handleNormalizedMarketUpdated`
  // back-to-back within one tick. Without this gate, market_wide prefetch fan-out
  // multiplies (N concurrent passes × prefetchConcurrency) and starves the
  // event loop — exactly the failure mode that auto-rolled back P8 canary #1.
  // Skipping (rather than queuing) is safe: marketCache is updated synchronously
  // by handlers, and the next sweep tick picks up the new state.
  private evaluating = false;

  // ADR-016 — operator policy + last-seen version for hot-reload.
  private continuationMode: ContinuationMode = "leg_local";
  private continuationModeVersion = -1;

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

    this.refreshContinuationMode();
    this.log.info(
      {
        continuationMode: this.continuationMode,
        continuationModeVersion: Math.max(this.continuationModeVersion, 0),
        tradeCountProviderAttached: !!this.deps.tradeCountProvider,
      },
      "algo-decision continuation_mode loaded",
    );

    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) => this.handleMarketUpdate(p)),
      this.deps.bus.subscribe("TrackedMarketsChanged", (p) => this.handleTrackedMarketsChanged(p)),
      this.deps.bus.subscribe("SignalRejected", (p) => this.handleSignalRejected(p)),
      this.deps.bus.subscribe("SignalConversionSkipped", (p) =>
        this.handleSignalConversionSkipped(p),
      ),
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
    const base = `ticks=${this.tickCounter} markets=${this.marketCache.size} pending=${this.pendingEntries.size}`;
    // ADR-018 §D2 — append Step 1 universe funnel when the cache supports it.
    const snap = this.deps.selectedMarketCache.getUniverseFilterSnapshot?.();
    const funnel = snap
      ? ` universeFunnel seen=${snap.seen} volumeZeroDropped=${snap.volumeZeroDropped} volumeNullEvaluated=${snap.volumeNullEvaluated} volumePositiveEvaluated=${snap.volumePositiveEvaluated} selectionRuleAdmitted=${snap.selectionRuleAdmitted} selectionRuleRejected=${snap.selectionRuleRejected}`
      : "";
    // ADR-022 §D-F — last-tick decisionRuleId histogram. Empty when no signals
    // emitted on the most recent completed pass; the segment is omitted in
    // that case to keep the line tidy. Sorted by ruleId for stable output.
    const ruleMix = this.formatTriggerMix(this.lastTickRuleMix);
    return { ok: true, detail: `${base}${funnel}${ruleMix}` };
  }

  private formatTriggerMix(mix: ReadonlyMap<string, number>): string {
    if (mix.size === 0) return "";
    const entries = [...mix.entries()].sort(([a], [b]) => a.localeCompare(b));
    const parts = entries.map(([ruleId, count]) => `${ruleId}=${count}`);
    return ` triggerMix ${parts.join(" ")}`;
  }

  // ─── Event handlers ─────────────────────────────────────────────────────────

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    for (const market of payload.markets) {
      const tokenIdStr = String(market.tokenId);
      if (!market.active) {
        this.marketCache.delete(tokenIdStr);
        this.prevMidPrices.delete(tokenIdStr);
      } else {
        // ADR-022 §D-F — capture the immediately previous midPrice into
        // prevMidPrices BEFORE replacing the cache entry, so the next signal
        // emission can compute `dropFromLastSeen` against the second-latest
        // observation. If the prior update had no midPrice, clear the slot —
        // ADR-022 defines the reference as the IMMEDIATELY previous update,
        // not the last non-null sample, so a null gap resets the delta.
        const prior = this.marketCache.get(tokenIdStr);
        if (prior?.midPrice != null) {
          this.prevMidPrices.set(tokenIdStr, prior.midPrice);
        } else {
          this.prevMidPrices.delete(tokenIdStr);
        }
        this.marketCache.set(tokenIdStr, market);
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
      const tokenIdStr = String(tokenId);
      this.marketCache.delete(tokenIdStr);
      this.prevMidPrices.delete(tokenIdStr);
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

  private async handleSignalRejected(payload: RuntimeEventMap["SignalRejected"]): Promise<void> {
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

  /**
   * ADR-016: hot-reload `continuation_mode` from `runtime_control_state`.
   * Cheap version-poll first; only re-reads the mode column when the version
   * has bumped. Errors and missing columns degrade silently to `leg_local`
   * via `readContinuationMode/Version`'s try/catch.
   *
   * Tests that pass a structural `WalletBudgetControlDb` mock satisfy
   * `readContinuationMode/Version`'s `db.prepare(...).get(...)` shape; the
   * cast is honest since production always wires the real `Database`.
   */
  private refreshContinuationMode(): void {
    if (!this.deps.controlDb) return;
    const db = this.deps.controlDb as unknown as Database.Database;
    const newVersion = readContinuationModeVersion(db);
    if (newVersion === this.continuationModeVersion) return;
    const newMode = readContinuationMode(db);
    const previous = this.continuationMode;
    this.continuationMode = newMode;
    this.continuationModeVersion = newVersion;
    if (previous !== newMode && this.started) {
      this.log.info(
        { previous, current: newMode, version: newVersion },
        "continuation_mode_changed",
      );
    }
  }

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
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      await this.evaluateTokensInner(tokenIds);
    } finally {
      this.evaluating = false;
    }
  }

  private async evaluateTokensInner(tokenIds: readonly TokenId[]): Promise<void> {
    this.refreshContinuationMode();
    this.tickCounter++;
    // ADR-022 §D-F — start a fresh in-flight histogram for this sweep.
    // The completed histogram is promoted into `lastTickRuleMix` at the END
    // of the sweep (see below), so healthcheck always reflects the most
    // recently completed pass rather than the one before it.
    this.currentTickRuleMix = new Map<string, number>();
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

    // ADR-016: in `market_wide` mode, batch-warm the trade-count cache for
    // all tokens that already have a leg (continuation gate is the only
    // consumer). Serial cache-misses inside the per-token loop would stack
    // ~75ms × N latency on the sweep; one parallel prefetch collapses it.
    await this.prefetchContinuationTradeCounts(tokenIds);

    const redeemConditionIds = new Set<string>();
    const signals: Array<{ signal: import("@plankton/domain").Signal; market: NormalizedMarket }> =
      [];

    // Yield to the event loop every EVALUATE_YIELD_BATCH tokens. evaluateToken
    // is mostly synchronous (DB reads + pure rules) and the sweep can hold the
    // loop for hundreds of ms across 1000+ tokens, blocking AbortSignal timers
    // and other I/O callbacks. setImmediate yields after macro-tasks drain.
    let processed = 0;
    for (const tokenId of tokenIds) {
      if (processed > 0 && processed % EVALUATE_YIELD_BATCH === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      processed++;
      const result = await this.evaluateToken(String(tokenId) as TokenId, now, nextSeq);
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
        // Budget passed (or non-buy): persist decision_signal_log /
        // signal_emitted now, BEFORE pushing onto the emit queue. The actual
        // SignalProduced publish happens after the loop; recording here
        // guarantees every queued signal has matching telemetry without
        // booking emissions for signals dropped above.
        result.commitLog();
        signals.push({ signal: result.signal, market: result.market });
      }
    }

    // Emit grouped RedeemRequested — one event per sweep with deduplicated conditionIds
    if (redeemConditionIds.size > 0) {
      await this.deps.bus.publish("RedeemRequested", {
        conditionIds: [...redeemConditionIds],
        timestamp: now,
      });
    }

    for (const { signal, market } of signals) {
      await this.deps.bus.publish("SignalProduced", { signal, market });
    }

    // ADR-022 §D-F — promote the just-completed histogram so healthcheck
    // immediately reflects this sweep, not the previous one.
    this.lastTickRuleMix = this.currentTickRuleMix;
  }

  /**
   * Batch-warm the continuation trade-count cache for tokens with an open leg.
   * Tokens without a leg never reach the continuation gate, so we skip them.
   * `prefetch` is optional on the interface; if absent we fall back to per-token
   * `countTrades` calls inside `evaluateToken` (cache will still help on
   * subsequent ticks within the TTL).
   */
  private async prefetchContinuationTradeCounts(tokenIds: readonly TokenId[]): Promise<void> {
    if (this.continuationMode !== "market_wide") return;
    const provider = this.deps.tradeCountProvider;
    if (!provider) return;

    const conditionIds: ConditionId[] = [];
    const seen = new Set<string>();
    for (const tokenId of tokenIds) {
      const ls = this.deps.legStateRepo.get(tokenId);
      if (!ls) continue;
      const market = this.marketCache.get(String(tokenId));
      if (!market) continue;
      const cid = market.conditionId as ConditionId;
      if (seen.has(cid)) continue;
      seen.add(cid);
      conditionIds.push(cid);
    }
    if (conditionIds.length === 0) return;

    if (provider.prefetch) {
      await provider.prefetch(conditionIds, CONTINUATION_TRADE_COUNT_CAP);
    } else {
      await Promise.all(
        conditionIds.map((id) => provider.countTrades(id, CONTINUATION_TRADE_COUNT_CAP)),
      );
    }
  }

  /**
   * ADR-016: resolve `trade_count` for the continuation gate. In `market_wide`
   * mode, consult the provider; null returns degrade to leg-local under D1.
   * In `leg_local` mode (or when no provider is wired), use the legacy
   * per-leg `buyCount + sellCount`. The chosen source is returned so
   * suppression telemetry can flag fallback paths for the operator.
   */
  private async resolveContinuationTradeCount(
    conditionId: ConditionId,
    legLocalCount: number,
  ): Promise<{ count: number; source: TradeCountSource }> {
    if (this.continuationMode === "leg_local" || !this.deps.tradeCountProvider) {
      return { count: legLocalCount, source: "leg_local" };
    }
    const fetched = await this.deps.tradeCountProvider.countTrades(
      conditionId,
      CONTINUATION_TRADE_COUNT_CAP,
    );
    if (fetched === null) {
      return { count: legLocalCount, source: "leg_local_fallback" };
    }
    return { count: fetched, source: "market_wide" };
  }

  /** Evaluate a single token. Returns a signal, redeem, or null. */
  private async evaluateToken(
    tokenId: TokenId,
    now: number,
    nextSeq: (key: string) => number,
  ): Promise<TokenEvalResult> {
    const legState = this.deps.legStateRepo.get(tokenId);
    const selectedForEntry = this.deps.selectedMarketCache.isEligible(tokenId);

    // Avoid emitting suppression telemetry for the full unselected market
    // universe delivered by NormalizedMarketUpdated; it is selection-layer noise.
    if (!legState && !selectedForEntry) return null;

    const state = deriveState(legState);
    const buyCount = legState?.buyCount ?? 0;
    const emissionFacts: EmissionFacts = {
      firstTradePrice: legState?.firstTradePrice ?? null,
      legTradeCount: (legState?.buyCount ?? 0) + (legState?.sellCount ?? 0),
    };
    const timeSinceLastSeconds = legState
      ? (now - new Date(legState.lastTradeAt).getTime()) / 1000
      : null;

    const market = this.marketCache.get(String(tokenId));
    if (!market) {
      this.recordDecisionSuppressed({
        tokenId,
        conditionId: null,
        reasonCode: "market-cache-miss",
        state,
        price: null,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: new Date(now).toISOString(),
      });
      return null;
    }

    const price = market.midPrice;
    if (price === null || price === undefined) {
      this.recordDecisionSuppressed({
        tokenId,
        conditionId: market.conditionId,
        reasonCode: "mid-price-unavailable",
        state,
        price: null,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: new Date(now).toISOString(),
      });
      return null;
    }

    // ADR-022 §D-F — F-telemetry derived facts. `prevMidPrices` is populated
    // in `handleMarketUpdate` BEFORE the cache is replaced, so at this point
    // it holds the second-latest midPrice for this token (or is empty on the
    // first observation, yielding `dropFromLastSeen=null`). Sign convention:
    // negative = price went down, positive = price went up.
    const prevMid = this.prevMidPrices.get(String(tokenId));
    const dropFromLastSeen = prevMid != null && prevMid > 0 ? (price - prevMid) / prevMid : null;
    const triggerTelemetry: TriggerTelemetry = {
      dropFromLastSeen,
      entryPriceBucket: classifyEntryPriceBucket(price),
    };

    // Skip tokens that already have a pending buy order in-flight
    if (!legState && this.pendingEntries.has(String(tokenId))) {
      this.recordDecisionSuppressed({
        tokenId,
        conditionId: market.conditionId,
        reasonCode: "pending-buy-order",
        side: "BUY",
        state,
        price,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: new Date(now).toISOString(),
      });
      return null;
    }

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

    // Redeem check first — if conditions met, skip signal generation.
    // Pre-gate on endDate: on-chain redeemPositions() reverts before market
    // resolution, and ResolutionModule's downstream filterConfirmedRedeemable
    // defers such cases — but emitting RedeemRequested anyway spams the bus
    // and writes defer-log noise every eval tick. Suppress at the source.
    // Missing endDate → allow through (downstream still gates on Gamma).
    const redeemResult = evaluateRedeem(ctx, this.decisionRules);
    if (redeemResult) {
      const endMs = market.endDate ? new Date(market.endDate).getTime() : NaN;
      if (!Number.isFinite(endMs) || endMs <= now) {
        this.recordDecisionSignal(
          {
            signalId: randomUUID(),
            tokenId,
            conditionId: market.conditionId as ConditionId,
            side: "REDEEM",
            decisionRuleId: redeemResult.ruleId,
            sizingRuleId: null,
            notionalBucket: null,
            state,
            price,
            buyCount,
            timeSinceLastSeconds,
            signalTimestamp: new Date(now).toISOString(),
          },
          {
            firstTradePrice: emissionFacts.firstTradePrice,
            legTradeCount: emissionFacts.legTradeCount,
          },
          triggerTelemetry,
        );
        return { type: "redeem", conditionId: market.conditionId };
      }
      this.recordDecisionSuppressed({
        tokenId,
        conditionId: market.conditionId,
        reasonCode: "redeem-before-end-date",
        side: "REDEEM",
        decisionRuleId: redeemResult.ruleId,
        state,
        price,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: new Date(now).toISOString(),
      });
    }

    // Hard-liveness gate for CLOB signals. REDEEM (above) uses a separate
    // NegRisk contract path and is allowed on unhealthy markets. Any other
    // signal — new-entry BUY, scale-in BUY, exit SELL — must traverse the
    // signal-to-order bridge, which calls this same `isAlive` and rejects
    // regardless of side. Suppress here to eliminate allocation churn from
    // producing signals the bridge will reject anyway. Shared `isAlive` keeps
    // the two gates in lockstep so they can't drift.
    const liveness = isAlive(market);
    if (!liveness.healthy) {
      this.recordDecisionSuppressed({
        tokenId,
        conditionId: market.conditionId,
        reasonCode: "market-not-live",
        reasons: liveness.reasons,
        state,
        price,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: new Date(now).toISOString(),
      });
      return null;
    }

    // Step 0 §P3 — min-age gate. Fires only on the first-BUY branch
    // (`legState == null`). SELL / REDEEM / scale-in continuation must NOT be
    // suppressed for "too young" — by the time those decisions are reachable
    // the market has already been entered and the spec floor is moot.
    // Threshold = 0 ⇒ full bypass (simulation profile + fixture tests).
    if (!legState && this.deps.executionPolicy) {
      const policy = this.deps.executionPolicy();
      const ageResult = evaluateMinMarketAge({
        gammaCreatedAt: market.gammaCreatedAt ?? null,
        thresholdSeconds: policy.entryMinMarketAgeSeconds,
        nowMs: now,
      });
      if (!ageResult.ok) {
        this.recordDecisionSuppressed({
          tokenId,
          conditionId: market.conditionId,
          reasonCode: ageResult.reasonCode,
          side: "BUY",
          state,
          price,
          buyCount,
          timeSinceLastSeconds,
          emissionFacts,
          timestamp: new Date(now).toISOString(),
        });
        return null;
      }
    }

    // Preserved-for-lifecycle gate: market has an open leg but the CLOB no
    // longer accepts new entries (tradable=false). Per spec v2.2 §0 the
    // pre-entry filter is a NEW-BUY gate — preserved markets only emit SELL.
    // Keyed directly on market.tradable, not !isEligible(...), so unrelated
    // eligibility reasons (slug mismatch, etc.) do not force SELL-only.
    const preservedOnly = legState !== null && !market.tradable;

    // Post-entry continuation gate — only applies when we have a leg. It blocks
    // further entry/scale-in decisions, but SELL exits use the same D2/D4/D5/D7
    // rules and must remain reachable for existing inventory.
    if (legState) {
      const { count: tradeCount, source: tradeCountSource } =
        await this.resolveContinuationTradeCount(
          market.conditionId as ConditionId,
          emissionFacts.legTradeCount,
        );
      const continuationFacts: ContinuationFacts = {
        tradeCount,
        tradeCountSource,
        stop: !evaluateContinuation(tradeCount, legState.firstTradePrice),
      };
      if (continuationFacts.stop) {
        const sellMatch = matchRule(ctx, this.decisionRules, SELL_ONLY);
        if (sellMatch) {
          return this.buildSignal(
            market,
            sellMatch,
            ctx,
            buyCount,
            now,
            nextSeq,
            {
              ...emissionFacts,
              continuationStop: true,
              continuationTradeCount: continuationFacts.tradeCount,
              continuationTradeCountSource: continuationFacts.tradeCountSource,
            },
            triggerTelemetry,
          );
        }
        this.recordDecisionSuppressed({
          tokenId,
          conditionId: market.conditionId,
          reasonCode: "continuation-stop",
          state,
          price,
          buyCount,
          timeSinceLastSeconds,
          emissionFacts,
          timestamp: new Date(now).toISOString(),
          tradeCount: continuationFacts.tradeCount,
          tradeCountSource: continuationFacts.tradeCountSource,
        });
        return null;
      }
      if (preservedOnly) {
        // preserved-only: market de-listed for new entries, exit-only via SELL
        const sellMatch = matchRule(ctx, this.decisionRules, SELL_ONLY);
        if (!sellMatch) {
          this.recordDecisionSuppressed({
            tokenId,
            conditionId: market.conditionId,
            reasonCode: "preserved-only-no-sell-rule",
            side: "SELL",
            state,
            price,
            buyCount,
            timeSinceLastSeconds,
            emissionFacts,
            timestamp: new Date(now).toISOString(),
            tradeCount: continuationFacts.tradeCount,
            tradeCountSource: continuationFacts.tradeCountSource,
          });
          return null;
        }
        return this.buildSignal(
          market,
          sellMatch,
          ctx,
          buyCount,
          now,
          nextSeq,
          emissionFacts,
          triggerTelemetry,
        );
      }
    }

    // Decide action + size
    const decision = evaluateDecision(ctx, this.decisionRules);
    return this.buildSignal(
      market,
      decision,
      ctx,
      buyCount,
      now,
      nextSeq,
      emissionFacts,
      triggerTelemetry,
    );
  }

  private buildSignal(
    market: NormalizedMarket,
    decision: { action: string; ruleId: string },
    ctx: EvalContext,
    buyCount: number,
    now: number,
    nextSeq: (key: string) => number,
    emissionFacts: EmissionFacts,
    triggerTelemetry: TriggerTelemetry,
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
      sizingRuleId: sizeResult.ruleId,
      generatedAt: new Date(now).toISOString(),
    };

    // Defer telemetry until the wallet-budget filter in `evaluateTokensInner`
    // has decided to keep this signal. Recording at construction time
    // overcounts decision_signal_log/signal_emitted by every tail-end signal
    // that gets silently dropped for lack of BUY headroom, breaking the
    // emitted-vs-suppressed accounting operators rely on.
    const commitLog = (): void => {
      this.recordDecisionSignal(
        {
          signalId: signal.signalId,
          tokenId: signal.tokenId,
          conditionId: signal.conditionId,
          side: side === "buy" ? "BUY" : "SELL",
          decisionRuleId: signal.decisionRuleId,
          sizingRuleId: signal.sizingRuleId,
          notionalBucket: classifyNotionalBucket(signal.suggestedSizeUsdc),
          state: ctx.state,
          price: ctx.price,
          buyCount,
          timeSinceLastSeconds: ctx.timeSinceLastSeconds,
          signalTimestamp: signal.generatedAt,
        },
        emissionFacts,
        triggerTelemetry,
      );
    };

    return { type: "signal", signal, market, commitLog };
  }

  private recordDecisionSignal(
    signal: DecisionSignalLog,
    emissionFacts: EmissionFacts,
    triggerTelemetry: TriggerTelemetry,
  ): void {
    // ADR-022 §D-F — record this decisionRuleId in the per-tick histogram
    // BEFORE the repo writes so the healthcheck reflects the signal even if
    // persistence fails. Aggregation is in-memory only; failures here are
    // not user-visible. `decisionRuleId === null` is technically possible
    // per the DecisionSignalLog type — bucket those under the literal
    // "(null)" so they remain countable rather than silently dropped.
    const ruleKey = signal.decisionRuleId ?? "(null)";
    this.currentTickRuleMix.set(ruleKey, (this.currentTickRuleMix.get(ruleKey) ?? 0) + 1);

    try {
      this.deps.decisionSignalLogRepo?.insert(signal);
    } catch (err) {
      this.log.warn(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId), side: signal.side },
        "failed to persist decision signal telemetry",
      );
    }
    try {
      this.deps.riskEventRepo?.insert({
        eventType: "signal_emitted",
        payload: {
          signalId: signal.signalId,
          tokenId: String(signal.tokenId),
          conditionId: String(signal.conditionId),
          side: signal.side,
          decisionRuleId: signal.decisionRuleId,
          state: signal.state,
          price: signal.price,
          buyCount: signal.buyCount,
          timeSinceLastSeconds: signal.timeSinceLastSeconds,
          firstTradePrice: emissionFacts.firstTradePrice,
          legTradeCount: emissionFacts.legTradeCount,
          continuationStop: emissionFacts.continuationStop ?? null,
          tradeCount: emissionFacts.continuationTradeCount ?? null,
          tradeCountSource: emissionFacts.continuationTradeCountSource ?? null,
          continuationMode: this.continuationMode,
          // ADR-022 §D-F — F-telemetry fields surfaced for post-hoc R23/R24
          // distribution comparison.
          dropFromLastSeen: triggerTelemetry.dropFromLastSeen,
          entryPriceBucket: triggerTelemetry.entryPriceBucket,
          signalTimestamp: signal.signalTimestamp,
        },
      });
    } catch (err) {
      this.log.warn(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId), side: signal.side },
        "failed to persist signal_emitted risk event",
      );
    }
  }

  private recordDecisionSuppressed(facts: SuppressionFacts): void {
    if (!this.shouldPersistSuppressionEvent(facts)) return;

    try {
      this.deps.riskEventRepo?.insert({
        eventType: "signal_suppressed",
        payload: {
          tokenId: String(facts.tokenId),
          conditionId: facts.conditionId,
          reasonCode: facts.reasonCode,
          reasons: facts.reasons ?? null,
          side: facts.side ?? null,
          decisionRuleId: facts.decisionRuleId ?? null,
          state: facts.state,
          price: facts.price,
          buyCount: facts.buyCount,
          timeSinceLastSeconds: facts.timeSinceLastSeconds,
          firstTradePrice: facts.emissionFacts.firstTradePrice,
          legTradeCount: facts.emissionFacts.legTradeCount,
          tradeCount: facts.tradeCount ?? null,
          tradeCountSource: facts.tradeCountSource ?? null,
          continuationMode: this.continuationMode,
          signalTimestamp: facts.timestamp,
        },
      });
    } catch (err) {
      this.log.warn(
        { err, tokenId: String(facts.tokenId), reasonCode: facts.reasonCode },
        "failed to persist signal_suppressed risk event",
      );
    }
  }

  private shouldPersistSuppressionEvent(facts: SuppressionFacts): boolean {
    if (!DEDUPED_SUPPRESSION_REASONS.has(facts.reasonCode)) return true;

    const eventAt = Date.parse(facts.timestamp);
    const now = Number.isFinite(eventAt) ? eventAt : Date.now();
    const key = [
      facts.reasonCode,
      String(facts.tokenId),
      facts.conditionId ?? "",
      facts.side ?? "",
      this.continuationMode,
    ].join("|");
    const lastAt = this.suppressionDedupe.get(key);
    if (lastAt != null && now - lastAt < NOISY_SUPPRESSION_DEDUPE_MS) return false;

    this.suppressionDedupe.set(key, now);
    if (this.suppressionDedupe.size > MAX_SUPPRESSION_DEDUPE_KEYS) {
      this.pruneSuppressionDedupe(now);
    }
    return true;
  }

  private pruneSuppressionDedupe(now: number): void {
    for (const [key, lastAt] of this.suppressionDedupe) {
      if (now - lastAt >= NOISY_SUPPRESSION_DEDUPE_MS) {
        this.suppressionDedupe.delete(key);
      }
    }
    while (this.suppressionDedupe.size > MAX_SUPPRESSION_DEDUPE_KEYS) {
      const oldestKey = this.suppressionDedupe.keys().next().value;
      if (oldestKey === undefined) break;
      this.suppressionDedupe.delete(oldestKey);
    }
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
