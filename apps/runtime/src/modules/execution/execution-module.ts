/**
 * Execution Module — the sole exchange-facing order actor.
 *
 * Responsibilities:
 *  - Subscribe to PlaceOrderRequested / CancelOrderRequested events
 *  - Dedup by commandId (idempotency) and clientOrderId (semantic dedup)
 *  - Call ExchangeGateway.placeOrder / cancelOrder
 *  - Persist Order and Fill rows via repositories
 *  - Publish OrderPlaced / OrderRejected / OrderCancelled / FillReceived events
 *
 * Does NOT contain strategy, risk, or reconciliation logic.
 */

import type {
  RuntimeModule,
  EventBus,
  ExchangeGateway,
  MarketRepository,
  OrderRepository,
  FillRepository,
  Order,
  PlaceOrderCommand,
  PlaceOrderParams,
  CancelOrderCommand,
  CancelOrderReason,
  OrderId,
  BotRunId,
  RuntimeControl,
  ProfileId,
  TokenId,
  Position,
  PositionRepository,
  InventoryLotRepository,
  ExchangeFill,
  ExchangeOrder,
  PreparedOrder,
  PreparedOrderSubmitResult,
  ExecutionPolicy,
  LegStateRepository,
  RepriceChainPolicyConfig,
  RiskEventRepository,
  NormalizedMarket,
  RuntimeEventMap,
  ExitLossFloorVerdict,
  MakerMicroLiveWindow,
  MakerCaptureRepriceIntent,
  MakerCaptureChainUsage,
  MakerCaptureRepriceProofV1,
  MakerCaptureSubmitProofV1,
} from "@krabs/domain";
import {
  createCommandId,
  createOrderId,
  createTokenId,
  DEFAULT_EXECUTION_POLICY,
  ExchangeErrorCode,
  isPositionDust,
  isSellTimeoutReplacement,
  normalizeSellSizeForMinOrder,
  resolveDynamicChainCapDetails,
  shouldBlockRepriceChain,
  GATE_ENTRY_RULE_ID,
  BOUNCE_EXIT_TARGET_RULE_ID,
  isBounceForceExit,
  evaluateExitLossFloor,
  computePolymarketPlatformFeeRate,
  POLYMARKET_CRYPTO_TAKER_FEE_RATE,
  isMakerMicroLiveOrderAuthorized,
  isMakerMicroLiveWindowActive,
  parseMakerCaptureRepriceProofV1,
} from "@krabs/domain";
import { classifyExchangeRejectionReason, getExchangeRejectionPayloadText } from "@krabs/exchange";
import { createHash, randomUUID } from "node:crypto";
import { buildClientOrderId } from "@krabs/domain/node";
import { importExchangeFills } from "../reconciliation/fill-reconciler.js";
import {
  applyOrderVerdict,
  registerCancelIntent,
} from "../reconciliation/order-status-resolver.js";
import { buildCancelTelemetry } from "../reconciliation/cancel-telemetry.js";
import { isBounceOwned } from "../exit-ownership/is-bounce-owned.js";
import type { Logger } from "../../logger.js";
import type { LifecycleToken } from "../../lifecycle-chain.js";
import { LifecycleChain, LIFECYCLE_STOP_WAIT_MS } from "../../lifecycle-chain.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import { calculateTotalExposure, countActiveOpenMarkets } from "../../exposure-calculator.js";
import { resnapPriceToTick, validateExecutablePrice } from "../../executable-price.js";
import {
  evaluateWalletBuyCapacity,
  resolveEntriesBlocked,
  evaluatePerTokenOrderCapacity,
  evaluateTotalOrdersCapacity,
  evaluateWalletSellCapacity,
  classifySellCapacitySource,
  hasWalletBuyBudget,
  normalizeBuyCapacityPolicy,
  normalizeOrderCapacityPolicy,
  normalizeSellCapacityPolicy,
  PER_TOKEN_BUY_LIMIT_REASON,
  PER_TOKEN_SELL_LIMIT_REASON,
  resolveEffectiveMaxOpenSellOrdersPerToken,
  TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON,
  type OrderCapacityMetricsSample,
  type WalletSellCapacityDecision,
  resolveWalletBuyBudget,
  resolveProtectedWalletBuyRequirement,
  WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
  WALLET_SELL_CAPACITY_EXHAUSTED_REASON,
} from "../../wallet-buy-budget.js";
import {
  DEFAULT_FALLBACK_MIN_ORDER_SIZE,
  MIN_ORDER_SIZE_HYDRATION_RETRY_MS,
  evaluateSellPreSubmitGuard,
  isExecutableOrderSize,
} from "../../min-order-size.js";
import {
  SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
  SELL_RESIDUAL_UNKNOWN_MIN_ORDER_SIZE_REASON,
} from "../../internal-order-reasons.js";
import {
  BUY_CAP_FULL_TARGETED_REPLACEMENT_REASON,
  BUY_DUPLICATE_DEDUPED_REASON,
  findDuplicateOpenBuyPair,
  findNearDuplicateOpenBuy,
  findOldestStaleOpenBuy,
  MAX_OPEN_GATE_BUYS,
  resolveMakerMicroLiveFillDeadlineMs,
} from "../../buy-order-lifecycle.js";
import { ExecutionQueue, drainGenerations } from "./execution-queue.js";
import { AuthoritativeTickResolver } from "./authoritative-tick-resolver.js";
import {
  buildReservationSnapshot,
  computeMakerOpenOrderUsdc,
  computeMakerOpenPositionUsdc,
  computeMakerPendingReservationUsdc,
  getOpenOrderCountForToken,
  getReservedSellSize,
  canonicalRecoveryMetadata,
  isExitRecoveryFencedPredecessor,
  isRecoveryChildLocalIdentity,
  parseExitRecoveryFenceV1,
  parseStartupExitRecoveryBlockV1,
  type ExitRecoveryFenceV1,
  type PendingReservation,
  type ReservationSnapshot,
} from "./reservation-utils.js";
import {
  computeSellUpperBound,
  ExchangeStateStore,
  isExchangeBalanceRejection,
} from "./exchange-state-store.js";
import {
  orderMatchesOrderId,
  validateProfileLadderReplacementSellTarget,
} from "../profile-ladder-order-helpers.js";
import type { PositionConcentrationService } from "../../position-concentration-service.js";
import type { MakerBuyFastCancel } from "./maker-buy-fast-cancel.js";
import type { MakerCaptureBookCache } from "../../maker-capture-reprice.js";
import {
  buildMakerCaptureBookDecisionProof,
  computeMakerCaptureCandidate,
  matchesMakerCaptureIntent,
  parseMakerCaptureLineage,
  parseMakerCaptureRepriceSignal,
  primeFreshMakerCaptureBook,
  rootMakerCaptureLineage,
} from "../../maker-capture-reprice.js";
import { parseQuoteMotionOrigin, type QuoteMotionOriginV1 } from "../../quote-motion-shadow.js";

/**
 * How long `stop()` waits for commands already dispatched to finish, on either path — the queue's
 * own drain and the queue-less one. One value because it answers one question (how long a shutdown
 * may wait on the gateway), and two would drift.
 */
const EXECUTION_SHUTDOWN_TIMEOUT_MS = 10_000;

type OrderFillLookupGateway = ExchangeGateway & {
  getFillsForOrder?: (orderId: string) => Promise<ExchangeFill[]>;
};

type PreparedLiveGateway = ExchangeGateway & {
  prepareOrder?: (params: PlaceOrderParams) => Promise<PreparedOrder>;
  submitPreparedOrder?: (prepared: PreparedOrder) => Promise<PreparedOrderSubmitResult>;
};

type PostOnlyCrossPreSubmitSkip = {
  bestBid: number;
  bestAsk: number | null;
  bookSource: string | null;
  snapshotTs: number | null;
};

type ExitRecoverySnapshot = {
  readonly openOrders: readonly ExchangeOrder[];
  readonly fills: readonly ExchangeFill[];
  readonly exactPredecessor: ExchangeOrder | null;
  readonly openHash: string;
  readonly fillHash: string;
  readonly fillWatermark: string;
};

export type MissingBounceExitRecoveryResult =
  | { readonly status: "applied"; readonly completedAt: string }
  | { readonly status: "deferred" }
  | { readonly status: "rejected" };

class UnsafeRecoveryChildError extends Error {}

interface MakerCaptureExecutionContext {
  readonly intent: MakerCaptureRepriceIntent;
  readonly predecessor: Order;
  readonly root: Order;
  readonly usage: MakerCaptureChainUsage;
  readonly origin: QuoteMotionOriginV1;
  readonly proof: MakerCaptureRepriceProofV1;
  readonly policySchemaVersion: number;
  readonly policyControlRevision: number;
  readonly activatedAtUtc: string;
  readonly expiresAtUtc: string;
}

type MakerCaptureFinalBookResult =
  | { readonly ok: true; readonly proof: MakerCaptureSubmitProofV1 }
  | { readonly ok: false; readonly reason: string; readonly code: ExchangeErrorCode };

function resolvePriceFromCmd(cmd: PlaceOrderCommand): number {
  return cmd.price;
}

function boundedMetricLabel(value: string | null | undefined): string {
  if (value == null || value.trim().length === 0) return "unknown";
  return value.length <= 64 ? value : "other";
}

function recoverySnapshotHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashOpenOrders(orders: readonly ExchangeOrder[]): string {
  return recoverySnapshotHash(
    [...orders]
      .sort((a, b) => a.orderId.localeCompare(b.orderId))
      .map((order) => [
        order.orderId,
        String(order.tokenId),
        order.side,
        order.price,
        order.sizeTotal,
        order.sizeFilled,
        order.sizeRemaining,
        order.status,
      ]),
  );
}

function hashFills(fills: readonly ExchangeFill[]): string {
  return recoverySnapshotHash(
    [...fills]
      .sort((a, b) => a.fillId.localeCompare(b.fillId))
      .map((fill) => [
        fill.fillId,
        fill.orderId,
        String(fill.tokenId),
        fill.side,
        fill.price,
        fill.size,
        fill.timestamp,
      ]),
  );
}

function fillWatermark(fills: readonly ExchangeFill[]): string {
  const latest = [...fills].sort(
    (a, b) => b.timestamp - a.timestamp || b.fillId.localeCompare(a.fillId),
  )[0];
  return latest ? `${latest.timestamp}:${latest.fillId}:${fills.length}` : `0:none:${fills.length}`;
}

// No "pending-cancel" status exists on OrderStatus (packages/domain/src/enums.ts) —
// terminal means the order can never be cancelled again.
function isTerminalOrderStatus(status: Order["status"]): boolean {
  return status === "cancelled" || status === "filled" || status === "rejected";
}

// Finding 5: autonomous transition-reconcile cadence + the minimum interval between
// cancel-retries for a single stuck drain target (backoff — no cancel storms).
const AUTONOMOUS_RECONCILE_INTERVAL_MS = 5_000;
const TRANSITION_CANCEL_RETRY_BACKOFF_MS = 5_000;
// Finding 3 / round 5: cap on ACTIVE placement attempts. Beyond it the intent is not
// dropped — it escalates (retained + reconciling + alerted). Bounds active placement only.
const MAX_DEFERRED_BACKSTOP_RETRIES = 6;
// Finding 1 / round 5: minimum interval between deferred-backstop submits for a token, so
// the open-orders reconcile reliably reflects a prior (possibly UNKNOWN-landed) submit
// before another full-residual taker is sent. Comfortably above the reconcile cadence.
const DEFERRED_BACKSTOP_PLACE_GRACE_MS = 15_000;

let liveSubmissionLane: Promise<void> = Promise.resolve();
let liveSubmissionLatched = false;

async function withinLiveSubmissionLane<T>(operation: () => Promise<T>): Promise<T> {
  const preceding = liveSubmissionLane;
  let release!: () => void;
  liveSubmissionLane = new Promise<void>((resolve) => {
    release = resolve;
  });
  await preceding;
  try {
    return await operation();
  } finally {
    release();
  }
}

function resolveSellRepriceThreshold(
  lastPlacedAnchor: number,
  tickSize: number,
  policy: ExecutionPolicy | undefined,
): { thresholdAbs: number } | null {
  if (
    !Number.isFinite(lastPlacedAnchor) ||
    !Number.isFinite(tickSize) ||
    lastPlacedAnchor <= 0 ||
    tickSize <= 0
  ) {
    return null;
  }
  const thresholdPct = policy?.exitRepriceThresholdPct ?? 0.3;
  const thresholdTicks = policy?.exitRepriceThresholdTicks ?? 10;
  if (
    !Number.isFinite(thresholdPct) ||
    !Number.isFinite(thresholdTicks) ||
    thresholdPct <= 0 ||
    thresholdTicks <= 0
  ) {
    return null;
  }
  return {
    thresholdAbs: Math.min(lastPlacedAnchor * thresholdPct, tickSize * thresholdTicks),
  };
}

/** CLOB-V2 builder-fee protocol maxima (fraction of notional). Additive to the
 *  platform fee; the exit loss-floor fee estimate uses these upper bounds because
 *  the live builder rate is mutable outside this code (currently 0 in prod). */
const EXIT_LOSS_FLOOR_BUILDER_MAKER_FEE_MAX = 0.005;
const EXIT_LOSS_FLOOR_BUILDER_TAKER_FEE_MAX = 0.01;

/** Checkpoint that observed an exit loss-floor STOP (telemetry/risk-event label). */
type ExitLossFloorPhase =
  | "pre-cancel-screen"
  | "authoritative"
  | "invalid-tick-retry"
  | "position-updated-reeval"
  | "startup-scan";

export interface ExecutionModuleDeps {
  gateway: ExchangeGateway;
  bus: EventBus;
  marketRepo: MarketRepository;
  orderRepo: OrderRepository & {
    findStartupExitRecoveryBlocked?(): Order[];
  };
  fillRepo: FillRepository;
  positionRepo?: PositionRepository | undefined;
  /**
   * FIFO cost-basis lots for the exit-loss-floor gate (docs/plans/2026-07-20-
   * exit-loss-floor.md §Phase 3/4). Optional so legacy unit tests don't need
   * a mechanical wiring sweep — absent repo/position/lots is treated as
   * missing input and the evaluator fails CLOSED (blocks the sell), it is
   * never used to skip the gate.
   */
  inventoryLotRepo?: InventoryLotRepository | undefined;
  log: Logger;
  botRunId: BotRunId;
  runtimeControl?: RuntimeControl | undefined;
  /** Persists a fail-closed live pause after an exact-hash mismatch. */
  pauseLiveTrading?: (() => void) | undefined;
  liveLiteGuard?: LiveLiteGuard | undefined;
  runtimeMode?: "simulation" | "paper" | "live-lite" | undefined;
  /**
   * Fetches the CLOB `/books` entry for a token so its `min_order_size` becomes
   * known. Required here because `signal-to-order` — the other hydration
   * trigger — only sees orders that came through the signal bridge. An S1 ladder
   * exit publishes `PlaceOrderRequested` directly, and the planner suppresses
   * algo SELLs for S1-owned tokens, so on that route NOTHING else ever fetches a
   * book: a live-lite exit with an unknown minimum would be rejected here every
   * single attempt with no path to learning the value. Left unset when the
   * gateway cannot fetch books, which keeps the behaviour exactly as before.
   */
  requestMinOrderSizeHydration?: ((tokenId: string) => void) | undefined;
  maxConcurrency?: number | undefined;
  controlDb?: {
    prepare(sql: string): { get(...args: unknown[]): unknown };
  };
  activeProfile?: ProfileId | undefined;
  /** Relative fill-completion tolerance forwarded to importExchangeFills (#36). */
  fillCompletionTolerance?: number | undefined;
  walletBufferPct?: number | undefined;
  walletBufferMinUsdc?: number | undefined;
  executionPolicy?: (() => ExecutionPolicy) | undefined;
  executionPolicySnapshot?:
    | (() => { policy: ExecutionPolicy; controlRevision: number | null })
    | undefined;
  candidateBookCache?: MakerCaptureBookCache | undefined;
  allowSellSizeClamp?: boolean | undefined;
  capacityMetricsSink?: ((sample: OrderCapacityMetricsSample) => void) | undefined;
  profileOwnedOpenPositionCount?: (() => number) | undefined;
  /**
   * Live per-token public trade activity (trailing 3h) used for the first-entry adaptive entry TTL
   * (GATE and R23/FALLBACK/D-rule alike). Structural subset of the book-signals provider's
   * `getTradeStats3h`. Absent in unit tests / when book-signals is off → first-entry falls back to
   * the 12h TTL cap (never shorter than today).
   */
  tradeStatsReader?:
    | { getTradeStats3h(tokenId: TokenId): { publicTradeCount3h: number } | null }
    | undefined;
  /**
   * Shared store of exchange-side SELL state (open orders + wallet balance)
   * updated by the reconciliation module. When provided, the SELL clamp
   * branch additionally caps `availableSize` against the wallet snapshot and
   * the reservedSell sum honours exchange-side orders that survived a restart.
   */
  exchangeStateStore?: ExchangeStateStore | undefined;
  /**
   * CHANGE A — block new SELLs for `balanceRejectBlockMs` after the exchange
   * returns "balance is not enough / allowance" on placement. Default true.
   */
  sellBalanceRejectBlockEnabled?: boolean | undefined;
  /**
   * CHANGE C — when true, reservedSell = max(localOpenSellSum, exchangeOpenSellSum).
   * Default true; reverts to local-only sum when false.
   */
  sellExchangeReservedEnabled?: boolean | undefined;
  /**
   * Optional metrics sink for per-event counters (balance-reject hits,
   * pending-wallet-sync rejects). Reuses the RuntimeMetricWriter shape.
   */
  runtimeMetrics?:
    | {
        writeEvent: (
          metricName: string,
          value?: number,
          labels?: string | null,
          capturedAt?: string,
        ) => void;
        writeCounter?: (metricName: string, value?: number, labels?: string | null) => void;
      }
    | undefined;
  /**
   * Trigger a fresh reconciliation pass when an exchange balance reject is
   * observed. Wired from the reconciliation module; absent in unit tests.
   */
  reconciliationTrigger?: (() => void) | undefined;
  /**
   * CHANGE C — leg-state repo + reprice-chain policy. Gates the
   * `sell_replace_reprice` cancel branch so a runaway SELL-replace loop
   * cannot exceed the R65 p90 = 13 events / 24h ceiling. Skipped when
   * either field is omitted (legacy unit tests).
   */
  legStateRepo?: LegStateRepository | undefined;
  repriceChainPolicy?: (() => RepriceChainPolicyConfig) | undefined;
  riskEventRepo?: RiskEventRepository | undefined;
  positionConcentration?: Pick<PositionConcentrationService, "evaluateBuy"> | undefined;
  /**
   * Lazy resolver that fetches the authoritative CLOB minimum_tick_size at the
   * order boundary (Phase 1 of the tick-size rejection fix). Optional — when
   * absent the existing cmd.tickSize is used unchanged (legacy / test default).
   */
  tickResolver?: AuthoritativeTickResolver | undefined;
  makerBuyFastCancel?: MakerBuyFastCancel | undefined;
}

export class ExecutionModule implements RuntimeModule {
  private static readonly SELL_REPLACE_LOCK_TIMEOUT_MS = 2 * 60 * 1000;
  private static readonly SIZE_EPSILON_SHARES = 1e-9;
  private static readonly PRICE_EPSILON = 1e-9;
  private static readonly SELL_REPLACEMENT_CANCELLED_ORDER_ID = "sellReplacementCancelledOrderId";

  private readonly log: Logger;
  private readonly processedCommandIds = new Set<string>();
  private readonly processedCommandOrder: string[] = [];
  private readonly makerCaptureGatewayAttempts = new Set<string>();
  private readonly pendingReservations = new Map<string, PendingReservation>();
  /**
   * Command ids whose idempotency mark must be dropped once `executeCommand`'s
   * `finally` has undone every other piece of this attempt's accounting — see
   * {@link releaseProcessedCommandId}. Bounded by construction: an entry is
   * added inside `executePlace` and consumed by that same command's `finally`.
   */
  private readonly commandIdsPendingRelease = new Set<string>();
  private readonly sellReplaceLocks = new Map<
    string,
    { orderId: OrderId; command: PlaceOrderCommand; createdAt: number }
  >();
  private readonly gatewayRejects: Array<{ ts: number; code: string }> = [];
  private readonly internalReservationRejects: Array<{ ts: number; reason: string }> = [];
  /**
   * In-flight cancel dedup (docs/plans/2026-07-20-exit-loss-floor.md §Phase 6,
   * finding #5): reserved just before the gateway cancel call, cleared on
   * cancel FAILURE (so a later retry — e.g. the next PositionUpdated
   * re-evaluation — can try again), retained through successful terminal
   * persistence (from that point on `isTerminalOrderStatus` alone guards
   * against duplicates). Prevents two concurrent CancelOrderCommands for the
   * same orderId (e.g. a PositionUpdated re-eval racing the profile ladder,
   * which also rebuilds on PositionUpdated) from both reaching the gateway.
   */
  private readonly cancelReservations = new Set<string>();
  /**
   * Release A Phase 3 (P6) — executor-owned per-token transition barrier.
   * Presence of a tokenId key = "draining": the token has one or more working
   * orders being cancelled because they belong to a stale/closed/legacy cycle,
   * and no new PlaceOrderCommand for that token may be admitted until every
   * target is exchange-confirmed terminal (cancelled or filled). Absence =
   * "quiescent" — today's ungated behavior. `activePositionId` is descriptive
   * (audit/telemetry) only; it is not consulted to carve out an exception.
   */
  private readonly tokenTransitions = new Map<
    string /* tokenId */,
    { activePositionId: string | null; targets: Set<string /* orderId */> }
  >();
  /**
   * Per-token count of commands accepted for dispatch (queued or executing)
   * but not yet finished. `ExecutionQueue` (execution-queue.ts) only exposes a
   * GLOBAL pending count, so the transition barrier tracks its own per-token
   * view to know a queued/in-flight command still exists for a token before
   * declaring it quiescent (closing the barrier while a stale command is still
   * mid-flight would let it race a freshly-admitted command for the same token).
   */
  private readonly tokenInFlightCount = new Map<string, number>();
  /**
   * Release A Phase 3 (P7 rework, finding 2) — durable deferred bounce-backstop
   * intent. Set when a backstop is refused because its cycle's rungs are still
   * draining (admission OR submit boundary); consumed exactly once, when the
   * token's transition barrier closes (`maybeCloseTokenTransition`), by
   * `placeDeferredBackstop`. Survives across ticks / planner re-emission gaps —
   * the ONLY thing that fires the deferred placement is the barrier itself
   * reaching quiescent, never a timer or a re-delivered signal.
   */
  private readonly pendingBackstops = new Map<
    string /* tokenId */,
    { positionId: string | null; command: PlaceOrderCommand }
  >();
  /**
   * Release A Phase 3 (P7 rework, finding 3) — bounce rungs (BOUNCE_EXIT_TARGET
   * SELLs) accepted for dispatch but not yet reflected as an Order row. Recorded
   * right before `dispatchCommand` (handlePlace) and cleared once `executeCommand`
   * finishes (whether the rung ends up placed, rejected, or skipped) — closes the
   * "queued/executing but not yet persisted" gap that a persisted-orders-only
   * check (`findCycleBounceRungs`) cannot see, so a backstop reaching submit at
   * that exact moment is not fooled into thinking the cycle has no resting rung.
   */
  private readonly inFlightBounceRungs = new Map<
    string /* commandId */,
    { tokenId: string; positionId: string }
  >();
  private sellSizeClamps = 0;
  private readonly queue: ExecutionQueue | null;
  private readonly acceptedCommandAt = new Map<string, number>();
  private readonly marketCache = new Map<string, NormalizedMarket>();
  /** tokenId -> last `/books` hydration request, for the retry-window throttle. */
  private readonly minOrderSizeHydrationRequestedAt = new Map<string, number>();
  private placeCompleted = 0;
  private cancelCompleted = 0;
  private placeLatencyTotalMs = 0;
  private cancelLatencyTotalMs = 0;
  private unsubs: Array<() => void> = [];
  private started = false;
  /**
   * Every lifecycle transition runs through here, in call order, one at a time. Joining "the
   * teardown currently running" is not enough: a `start()` that yields mid-body would otherwise
   * resume AFTER a later `stop()` finished and re-subscribe on top of a completed teardown,
   * leaving a module the supervisor believes is down while its queue accepts commands.
   */
  private readonly lifecycle = new LifecycleChain(() =>
    this.log.error("lifecycle transition superseded by a later one — dropped"),
  );
  // Finding 6: a hard startup fence — set BEFORE supervisor.start() and cleared only
  // AFTER seedStartupTransitions, so every placement is refused during the window in
  // which the command-poller may resume but the barrier isn't seeded yet (independent
  // of pause state, which the poller can flip during start()).
  private startupFenceActive = false;
  // Finding 5: autonomous barrier reconciliation so a stuck drain (failed/lost cancel
  // with a deferred backstop waiting on it) can never deadlock waiting for a placement.
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  // Finding 5: per-target last cancel-retry timestamp — bounds the retry cadence so a
  // stuck token cannot cancel-storm.
  private readonly transitionCancelRetryAt = new Map<string, number>();
  // Finding 1 (round 3): a per-token guard so the barrier-close fire and the autonomous
  // timer can never place two deferred backstops for the same token concurrently.
  private readonly inFlightDeferredBackstop = new Set<string>();
  // Finding 3 / round 5: count of ACTIVE placement attempts per token. Bounds active
  // placement (no storm); when the cap is reached the intent is NOT dropped — it is
  // ESCALATED (retained, keeps reconciling for completion + alerts once).
  private readonly deferredBackstopRetries = new Map<string, number>();
  // Finding 1 / round 5-6: timestamp of the last deferred-backstop EXCHANGE SUBMIT per
  // token (set at the actual gateway boundary, not at publish). A GRACE window before the
  // next submit lets the eventually-consistent open-orders view reflect the prior submit,
  // closing the snapshot→submit double-place race (the live gateway does not echo
  // clientOrderId, so the exchange offers no dedup fallback).
  private readonly lastDeferredPlaceAt = new Map<string, number>();
  // Finding 1/2 / round 6: a deferred-backstop command that has been published but whose
  // outcome is not yet known — while one is in flight for a token we NEVER publish another
  // (closes the publish→submit double window a bare timestamp grace can't). Maps
  // tokenId → the in-flight commandId.
  private readonly pendingDeferredSubmit = new Map<string, string>();
  private readonly activeExitRecoveryClientIds = new Set<string>();
  private readonly recoveryPendingReplacements = new Map<string, Order>();
  private readonly recoverySubmissionAttempts = new Set<string>();
  private readonly exitRecoveriesInFlight = new Set<string>();

  /**
   * In-flight commands on the queue-less path (`maxConcurrency` unset), settled-successfully so
   * they can be awaited together. The queue tracks its own; this set is the only handle `stop()`
   * has when there is no queue.
   */
  private readonly directInFlight = new Set<Promise<void>>();

  constructor(private readonly deps: ExecutionModuleDeps) {
    this.log = deps.log.child({ module: "execution" });
    this.queue = deps.maxConcurrency
      ? new ExecutionQueue({
          maxConcurrency: deps.maxConcurrency,
          shutdownTimeoutMs: EXECUTION_SHUTDOWN_TIMEOUT_MS,
          execute: (cmd) => this.executeCommand(cmd),
          resolveTokenId: (cmd) => this.resolveCommandTokenId(cmd),
          log: this.log,
        })
      : null;
  }

  /** Shared by the queue's per-token mutex and the transition barrier's in-flight counter. */
  private resolveCommandTokenId(cmd: PlaceOrderCommand | CancelOrderCommand): TokenId {
    if (cmd.type === "PlaceOrderCommand") return cmd.tokenId;
    const order = this.deps.orderRepo.findById(cmd.orderId);
    return order?.tokenId ?? (cmd.orderId as unknown as TokenId);
  }

  start(): Promise<void> {
    return this.lifecycle.run((token) => this.executeStart(token));
  }

  private async executeStart(token: LifecycleToken): Promise<void> {
    // A previous stop() left the queue refusing everything. Re-open BEFORE subscribing, or
    // the restarted module silently drops every command at `enqueue` — including the S1
    // retry the deferred release exists to admit — for the life of the process.
    this.queue?.reopen();
    this.unsubs.push(
      this.deps.bus.subscribe("PlaceOrderRequested", (p) => this.handlePlace(p.command)),
      this.deps.bus.subscribe("CancelOrderRequested", (p) => this.handleCancel(p.command)),
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) => this.handleMarketUpdate(p)),
      this.deps.bus.subscribe("TrackedMarketsChanged", (p) => this.handleTrackedMarketsChanged(p)),
      this.deps.bus.subscribe("PositionUpdated", (p) => this.handlePositionUpdated(p)),
      // Release A Phase 3 (P6) — terminal confirmation for the transition barrier.
      // OrderCancelled is ALSO published independently by user-order-stream-module.ts
      // (live exchange websocket echo) which never goes through executeCancel, so this
      // subscription is the only path that catches that source; a fill is the other
      // way a drain target can reach terminal status (it filled instead of cancelling).
      this.deps.bus.subscribe("OrderCancelled", async (p) =>
        this.removeTransitionTargetIfTerminal(p.tokenId, p.orderId),
      ),
      this.deps.bus.subscribe("OrderRejected", async (p) => {
        const order = this.deps.orderRepo.findByClientOrderId(p.clientOrderId);
        if (order) this.removeTransitionTargetIfTerminal(order.tokenId, order.orderId);
      }),
      this.deps.bus.subscribe("FillReceived", async (p) =>
        this.removeTransitionTargetIfTerminal(p.tokenId, p.orderId),
      ),
    );

    // Finding 5: autonomous transition reconciliation. unref() so it never keeps the
    // process alive; cleared in stop(). Fire-and-forget (its own errors are logged).
    this.reconcileTimer = setInterval(() => {
      void this.reconcileAllTransitions().catch((err: unknown) => {
        this.log.error({ err }, "autonomous transition reconcile failed");
      });
    }, AUTONOMOUS_RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref?.();
    // One-time startup re-evaluation of every existing resting exit SELL against
    // the loss floor (code-review finding #3): risk/inventory starts before
    // execution and can publish PositionUpdated BEFORE we subscribe, so a SELL
    // that became below-floor while we were down would otherwise never be
    // re-checked in a quiet period. Runs after subscribing so nothing is missed.
    await this.reEvaluateRestingSellsAtStartup(token);
    // A `stop()` that gave up waiting for THIS start already tore it down: the subscriptions and
    // the reconcile timer above are installed before the first await, so its unsub loop and
    // `clearInterval` both reached them, and it left `started = false`. Flipping that back is not
    // a stale log line — `started` is the guard that keeps a torn-down module from PLACING.
    // `removeTransitionTargetIfTerminal` and `connectPersistedRungToPendingBackstop` are both
    // reachable from chains still in flight after `stop()` returns (it does not await bus handlers,
    // and a queue shutdown that hit its deadline leaves commands executing), and both fire a
    // deferred backstop onto the exchange the moment `started` is true — here, while the ledger is
    // being closed. Only the token sees this: a stop that escaped its ceiling is usually followed
    // by a restart, which resets any plain flag back to "running".
    if (token.superseded) {
      this.log.warn("execution module was stopped during its startup pass — start abandoned");
      return;
    }
    this.started = true;
    this.deps.makerBuyFastCancel?.setReady(true);
    this.log.info("execution module started");
  }

  /**
   * The token is re-read per order, not once on entry: each `cancelRestingSellIfBelowFloor` awaits a
   * publish, and a `stop()` that gives up during any one of them tears the module down and lets a
   * restart install its own subscriptions. Resuming this loop afterwards would publish a fresh
   * cancel through the REPLACEMENT's live subscriptions — real exchange work by a startup whose stop
   * already returned. Checking only after the loop (at the caller's final guard) is too late by
   * however many orders remain.
   */
  private async reEvaluateRestingSellsAtStartup(token: LifecycleToken): Promise<void> {
    for (const order of this.deps.orderRepo.findOpen()) {
      if (token.superseded) {
        this.log.warn("execution module startup scan abandoned — a later stop superseded it");
        return;
      }
      if (order.side === "sell") await this.cancelRestingSellIfBelowFloor(order, "startup-scan");
    }
  }

  /**
   * Per-order max-lot re-check of a resting exit SELL. The verdict is a per-order
   * bound (independent of other sells, size, or fill order), so each resting order
   * is checked and cancelled independently — no set/survivor computation, and
   * cancelling one order cannot make another unsafe.
   */
  private async cancelRestingSellIfBelowFloor(
    order: Order,
    phase: "startup-scan" | "position-updated-reeval",
  ): Promise<void> {
    const remainingShares = this.getRemainingOrderShares(order);
    if (remainingShares <= 0) return;
    const verdict = this.evaluateSellExitLossFloor(order, order.price);
    if (!verdict.block) return;
    this.log.warn(
      {
        orderId: String(order.orderId),
        tokenId: String(order.tokenId),
        remainingShares,
        price: order.price,
        exitLossFloorReason: verdict.reason,
      },
      phase === "startup-scan"
        ? "resting exit SELL below loss floor at startup — cancelling"
        : "resting exit SELL now below loss floor after position update — cancelling",
    );
    this.recordExitLossFloorCounter(verdict.reason, phase);
    this.recordExitLossFloorRiskEvent(verdict.reason, phase, {
      tokenId: String(order.tokenId),
      orderId: String(order.orderId),
      submittedPrice: order.price,
      effectiveSellShares: remainingShares,
    });
    await this.requestExitLossFloorCancel(order.orderId);
  }

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    for (const market of payload.markets) {
      this.marketCache.set(String(market.tokenId), market);
    }
  }

  private async handleTrackedMarketsChanged(
    payload: RuntimeEventMap["TrackedMarketsChanged"],
  ): Promise<void> {
    for (const tokenId of payload.removedTokenIds) {
      this.marketCache.delete(String(tokenId));
    }
  }

  /** Serialized against every other transition, so the LAST caller decides the final state. */
  stop(): Promise<void> {
    return this.lifecycle.run(() => this.executeStop(), {
      ms: LIFECYCLE_STOP_WAIT_MS,
      onExpired: () =>
        this.log.error(
          { waitMs: LIFECYCLE_STOP_WAIT_MS },
          "lifecycle transition never settled — stopping anyway",
        ),
    });
  }

  private async executeStop(): Promise<void> {
    this.deps.makerBuyFastCancel?.setReady(false);
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.pendingDeferredSubmit.clear();
    // A restarted module must not inherit a throttle window from the previous
    // run: the book cache is rebuilt too, so the value it was suppressing a
    // refetch of is gone.
    this.minOrderSizeHydrationRequestedAt.clear();
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    const drained = this.queue
      ? (await this.queue.shutdown()).drained
      : await drainGenerations(this.directInFlight, EXECUTION_SHUTDOWN_TIMEOUT_MS);
    // EXECUTE the pending intents, do not drop them. `stop()` does not await in-flight bus
    // handlers, so an unknown-minimum SELL suspended inside its own `OrderRejected` publish
    // reaches `executeCommand`'s `finally` AFTER this point: it would find nothing left to drain
    // and leave the id marked in `processedCommandIds`, which `stop()` does not clear. The
    // identical S1 retry is then swallowed as a duplicate for the lifetime of the process — the
    // exact tight loop this whole mechanism exists to end, re-created by a restart.
    //
    // LAST, after unsubscribing and after the queue has drained, for the same reason the
    // block site defers instead of releasing inline: while this command's reservation and
    // in-flight slot are still live, a concurrent delivery of the SAME id that got past the
    // idempotency check is rejected as `reserved-token-limit` — an admission-stage branch
    // with no `executeCommand` finally — and re-burns the id for good. Draining first
    // unwinds that accounting and stops new deliveries from arriving at all.
    //
    // ONLY when the queue actually reached quiescence. A shutdown that returned at its deadline
    // still has commands executing, and releasing THEIR marks re-creates the defect this ordering
    // exists to prevent. The set is deliberately left intact instead: `executeCommand`'s own
    // `finally` drains each id as its command finishes, so nothing is lost by waiting.
    if (drained) {
      for (const commandId of this.commandIdsPendingRelease) {
        this.releaseProcessedCommandId(commandId);
      }
      this.commandIdsPendingRelease.clear();
    } else {
      this.log.warn(
        { pendingRelease: this.commandIdsPendingRelease.size },
        "queue shutdown timed out — deferring idempotency release to each command's own finally",
      );
    }
    this.started = false;
    this.log.info("execution module stopped");
  }

  /**
   * Finding 6: latch/unlatch the hard startup fence. `begin` is called BEFORE the
   * supervisor starts and `end` only after READY_PAUSED is durably published, so no
   * placement or recovery can slip through the pre-readiness window.
   */
  beginStartupFence(): void {
    this.startupFenceActive = true;
  }
  endStartupFence(): void {
    this.startupFenceActive = false;
  }

  /**
   * Whether an order is a live target of some token's transition barrier — i.e. whether the drain
   * still owns it. Read-only, and deliberately keyed by ORDER rather than token: the caller
   * (`runDrainedOrderFenceGate`) must prove the barrier holds each specific order the ownership
   * gate excused, and a token-level answer would pass a token whose barrier targets a DIFFERENT
   * order. Scans the map because a boot has a handful of transitions at most.
   */
  hasTransitionTarget(orderId: OrderId): boolean {
    const key = String(orderId);
    for (const transition of this.tokenTransitions.values()) {
      if (transition.targets.has(key)) return true;
    }
    return false;
  }

  /** Number of queued + in-flight execution tasks. Zero = fully drained. */
  get pendingCount(): number {
    return this.queue?.pendingCount ?? 0;
  }

  /**
   * Hand whatever is LEFT of the runtime's teardown budget to the commands `stop()` had to abandon
   * at its own, much shorter deadline.
   *
   * That deadline is a SCHEDULING decision, not a correctness one: `stop()` runs while two dozen
   * other modules are still queued behind it, so a generous bound there would starve them. What it
   * abandons, though, can be a POST the exchange has already ACCEPTED — and if the process exits
   * before that command's own `finally` writes the order row, the order exists on the exchange with
   * no local row, which fail-closes startup adoption at the next boot. Once every module is down the
   * teardown budget is normally almost entirely unspent, so the remainder goes to exactly the
   * commands that can still lose trading state with it.
   *
   * Reusing that one budget rather than adding to it is the point: the container's grace period
   * measures the TOTAL, so a slow module teardown must shorten this tail, never extend the sum.
   *
   * Nothing new can start here — the queue latched itself closed inside `stop()` and the module's
   * subscriptions are already gone — so this only ever awaits work that was running when the module
   * reported itself stopped.
   */
  async drainAbandonedTail(timeoutMs: number): Promise<boolean> {
    const inFlight = this.queue?.inFlightCount ?? this.directInFlight.size;
    if (inFlight === 0) return true;
    this.log.info({ inFlight, timeoutMs }, "tail-draining execution commands abandoned by stop()");
    const drained = this.queue
      ? await this.queue.drainAbandoned(timeoutMs)
      : await drainGenerations(this.directInFlight, timeoutMs);
    if (!drained) {
      this.log.error(
        { stillRunning: this.queue?.inFlightCount ?? this.directInFlight.size },
        "execution tail drain expired — a command the exchange may have accepted is unpersisted",
      );
    }
    return drained;
  }

  getDiagnostics(): {
    pendingCount: number;
    queueDepth: number;
    activeCount: number;
    maxConcurrency: number | null;
    placeCompleted: number;
    cancelCompleted: number;
    avgPlaceLatencyMs: number | null;
    avgCancelLatencyMs: number | null;
    reservedBuyUsdc: number;
    freeUsdcForNewOrders: number | null;
    buyCapacity?: {
      enabled: boolean;
      minNewEntryWalletHeadroomUsdc: number;
      minAddWalletHeadroomUsdc: number;
      minViableEntryUsdc: number;
      maxOpenBuyOrders: number;
      protectedOpenBuySlots: number;
      effectiveMaxOpenBuyOrders: number;
      maxOpenBuyOrdersPerToken: number;
      openBuyOrderCount: number;
      newEntryCapacityUsdc: number | null;
      addCapacityUsdc: number | null;
      entriesBlocked: boolean;
      addsBlocked: boolean;
    };
    sellCapacity?: {
      enabled: boolean;
      mode: ExecutionPolicy["sellCapacity"]["mode"];
      maxOpenSellOrders: number;
      maxOpenSellOrdersPerToken: number;
      openSellOrderCount: number;
      openProfileLadderSellOrderCount: number;
      openNonProfileLadderSellOrderCount: number;
      profileOwnedOpenPositionCount: number | null;
      profileLadderCapRaw: number | null;
      effectiveProfileLadderCap: number | null;
      nonLadderReserve: number | null;
      dynamicGlobalCap: number | null;
      hardMaxOpenSellOrders: number | null;
      blocked: boolean;
    };
    orderCapacity?: {
      enabled: boolean;
      maxOpenOrdersTotal: number;
      protectedOpenOrderSlots: number;
      effectiveMaxOpenOrdersTotal: number;
      openOrdersTotal: number;
      blocked: boolean;
    };
    reservedSellTokenCount: number;
    cancelReplacePendingCount: number;
    gatewayRejectsLast10mByCode: Record<string, number>;
    internalReservationRejectsLast10m: number;
    internalReservationRejectsLast10mByReason: Record<string, number>;
    sellSizeClamps: number;
  } {
    const queue = this.queue?.diagnostics;
    const reservations = this.getReservationSnapshot();
    const walletBudget = resolveWalletBuyBudget(
      {
        controlDb: this.deps.controlDb,
        activeProfile: this.deps.activeProfile,
        walletBufferPct: this.deps.walletBufferPct,
        walletBufferMinUsdc: this.deps.walletBufferMinUsdc,
      },
      reservations.reservedBuyUsdc,
    );
    const executionPolicy = this.deps.executionPolicy?.();
    const buyCapacity = normalizeBuyCapacityPolicy(executionPolicy?.buyCapacity);
    const sellCapacity = normalizeSellCapacityPolicy(executionPolicy?.sellCapacity);
    const orderCapacity = normalizeOrderCapacityPolicy(executionPolicy?.orderCapacity);
    const profileOwnedOpenPositionCount = this.currentProfileOwnedOpenPositionCount();
    const protectedRequirement = resolveProtectedWalletBuyRequirement({
      makerEntry: executionPolicy?.makerEntry ?? null,
      authorization: null,
      proposedNotionalUsdc: 0,
      pendingBuyNotionalUsdc: 0,
      nowMs: Date.now(),
    });
    const sellCapacityDiagnostic = evaluateWalletSellCapacity({
      policy: sellCapacity,
      source: "other",
      openSellOrderCount: reservations.openSellOrderCount,
      openProfileLadderSellOrderCount: reservations.openProfileLadderSellOrderCount,
      openNonProfileLadderSellOrderCount: reservations.openNonProfileLadderSellOrderCount,
      profileOwnedOpenPositionCount,
    });
    const newEntryDecision = evaluateWalletBuyCapacity({
      policy: buyCapacity,
      snapshot: walletBudget,
      requiredNotionalUsdc: protectedRequirement.requiredNotionalUsdc,
      signalReason: "probe-entry",
      openBuyOrderCount: reservations.openBuyOrderCount,
      protectedOpenBuySlots: protectedRequirement.protectedOpenBuySlots,
    });
    const addDecision = evaluateWalletBuyCapacity({
      policy: buyCapacity,
      snapshot: walletBudget,
      requiredNotionalUsdc: protectedRequirement.requiredNotionalUsdc,
      signalReason: "scale-in",
      openBuyOrderCount: reservations.openBuyOrderCount,
      protectedOpenBuySlots: protectedRequirement.protectedOpenBuySlots,
    });
    const orderCapacityDecision = evaluateTotalOrdersCapacity({
      policy: orderCapacity,
      openOrdersTotal: reservations.openOrdersTotal,
      protectedOpenOrderSlots: protectedRequirement.protectedOpenBuySlots,
    });
    const newEntryCapacityUsdc =
      newEntryDecision.availableAfterOrderUsdc == null
        ? null
        : Number(
            Math.max(
              0,
              newEntryDecision.availableAfterOrderUsdc - buyCapacity.minNewEntryWalletHeadroomUsdc,
            ).toFixed(6),
          );
    const internalRejects = this.getInternalReservationRejectsSnapshot();
    return {
      pendingCount: this.pendingCount,
      queueDepth: queue?.queueDepth ?? 0,
      activeCount: queue?.activeCount ?? 0,
      maxConcurrency: queue?.maxConcurrency ?? null,
      placeCompleted: this.placeCompleted,
      cancelCompleted: this.cancelCompleted,
      avgPlaceLatencyMs:
        this.placeCompleted > 0 ? Math.round(this.placeLatencyTotalMs / this.placeCompleted) : null,
      avgCancelLatencyMs:
        this.cancelCompleted > 0
          ? Math.round(this.cancelLatencyTotalMs / this.cancelCompleted)
          : null,
      reservedBuyUsdc: Number(reservations.reservedBuyUsdc.toFixed(6)),
      freeUsdcForNewOrders: walletBudget
        ? Number(Math.max(0, walletBudget.freeUsdcForNewOrders).toFixed(6))
        : null,
      buyCapacity: {
        enabled: buyCapacity.enabled,
        minNewEntryWalletHeadroomUsdc: buyCapacity.minNewEntryWalletHeadroomUsdc,
        minAddWalletHeadroomUsdc: buyCapacity.minAddWalletHeadroomUsdc,
        minViableEntryUsdc: buyCapacity.minViableEntryUsdc,
        maxOpenBuyOrders: buyCapacity.maxOpenBuyOrders,
        protectedOpenBuySlots: newEntryDecision.protectedOpenBuySlots,
        effectiveMaxOpenBuyOrders: newEntryDecision.effectiveMaxOpenBuyOrders,
        maxOpenBuyOrdersPerToken: buyCapacity.maxOpenBuyOrdersPerToken,
        openBuyOrderCount: reservations.openBuyOrderCount,
        newEntryCapacityUsdc,
        addCapacityUsdc:
          addDecision.availableAfterOrderUsdc == null
            ? null
            : Number(
                Math.max(
                  0,
                  addDecision.availableAfterOrderUsdc - buyCapacity.minAddWalletHeadroomUsdc,
                ).toFixed(6),
              ),
        // Diagnostic only (dashboard): "effectively blocked" = hard-blocked OR deployable capacity
        // below the minimum viable entry. NOT a trading gate — the real entry gate uses the true
        // order notional via evaluateWalletBuyCapacity (index.ts / algo-risk-gate.ts).
        entriesBlocked: resolveEntriesBlocked({
          hardAllowed: newEntryDecision.allowed,
          newEntryCapacityUsdc,
          minViableEntryUsdc: buyCapacity.minViableEntryUsdc,
        }),
        addsBlocked: !addDecision.allowed,
      },
      sellCapacity: {
        enabled: sellCapacity.enabled,
        mode: sellCapacity.mode,
        maxOpenSellOrders: sellCapacityDiagnostic.maxOpenSellOrders,
        maxOpenSellOrdersPerToken: sellCapacity.maxOpenSellOrdersPerToken,
        openSellOrderCount: reservations.openSellOrderCount,
        openProfileLadderSellOrderCount: reservations.openProfileLadderSellOrderCount,
        openNonProfileLadderSellOrderCount: reservations.openNonProfileLadderSellOrderCount,
        profileOwnedOpenPositionCount:
          sellCapacityDiagnostic.dynamic?.profileOwnedOpenPositionCount ?? null,
        profileLadderCapRaw: sellCapacityDiagnostic.dynamic?.profileLadderCapRaw ?? null,
        effectiveProfileLadderCap:
          sellCapacityDiagnostic.dynamic?.effectiveProfileLadderCap ?? null,
        nonLadderReserve: sellCapacityDiagnostic.dynamic?.nonLadderReserve ?? null,
        dynamicGlobalCap: sellCapacityDiagnostic.dynamic?.dynamicGlobalCap ?? null,
        hardMaxOpenSellOrders:
          sellCapacity.mode === "source_aware_dynamic" ? sellCapacity.hardMaxOpenSellOrders : null,
        blocked: !sellCapacityDiagnostic.allowed,
      },
      orderCapacity: {
        enabled: orderCapacity.enabled,
        maxOpenOrdersTotal: orderCapacity.maxOpenOrdersTotal,
        protectedOpenOrderSlots: orderCapacityDecision.protectedOpenOrderSlots,
        effectiveMaxOpenOrdersTotal: orderCapacityDecision.effectiveMaxOpenOrdersTotal,
        openOrdersTotal: reservations.openOrdersTotal,
        blocked: !orderCapacityDecision.allowed,
      },
      reservedSellTokenCount: reservations.reservedSellByToken.size,
      cancelReplacePendingCount: this.sellReplaceLocks.size,
      gatewayRejectsLast10mByCode: this.getGatewayRejectsLast10mByCode(),
      internalReservationRejectsLast10m: internalRejects.count,
      internalReservationRejectsLast10mByReason: internalRejects.byReason,
      sellSizeClamps: this.sellSizeClamps,
    };
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.started) {
      return { ok: false, detail: "not started" };
    }
    const gw = await this.deps.gateway.healthCheck();
    return {
      ok: gw.ok,
      detail: gw.ok ? `gateway ok (${gw.latencyMs}ms)` : "gateway unreachable",
    };
  }

  /**
   * R23 Phase 5 — single fail-closed maker-BUY validator. Called at admission
   * AND at both exchange submit sites (main + invalid-tick retry) so a mode
   * flip / whitelist change / cap tightening that lands between admission and
   * submit is caught before an order reaches the exchange (TOCTOU fix), rather
   * than racing on a stale admission-time snapshot. Re-reads the CURRENT
   * execution policy on every call. Returns null when the command is not a
   * maker BUY — every other command is unaffected by this validator.
   *
   * Aggregate-cap accounting is reservation-safe under price drift: the caller's
   * own pending reservation (keyed by commandId) is EXCLUDED from the pending sum
   * and its CURRENT `notional` is always added instead. At admission the command
   * is not yet reserved (exclusion is a no-op) so its notional is added once; at a
   * submit site the command IS reserved (set at admission, cleared in
   * executeCommand's `finally` AFTER executePlace), and excluding the stale
   * reservation while adding the live `notional` is what makes an upward tick
   * re-snap between admission and submit count at its FINAL notional, not the
   * stale admission-price one.
   */
  /**
   * Release A Phase 3 — reject a command that would violate bounce exclusivity or
   * act on a stale/ambiguous position cycle. Applied at all three placement
   * boundaries (admission, main submit, invalid-tick retry).
   *
   * Requires positionRepo (always wired in prod); a no-op when absent. A no-op for
   * a non-owner command whose positionId matches its single live position → today's
   * behavior is byte-identical on the common path. Fail-closed: a bounce-ruled SELL
   * on a non-bounce owner, a non-bounce SELL on a bounce owner, a stale/absent cycle
   * id, or an ambiguous (>1 live) token are all rejected.
   */
  private exitOwnerIdentityRejection(
    cmd: PlaceOrderCommand,
  ): { reason: string; code: ExchangeErrorCode } | null {
    const positionRepo = this.deps.positionRepo;
    if (!positionRepo) return null;

    const isSell = cmd.side === "sell";
    // An initial-entry BUY carries no positionId (it opens a new cycle) — nothing to verify.
    if (!isSell && cmd.positionId == null) return null;

    const active = positionRepo.findActiveByTokenId(cmd.tokenId);

    let target: Position | null = null;
    if (cmd.positionId != null) {
      target = active.find((p) => String(p.positionId) === String(cmd.positionId)) ?? null;
      if (target == null) {
        // The claimed cycle is gone/closed (or on another token) — stale cross-cycle.
        return { reason: "exit-owner-stale-position", code: ExchangeErrorCode.LivePolicyBlocked };
      }
      if (active.length > 1) {
        // A second live cycle on the same token = an unfinished transition; act on
        // neither until the P6 fence has drained it.
        return {
          reason: "exit-owner-ambiguous-position",
          code: ExchangeErrorCode.LivePolicyBlocked,
        };
      }
    } else {
      // A SELL with no captured cycle id (legacy edge — should not happen post-P2).
      // Still apply the SAME ambiguity + owner/rule exclusivity checks below against
      // the token's single active position (a NULL-owner legacy position stays
      // allowed). Fail-closed on an ambiguous token — we cannot say which cycle.
      if (active.length > 1) {
        return {
          reason: "exit-owner-ambiguous-position",
          code: ExchangeErrorCode.LivePolicyBlocked,
        };
      }
      target = active[0] ?? null;
    }

    // Owner exclusivity is a SELL concern; an add-BUY is identity-checked above only.
    if (!isSell) return null;
    // A SELL against no matchable active position: nothing to enforce (today's behavior).
    if (target == null) return null;

    const bounceRuled =
      isBounceForceExit({ side: cmd.side, decisionRuleId: cmd.decisionRuleId ?? null }) ||
      cmd.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID;
    const ownerIsBounce = isBounceOwned(target);

    // A bounce-ruled SELL on a 'profile' OWNER is a violation (defense-in-depth —
    // P3 never produces one). A NULL owner (pre-census legacy) legitimately receives
    // bounce SELLs via today's GATE/sellableFlow routing, so it is NOT rejected here;
    // a stale cross-cycle bounce SELL is caught by the positionId identity check above.
    if (bounceRuled && target.exitOwner === "profile") {
      return {
        reason: "exit-owner-bounce-rule-on-profile-owner",
        code: ExchangeErrorCode.LivePolicyBlocked,
      };
    }
    // A non-bounce SELL (ProfileLadder / S1 / D8·D9 / dust) on a bounce OWNER is the
    // core exclusivity violation.
    if (!bounceRuled && ownerIsBounce) {
      return {
        reason: "exit-owner-non-bounce-rule-on-bounce-owner",
        code: ExchangeErrorCode.LivePolicyBlocked,
      };
    }
    return null;
  }

  // ─── P6 transition barrier ────────────────────────────────────────────

  /**
   * Release A Phase 3 (P6) — reject a command competing with a token's
   * in-progress drain, opening the barrier first if this command is the one
   * that exposes a stale/cross-cycle working order. Mirrors
   * `exitOwnerIdentityRejection`'s insertion at the same 3 boundaries. A no-op
   * (byte-identical to today) whenever the token has no stale working SELL and
   * is not already draining.
   */
  private async transitionRejection(
    cmd: PlaceOrderCommand,
  ): Promise<{ reason: string; code: ExchangeErrorCode } | null> {
    // Self-heal before deciding: prune terminal targets / retry stuck cancels so a
    // stale barrier can never block this placement (finding 4).
    await this.reconcileTokenTransition(cmd.tokenId);
    if (this.tokenTransitions.has(String(cmd.tokenId))) {
      return { reason: "transition-draining", code: ExchangeErrorCode.LivePolicyBlocked };
    }
    if (await this.openTransitionForStaleWorkingSells(cmd)) {
      return { reason: "transition-draining", code: ExchangeErrorCode.LivePolicyBlocked };
    }
    return null;
  }

  /**
   * Pre-BUY cross-cycle gate. A reopening/scale-in BUY must never be admitted
   * while a working SELL from a PRIOR/closed cycle (or a legacy NULL-positionId
   * SELL — fail-closed) can still fill against it. Drains those SELLs and
   * defers this BUY rather than admitting it alongside them. No-op for a SELL
   * command or when positionRepo is absent (legacy unit tests).
   */
  private async openTransitionForStaleWorkingSells(cmd: PlaceOrderCommand): Promise<boolean> {
    if (cmd.side !== "buy") return false;
    const positionRepo = this.deps.positionRepo;
    if (!positionRepo) return false;

    const activePositionIds = new Set(
      positionRepo.findActiveByTokenId(cmd.tokenId).map((p) => String(p.positionId)),
    );
    const staleSells = this.findOpenSellOrdersForToken(cmd.tokenId).filter((order) =>
      this.isStaleWorkingSell(order, cmd, activePositionIds),
    );
    if (staleSells.length === 0) return false;

    await this.openTokenTransition(cmd.tokenId, cmd.positionId ?? null, staleSells);
    return true;
  }

  private isStaleWorkingSell(
    order: Order,
    cmd: PlaceOrderCommand,
    activePositionIds: ReadonlySet<string>,
  ): boolean {
    const orderPositionId = order.positionId != null ? String(order.positionId) : null;
    if (orderPositionId == null) return true; // legacy/NULL — fail closed
    if (!activePositionIds.has(orderPositionId)) return true; // its cycle already closed
    return cmd.positionId != null && orderPositionId !== String(cmd.positionId);
  }

  /**
   * Opens (or extends) the drain for a token: records each not-yet-targeted
   * order and publishes its cancel. Idempotent — re-adding an order already in
   * `targets` is a no-op, so repeated calls (e.g. a retried BUY re-triggering
   * the same stale SELL) never double-publish a cancel.
   */
  private async openTokenTransition(
    tokenId: TokenId,
    activePositionId: string | null,
    staleOrders: readonly Order[],
    knownExchangeLive = false,
  ): Promise<void> {
    const key = String(tokenId);
    const transition = this.tokenTransitions.get(key) ?? {
      activePositionId,
      targets: new Set<string>(),
    };
    const newlyTargeted: Order[] = [];
    for (const order of staleOrders) {
      const orderKey = String(order.orderId);
      if (transition.targets.has(orderKey)) continue;
      // Runtime discovery only sees local working orders, but startup may prove that a
      // locally terminal row is still exchange-live. That inconsistency must stay fenced
      // until the normal exact cancel/fill lane supplies terminal proof.
      if (isTerminalOrderStatus(order.status) && !knownExchangeLive) continue;
      transition.targets.add(orderKey);
      newlyTargeted.push(order);
    }
    this.tokenTransitions.set(key, transition);
    // If every stale order was already terminal, close immediately (nothing to drain).
    if (transition.targets.size === 0) {
      this.maybeCloseTokenTransition(tokenId);
      return;
    }

    for (const order of newlyTargeted) {
      this.log.warn(
        {
          tokenId: key,
          orderId: String(order.orderId),
          positionId: order.positionId ?? null,
        },
        "transition barrier opened — draining stale/cross-cycle working order",
      );
      await this.publishManagedCancel(order.orderId, "operator");
    }
  }

  /**
   * Startup wiring only (P6 part 3): seed the barrier for tokens whose
   * stale/reopening working orders survived startup classification unconfirmed
   * (startup-position-adoption.ts only classifies — it never mutates the
   * exchange). Reuses the exact same drain machinery a live-running token
   * transition uses, so normal servicing stays blocked until the barrier's own
   * cancel-confirmation hooks resolve every seeded target. Must be called
   * AFTER the module has started (subscriptions wired) so the cancel publish
   * is actually consumed.
   */
  async seedStartupTransitions(
    targets: ReadonlyArray<{
      tokenId: TokenId;
      activePositionId: string | null;
      orders: readonly Order[];
    }>,
  ): Promise<void> {
    for (const target of targets) {
      if (target.orders.length === 0) continue;
      await this.openTokenTransition(target.tokenId, target.activePositionId, target.orders, true);
    }
  }

  /**
   * Removes a target from its token's drain once it is exchange-confirmed
   * terminal (cancelled OR filled — a drain target may fill instead of
   * cancelling). Called from THREE places: the local cancel result path
   * (`executeCancel`, right after `releasePendingSellReplacement`), the
   * `OrderCancelled` subscription, and the `FillReceived` subscription.
   * Idempotent (a no-op target/transition is simply skipped) and safe to call
   * redundantly from more than one of those hooks for the same order. An
   * ambiguous/non-terminal current status (still open/pending/partially-filled)
   * leaves the target in place and the token draining — P7 will add
   * authoritative wallet reconciliation for that case.
   */
  private removeTransitionTargetIfTerminal(tokenId: TokenId, orderId: OrderId): void {
    const key = String(tokenId);
    const transition = this.tokenTransitions.get(key);
    if (!transition) return;
    const orderKey = String(orderId);
    if (!transition.targets.has(orderKey)) return;

    const order = this.deps.orderRepo.findById(orderId);
    if (!order || !isTerminalOrderStatus(order.status)) return;

    transition.targets.delete(orderKey);
    // Finding 3 (round 3): a target confirmed terminal via OrderCancelled/FillReceived
    // must also drop its backoff entry — otherwise `transitionCancelRetryAt` leaks
    // unboundedly (the transition closes and autonomous reconcile can't reach it).
    this.transitionCancelRetryAt.delete(orderKey);
    this.maybeCloseTokenTransition(tokenId);
  }

  private maybeCloseTokenTransition(tokenId: TokenId): void {
    const key = String(tokenId);
    const transition = this.tokenTransitions.get(key);
    if (!transition) return;
    if (transition.targets.size > 0) return;
    if (this.hasInFlightCommand(tokenId)) return; // a queued/in-flight command could still race
    this.tokenTransitions.delete(key);
    this.log.info({ tokenId: key }, "transition barrier closed — token quiescent");

    // P7 finding 2: the barrier reaching quiescent is the ONLY thing that fires a
    // durable deferred backstop — never a timer or a re-delivered signal. Guard on
    // `started` so a stopped module never places (and a fire-and-forget chain cannot
    // outlive the module into unrelated work).
    if (this.started && this.pendingBackstops.has(key)) {
      void this.placeDeferredBackstop(tokenId).catch((err: unknown) => {
        this.log.error({ err, tokenId: key }, "deferred bounce backstop placement failed");
      });
    }
  }

  /**
   * Finding-4 self-heal: re-derive a token's drain against the AUTHORITATIVE order
   * status (orderRepo) so the barrier can never get stuck open. Run before every
   * placement decision for the token. Prunes any target that is now terminal —
   * regardless of HOW it got terminal (local cancel, reconciliation marking it
   * cancelled WITHOUT an OrderCancelled event, or a fill) — because it re-reads the
   * status directly. Retries the cancel for any target still working (idempotent:
   * cancelReservations dedups an in-flight cancel; a terminal order early-returns),
   * so a failed/lost cancel is re-attempted rather than blocking the token forever.
   */
  private async reconcileTokenTransition(tokenId: TokenId): Promise<void> {
    const transition = this.tokenTransitions.get(String(tokenId));
    if (!transition) return;
    const now = Date.now();
    for (const orderKey of [...transition.targets]) {
      const order = this.deps.orderRepo.findById(createOrderId(orderKey));
      // A target is released only by an exchange-terminal/fill event or the exact
      // resolver path in executeCancel. Local terminal state (or a missing local row)
      // is not sufficient proof and must leave the token fail-closed.
      if (!order) continue;
      // Finding 5 backoff: retry a stuck cancel at most once per backoff window, so a
      // token whose cancel keeps failing cannot cancel-storm on every reconcile tick.
      const lastRetry = this.transitionCancelRetryAt.get(orderKey) ?? 0;
      if (
        !this.cancelReservations.has(orderKey) &&
        now - lastRetry >= TRANSITION_CANCEL_RETRY_BACKOFF_MS
      ) {
        this.transitionCancelRetryAt.set(orderKey, now);
        await this.publishManagedCancel(order.orderId, "operator");
      }
    }
    this.maybeCloseTokenTransition(tokenId);
  }

  /**
   * Finding 5: autonomous driver — reconciles EVERY open transition (prune terminal +
   * backoff-retry stuck cancels + fire any now-quiescent deferred backstop) WITHOUT
   * needing a placement to arrive, so a failed/lost cancel can't deadlock a deferred
   * backstop forever. Also retries a deferred backstop that was re-armed after a
   * transient wallet-read failure (finding 1) but whose token has no open transition.
   */
  private async reconcileAllTransitions(): Promise<void> {
    if (!this.started) return;
    for (const key of [...this.tokenTransitions.keys()]) {
      await this.reconcileTokenTransition(createTokenId(key));
    }
    // Re-armed intents with no transition (F1 read-failure retry) — fire directly.
    for (const key of [...this.pendingBackstops.keys()]) {
      if (!this.tokenTransitions.has(key)) {
        await this.placeDeferredBackstop(createTokenId(key));
      }
    }
  }

  /** Working BOUNCE_EXIT_TARGET rungs for this command's exact position cycle. */
  private findCycleBounceRungs(cmd: PlaceOrderCommand): Order[] {
    return this.deps.orderRepo
      .findByTokenId(cmd.tokenId)
      .filter(
        (order) =>
          order.side === "sell" &&
          (order.status === "open" ||
            order.status === "pending" ||
            order.status === "partially-filled") &&
          order.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID &&
          !isExitRecoveryFencedPredecessor(order) &&
          this.matchesPositionCycle(order.positionId, cmd.positionId ?? null),
      );
  }

  /**
   * Finding 2 (round 4): a working LOCAL backstop taker for this cycle — the RELIABLE,
   * positively-identified "the backstop is already placed" signal (a prior deferred
   * placement that succeeded and persisted its order). Distinct from a size heuristic on
   * exchange orders, which cannot tell a backstop from a full-residual cleanup rung.
   */
  private findCycleBackstopWorking(cmd: PlaceOrderCommand): Order[] {
    return this.deps.orderRepo
      .findByTokenId(cmd.tokenId)
      .filter(
        (order) =>
          order.side === "sell" &&
          (order.status === "open" ||
            order.status === "pending" ||
            order.status === "partially-filled") &&
          isBounceForceExit({ side: order.side, decisionRuleId: order.decisionRuleId ?? null }) &&
          this.matchesPositionCycle(order.positionId, cmd.positionId ?? null),
      );
  }

  /**
   * P7 transactional B1 pre-step. If the backstop's cycle still has resting rungs:
   * preflight the loss floor (return a HOLD rejection WITHOUT cancelling if the
   * full-residual taker is below floor — never sacrifice the resting protection for
   * a taker that can't place), else record a DURABLE deferred-backstop intent
   * (finding 2) and open the P6 transition to cancel + CONFIRM the rungs, returning
   * a "draining" rejection so this backstop is deferred. Returns null when there are
   * no resting rungs (place the backstop normally). The deferred intent — not a
   * planner re-emission — is what fires the eventual placement, from
   * `placeDeferredBackstop` once `maybeCloseTokenTransition` sees the token quiescent.
   */
  private async openBackstopTransitionIfRungsResting(
    cmd: PlaceOrderCommand,
  ): Promise<{ reason: string; code: ExchangeErrorCode } | null> {
    const rungs = this.findCycleBounceRungs(cmd);
    if (rungs.length === 0) return null;
    const floorVerdict = this.evaluateSellExitLossFloor(cmd, cmd.price);
    if (floorVerdict.block) {
      return {
        reason: "bounce-backstop-below-floor-hold",
        code: ExchangeErrorCode.LivePolicyBlocked,
      };
    }
    this.pendingBackstops.set(String(cmd.tokenId), {
      positionId: cmd.positionId ?? null,
      command: cmd,
    });
    await this.openTokenTransition(cmd.tokenId, cmd.positionId ?? null, rungs);
    return { reason: "bounce-backstop-draining-rungs", code: ExchangeErrorCode.LivePolicyBlocked };
  }

  /** Working BOUNCE_EXIT_TARGET rungs, including admitted-but-not-yet-persisted ones
   * (finding 3) — the persisted-orders check alone misses a rung that has been
   * dispatched (accepted at admission) but hasn't reached `orderRepo` yet. */
  private hasInFlightBounceRungForCycle(cmd: PlaceOrderCommand): boolean {
    const cmdPositionId = String(cmd.positionId ?? null);
    for (const pending of this.inFlightBounceRungs.values()) {
      if (pending.tokenId === String(cmd.tokenId) && pending.positionId === cmdPositionId)
        return true;
    }
    return false;
  }

  /**
   * P7 finding 3: re-run the backstop rung check at the token-serialized
   * MAIN-SUBMIT boundary, not just at admission. A rung command can be admitted
   * and queued (or mid-`executeCommand`) without yet being a persisted Order row —
   * `findCycleBounceRungs` alone can't see it, so a backstop reaching submit at
   * that exact moment would otherwise slip through and double-exit alongside the
   * rung. Persisted rungs (re)open the P6 transition + re-arm the deferred intent
   * (idempotent — replaces any earlier entry for this token) so the backstop still
   * places once the barrier closes; an in-flight-only rung (no persisted target to
   * track) is refused without opening a transition — the rung's own admission path
   * (or the next submit-boundary check once it persists) will drain it.
   */
  private async backstopSubmitRungRejection(
    cmd: PlaceOrderCommand,
  ): Promise<{ reason: string; code: ExchangeErrorCode } | null> {
    if (!isBounceForceExit({ side: cmd.side, decisionRuleId: cmd.decisionRuleId ?? null }))
      return null;

    const persistedRungs = this.findCycleBounceRungs(cmd);
    if (persistedRungs.length === 0 && !this.hasInFlightBounceRungForCycle(cmd)) return null;

    // Finding 3: record the durable intent whenever we refuse the backstop — for a
    // persisted rung AND an in-flight-only rung — so the backstop is NEVER lost. For
    // a persisted rung, open the drain now; for an in-flight-only rung (no persisted
    // OrderId to target yet), the rung's own place-completion hook in `executeCommand`
    // opens the drain (or fires the backstop directly if it fails to persist).
    this.pendingBackstops.set(String(cmd.tokenId), {
      positionId: cmd.positionId ?? null,
      command: cmd,
    });
    if (persistedRungs.length > 0) {
      await this.openTokenTransition(cmd.tokenId, cmd.positionId ?? null, persistedRungs);
    }
    return { reason: "bounce-backstop-draining-rungs", code: ExchangeErrorCode.LivePolicyBlocked };
  }

  /**
   * Finding 3: when an in-flight BOUNCE_EXIT_TARGET rung finishes executing, if a
   * deferred backstop is waiting on its cycle, connect them: open the drain for the
   * now-persisted rung (so the barrier closes → the backstop fires), or — if the rung
   * failed to persist — fire the backstop directly (nothing left to drain).
   */
  private async connectPersistedRungToPendingBackstop(cmd: PlaceOrderCommand): Promise<void> {
    if (!this.started || !this.pendingBackstops.has(String(cmd.tokenId))) return;
    const rungs = this.findCycleBounceRungs(cmd);
    if (rungs.length > 0) {
      await this.openTokenTransition(cmd.tokenId, cmd.positionId ?? null, rungs);
    } else {
      await this.placeDeferredBackstop(cmd.tokenId);
    }
  }

  /**
   * P7 findings 1+2: fires exactly once per deferred intent, when the token's P6
   * transition barrier reaches quiescent (called from `maybeCloseTokenTransition`).
   * Reads+clears the pending entry FIRST (so a re-entrant close can't double-fire),
   * then reconciles the ACTUAL residual from the exchange wallet (never the stale
   * local reservation/position size the backstop was originally sized from) before
   * rebuilding and resubmitting the command through the normal `PlaceOrderRequested`
   * path — so every main-submit guard (loss floor, identity, barrier, min-size)
   * re-applies to the reconciled command exactly as it would to any fresh signal.
   */
  private async placeDeferredBackstop(tokenId: TokenId): Promise<void> {
    const key = String(tokenId);
    if (!this.pendingBackstops.has(key)) return;
    // Finding 1 (round 3): concurrency guard — the barrier-close fire and the autonomous
    // timer must not place two backstops at once. The intent is RETAINED throughout and
    // only removed when the backstop is confirmed working, the residual is gone, or it is
    // authoritatively dropped — so a pause / submit-reject / UNKNOWN placement always
    // leaves something for the autonomous timer to retry (never naked-and-forgotten).
    if (this.inFlightDeferredBackstop.has(key)) return;
    this.inFlightDeferredBackstop.add(key);
    try {
      const pending = this.pendingBackstops.get(key);
      if (!pending) return;

      // Completion signal 1 (finding 2): a working LOCAL backstop order for the cycle is
      // the RELIABLE "already placed" signal (a prior deferred place succeeded + persisted)
      // — positively identified, not a size heuristic. Complete the intent.
      if (this.findCycleBackstopWorking(pending.command).length > 0) {
        this.completeDeferredBackstop(key, "local backstop order already working");
        return;
      }

      // Transient — wallet read failed: HOLD, do NOT count as a failed attempt.
      let remoteSize: number;
      try {
        remoteSize = await this.deps.gateway.getPositionBalance(tokenId);
      } catch (err) {
        this.log.error(
          { err, tokenId: key, positionId: pending.positionId },
          "deferred bounce backstop HOLD (intent retained) — wallet balance read failed",
        );
        return;
      }

      // Completion signal 2 (finding 2): residual no longer executable → the position sold
      // out (the backstop filled, or a fill drained it). Complete the intent.
      const minOrderSize = this.resolveCommandMinOrderSize(pending.command);
      if (remoteSize <= 0 || !isExecutableOrderSize(remoteSize, minOrderSize)) {
        this.completeDeferredBackstop(key, "residual already sold");
        return;
      }

      // Transient — open-orders reconcile unavailable: HOLD, do NOT count as an attempt.
      const openOrders = await this.deps.gateway.getOpenOrdersResult?.();
      if (openOrders == null || !openOrders.ok) {
        this.log.warn(
          { tokenId: key, positionId: pending.positionId },
          "deferred bounce backstop HOLD (intent retained) — open-orders reconcile unavailable",
        );
        return;
      }

      // Finding 4: a working SELL already rests remotely (a prior ambiguous/UNKNOWN place
      // may have landed without a local record) → do NOT place a second taker. Retain — if
      // it is our backstop it fills (→ residual gone → complete) or persists a local order
      // (→ completion signal 1). Not counted as a placement attempt.
      const remoteWorkingSell = openOrders.data.some(
        (o) =>
          String(o.tokenId) === key &&
          String(o.side).toLowerCase() === "sell" &&
          (o.status === "OPEN" || o.status === "PARTIALLY_FILLED"),
      );
      if (remoteWorkingSell) {
        this.log.warn(
          { tokenId: key, positionId: pending.positionId },
          "deferred bounce backstop HOLD (intent retained) — a SELL is already working remotely (avoids a double taker)",
        );
        return;
      }

      // Finding 1 (round 6): NEVER publish another deferred backstop while a prior one's
      // outcome is still unknown — the accounting (grace + attempt) is anchored at the real
      // exchange-submit boundary in executeCommand, so this in-flight marker (not a bare
      // timestamp) is what closes the publish→submit double window even under a slow (45s)
      // gateway call.
      if (this.pendingDeferredSubmit.has(key)) return;

      // Finding 1 (round 5): grace window — do NOT submit again until the eventually-
      // consistent open-orders view has had time to reflect the previous SUBMIT (timestamp
      // set at the gateway boundary), so an UNKNOWN-landed prior order can't be followed by
      // a second full-residual taker.
      const now = Date.now();
      const lastPlace = this.lastDeferredPlaceAt.get(key) ?? 0;
      if (now - lastPlace < DEFERRED_BACKSTOP_PLACE_GRACE_MS) return; // retained; re-check next cycle

      // Finding 3 (round 5): cap ACTIVE placement (no storm) but do NOT abandon the intent —
      // once the cap is hit, ESCALATE: retain the intent, keep reconciling for completion on
      // every cycle (the checks above), and alert ONCE. The count is incremented at the
      // gateway boundary (finding 2), so transient pre-gateway rejects don't consume it.
      const attempts = this.deferredBackstopRetries.get(key) ?? 0;
      if (attempts >= MAX_DEFERRED_BACKSTOP_RETRIES) {
        if (attempts === MAX_DEFERRED_BACKSTOP_RETRIES) {
          this.deferredBackstopRetries.set(key, attempts + 1); // mark escalated (alert once)
          this.log.fatal(
            { tokenId: key, positionId: pending.positionId, attempts, remoteSize },
            "deferred bounce backstop ESCALATED — active placement capped; intent RETAINED, still reconciling; MANUAL INTERVENTION required",
          );
        }
        return; // retained + reconciling; never abandoned
      }

      const reconciledCmd: PlaceOrderCommand = {
        ...pending.command,
        commandId: createCommandId(randomUUID()),
        // Finding 1: a FRESH clientOrderId per attempt — a prior REJECTED order with a
        // stable id would otherwise poison every retry via the duplicate-clientOrderId gate.
        clientOrderId: buildClientOrderId({
          signalId: `bounce-backstop:${key}:${randomUUID()}`,
          tokenId,
          side: "sell",
        }),
        size: remoteSize,
        // Marker so the gateway-boundary accounting (executeCommand) recognises this as a
        // deferred backstop submit.
        metadata: { ...(pending.command.metadata ?? {}), __deferredBackstop: true },
      };
      // Track in flight until its outcome is known (cleared in executeCommand's finally).
      this.pendingDeferredSubmit.set(key, String(reconciledCmd.commandId));
      this.log.warn(
        {
          tokenId: key,
          positionId: pending.positionId,
          reconciledSize: remoteSize,
          attempts: attempts + 1,
          clientOrderId: String(reconciledCmd.clientOrderId),
        },
        "deferred bounce backstop placing — residual reconciled from wallet (intent retained until confirmed)",
      );
      await this.deps.bus.publish("PlaceOrderRequested", {
        command: reconciledCmd,
        timestamp: Date.now(),
      });
    } finally {
      this.inFlightDeferredBackstop.delete(key);
    }
  }

  /** Complete + forget a deferred backstop intent (placed/filled) and clear its bookkeeping. */
  private completeDeferredBackstop(key: string, reason: string): void {
    this.pendingBackstops.delete(key);
    this.deferredBackstopRetries.delete(key);
    this.lastDeferredPlaceAt.delete(key);
    this.log.info({ tokenId: key, reason }, "deferred bounce backstop intent completed");
  }

  /**
   * Finding 1 (round 7): clear the in-flight deferred-submit marker when THIS command
   * resolves — covers the admission-stage reject/skip paths (pause / startup fence /
   * loss-floor / etc.) that return from handlePlace BEFORE dispatch, so the marker (and
   * thus the whole deferred intent) can never be stranded by a rejected submit.
   */
  private clearPendingDeferredSubmit(cmd: PlaceOrderCommand): void {
    const tk = String(cmd.tokenId);
    if (this.pendingDeferredSubmit.get(tk) === String(cmd.commandId)) {
      this.pendingDeferredSubmit.delete(tk);
    }
  }

  /** True when `orderPositionId` matches `cmd`'s cycle. `undefined` cmdPositionId = unscoped (match all). */
  private matchesPositionCycle(
    orderPositionId: Order["positionId"],
    cmdPositionId: string | null | undefined,
  ): boolean {
    if (cmdPositionId === undefined) return true;
    return String(orderPositionId ?? null) === String(cmdPositionId ?? null);
  }

  private incrementTokenInFlight(cmd: PlaceOrderCommand | CancelOrderCommand): void {
    const key = String(this.resolveCommandTokenId(cmd));
    this.tokenInFlightCount.set(key, (this.tokenInFlightCount.get(key) ?? 0) + 1);
  }

  private decrementTokenInFlight(cmd: PlaceOrderCommand | CancelOrderCommand): void {
    const key = String(this.resolveCommandTokenId(cmd));
    const next = (this.tokenInFlightCount.get(key) ?? 1) - 1;
    if (next <= 0) this.tokenInFlightCount.delete(key);
    else this.tokenInFlightCount.set(key, next);
  }

  private hasInFlightCommand(tokenId: TokenId): boolean {
    return (this.tokenInFlightCount.get(String(tokenId)) ?? 0) > 0;
  }

  private isMakerCaptureReplacement(cmd: PlaceOrderCommand): boolean {
    return cmd.metadata?.makerCaptureRepriceV1 !== undefined;
  }

  private makerCaptureExecutionContext(
    cmd: PlaceOrderCommand,
  ): MakerCaptureExecutionContext | null {
    const metadata = parseMakerCaptureRepriceSignal(cmd.metadata?.makerCaptureRepriceV1);
    const intent = cmd.signalId
      ? this.deps.orderRepo.findMakerCaptureRepriceIntentBySignal?.(cmd.signalId)
      : null;
    if (
      !metadata ||
      !intent ||
      !cmd.signalId ||
      !matchesMakerCaptureIntent(cmd.signalId, metadata, intent)
    ) {
      return null;
    }
    const predecessor = this.deps.orderRepo.findById(intent.predecessorOrderId);
    const root = this.deps.orderRepo.findById(intent.rootOrderId);
    const usage = predecessor
      ? this.deps.orderRepo.getMakerCaptureChainUsage?.(predecessor.orderId)
      : null;
    const origin = root ? parseQuoteMotionOrigin(root) : null;
    const predecessorLineage = predecessor ? parseMakerCaptureLineage(predecessor) : null;
    const rootLineage = root ? parseMakerCaptureLineage(root) : null;
    const snapshot = this.deps.executionPolicySnapshot?.();
    const makerPolicy = snapshot?.policy.makerEntry;
    const window = makerPolicy?.microLiveWindow;
    const deadline = root ? resolveMakerMicroLiveFillDeadlineMs(root) : null;
    const proof = parseMakerCaptureRepriceProofV1(intent.proof);
    const expectedClientOrderId = buildClientOrderId({
      signalId: intent.lifecycleSignalId,
      tokenId: intent.tokenId,
      side: "buy",
    });
    const submittedChild = intent.childOrderId
      ? this.deps.orderRepo.findById(intent.childOrderId)
      : null;
    const remainingRootShares =
      usage && intent.candidatePrice
        ? Math.max(0, (usage.rootNotionalUsdc - usage.chainFilledUsdc) / intent.candidatePrice)
        : 0;
    if (
      !predecessor ||
      !root ||
      !usage?.trusted ||
      !origin ||
      !predecessorLineage ||
      !rootLineage ||
      !proof?.prepared ||
      (intent.status === "ready" && proof.submit !== null) ||
      !snapshot ||
      snapshot.controlRevision === null ||
      !makerPolicy?.captureBookReprice.enabled ||
      makerPolicy.mode !== "micro_live" ||
      window?.captureNextR23 !== true ||
      !isMakerMicroLiveWindowActive(window, Date.now()) ||
      intent.replacementIndex > makerPolicy.captureBookReprice.maxRepricesPerRoot ||
      (intent.status !== "ready" && intent.status !== "submitted") ||
      (intent.status === "submitted" &&
        (!submittedChild ||
          String(submittedChild.clientOrderId) !== String(expectedClientOrderId))) ||
      predecessor.status !== "cancelled" ||
      cmd.side !== "buy" ||
      cmd.entryStyle !== "maker" ||
      cmd.postOnly !== true ||
      cmd.decisionRuleId !== "R23_DIP_TRIGGER" ||
      cmd.signalReason !== "probe-entry" ||
      String(cmd.tokenId) !== String(intent.tokenId) ||
      String(cmd.conditionId) !== String(intent.conditionId) ||
      String(cmd.clientOrderId) !== String(expectedClientOrderId) ||
      intent.candidatePrice == null ||
      Math.abs(cmd.price - intent.candidatePrice) > ExecutionModule.PRICE_EPSILON ||
      intent.replacementSize == null ||
      Math.abs(proof.prepared.candidatePrice - intent.candidatePrice) >
        ExecutionModule.PRICE_EPSILON ||
      Math.abs(proof.prepared.replacementSize - intent.replacementSize) >
        ExecutionModule.SIZE_EPSILON_SHARES ||
      Math.abs(cmd.size - intent.replacementSize) > ExecutionModule.SIZE_EPSILON_SHARES ||
      usage.replacementIndex + 1 !== intent.replacementIndex ||
      String(usage.rootOrderId) !== String(intent.rootOrderId) ||
      String(predecessorLineage.rootOrderId) !== String(intent.rootOrderId) ||
      predecessorLineage.replacementIndex + 1 !== intent.replacementIndex ||
      rootLineage.replacementIndex !== 0 ||
      String(rootLineage.rootOrderId) !== String(root.orderId) ||
      origin.kind !== "r23_capture" ||
      origin.policySchemaVersion !== snapshot.policy.version ||
      origin.policyControlRevision !== snapshot.controlRevision ||
      origin.cohortId !== window.activatedAtUtc ||
      origin.entryPriceCeiling !== snapshot.policy.entryPriceCeiling ||
      !this.captureRootWindowMatches(root, window.activatedAtUtc, window.expiresAtUtc) ||
      deadline === null ||
      Date.now() >= deadline ||
      cmd.size > usage.predecessorRemainingShares + ExecutionModule.SIZE_EPSILON_SHARES ||
      cmd.size > remainingRootShares + ExecutionModule.SIZE_EPSILON_SHARES
    ) {
      return null;
    }
    return {
      intent,
      predecessor,
      root,
      usage,
      origin,
      proof,
      policySchemaVersion: snapshot.policy.version,
      policyControlRevision: snapshot.controlRevision,
      activatedAtUtc: window.activatedAtUtc,
      expiresAtUtc: window.expiresAtUtc,
    };
  }

  private makerCaptureRepriceRejection(
    cmd: PlaceOrderCommand,
  ): { reason: string; code: ExchangeErrorCode } | null {
    if (!this.isMakerCaptureReplacement(cmd)) return null;
    return this.makerCaptureExecutionContext(cmd)
      ? null
      : { reason: "maker-capture-reprice-invalid", code: ExchangeErrorCode.LivePolicyBlocked };
  }

  private async makerCaptureFreshBookRejection(
    cmd: PlaceOrderCommand,
  ): Promise<MakerCaptureFinalBookResult> {
    let context = this.makerCaptureExecutionContext(cmd);
    if (!context) return { ok: false, ...this.makerCapRejection("maker-capture-reprice-invalid") };
    let entry;
    try {
      entry = await primeFreshMakerCaptureBook(
        this.deps.candidateBookCache,
        String(cmd.tokenId),
        Date.now(),
      );
    } catch {
      entry = null;
    }
    if (!entry) return { ok: false, ...this.makerCapRejection("maker-capture-book-unavailable") };
    context = this.makerCaptureExecutionContext(cmd);
    if (!context) return { ok: false, ...this.makerCapRejection("maker-capture-reprice-invalid") };
    const candidate = computeMakerCaptureCandidate({
      book: entry.book,
      tickSize: cmd.tickSize,
      predecessorPrice: context.predecessor.price,
      predecessorVisibleShares: context.usage.predecessorRemainingShares,
      originalSuggestedPrice: context.origin.originalSuggestedPrice,
      entryPriceCeiling: context.origin.entryPriceCeiling!,
    });
    if (!candidate.ok || Math.abs(candidate.price - cmd.price) > ExecutionModule.PRICE_EPSILON) {
      return {
        ok: false,
        ...this.makerCapRejection(
          candidate.ok ? "maker-capture-book-drift" : `maker-capture-${candidate.reason}`,
        ),
      };
    }
    return {
      ok: true,
      proof: {
        ...buildMakerCaptureBookDecisionProof({
          evaluatedAtMs: Date.now(),
          entry,
          tickSize: cmd.tickSize,
          predecessorPrice: context.predecessor.price,
          predecessorRemainingShares: context.usage.predecessorRemainingShares,
          rootNotionalUsdc: context.usage.rootNotionalUsdc,
          chainFilledUsdc: context.usage.chainFilledUsdc,
          originalSuggestedPrice: context.origin.originalSuggestedPrice,
          entryPriceCeiling: context.origin.entryPriceCeiling!,
          candidate,
          replacementSize: cmd.size,
          minOrderSize: entry.book.minOrderSize ?? null,
          policySchemaVersion: context.policySchemaVersion,
          policyControlRevision: context.policyControlRevision,
          activatedAtUtc: context.activatedAtUtc,
          expiresAtUtc: context.expiresAtUtc,
        }),
        childOrderId: String(context.intent.childOrderId),
        clientOrderId: String(cmd.clientOrderId),
      },
    };
  }

  private captureRootWindowMatches(
    root: Order,
    activatedAtUtc: string,
    expiresAtUtc: string,
  ): boolean {
    const value = root.metadata?.makerMicroLiveLifecycle;
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).activatedAtUtc === activatedAtUtc &&
      (value as Record<string, unknown>).expiresAtUtc === expiresAtUtc
    );
  }

  private makerBuyLiveRejection(
    cmd: PlaceOrderCommand,
    notional: number,
  ): { reason: string; code: ExchangeErrorCode } | null {
    if (!(cmd.entryStyle === "maker" && cmd.side === "buy")) return null;

    if (this.deps.makerBuyFastCancel?.isLatched()) {
      return { reason: "maker-fast-cancel-active", code: ExchangeErrorCode.LivePolicyBlocked };
    }

    const makerPolicy = this.deps.executionPolicy?.()?.makerEntry;
    if (!makerPolicy || makerPolicy.mode !== "micro_live") {
      return { reason: "maker-mode-inactive", code: ExchangeErrorCode.LivePolicyBlocked };
    }

    if (!isMakerMicroLiveWindowActive(makerPolicy.microLiveWindow, Date.now())) {
      return { reason: "maker-micro-window-inactive", code: ExchangeErrorCode.LivePolicyBlocked };
    }

    if (
      !isMakerMicroLiveOrderAuthorized(
        makerPolicy,
        {
          conditionId: cmd.conditionId,
          source: cmd.source,
          side: cmd.side,
          entryStyle: cmd.entryStyle,
          postOnly: cmd.postOnly,
          decisionRuleId: cmd.decisionRuleId,
          signalReason: cmd.signalReason,
          signalTimestamp: cmd.signalTimestamp,
        },
        Date.now(),
      )
    ) {
      return { reason: "maker-mode-inactive", code: ExchangeErrorCode.LivePolicyBlocked };
    }

    if (makerPolicy.microMaxOrderUsdc > 0 && notional > makerPolicy.microMaxOrderUsdc) {
      return {
        reason: "maker-micro-order-cap-exceeded",
        code: ExchangeErrorCode.LivePolicyBlocked,
      };
    }

    if (makerPolicy.microMaxOpenUsdc > 0) {
      // Dust-inclusive maker exposure (Fix #4): a maker BUY that fills and then
      // drops below the sellable minimum becomes "dust", not "closed" — it is
      // still real, unrealized maker exposure and must count toward the cap.
      // findDust() and findOpenByEntryStyle() are disjoint by status, so no
      // dedup is needed when concatenating them.
      const makerPositions = this.deps.positionRepo
        ? [
            ...this.deps.positionRepo.findOpenByEntryStyle("maker"),
            ...this.deps.positionRepo.findDust().filter((p) => p.entryStyle === "maker"),
          ]
        : [];
      const openPositionUsdc = this.deps.positionRepo
        ? computeMakerOpenPositionUsdc(makerPositions)
        : 0;
      // Exclude THIS command's own reservation (if already reserved at a submit
      // site) and always add its CURRENT `notional` — so a post-admission upward
      // tick re-snap counts at the final notional, not the stale reserved one.
      const persistedOpenOrders = this.deps.orderRepo
        .findOpen()
        .filter((order) => order.clientOrderId !== cmd.clientOrderId);
      const otherReservations = this.otherUnpersistedReservations(cmd, persistedOpenOrders);
      const pendingUsdc = computeMakerPendingReservationUsdc(otherReservations);
      const makerOpenUsdc =
        computeMakerOpenOrderUsdc(persistedOpenOrders, this.deps.fillRepo) +
        openPositionUsdc +
        pendingUsdc +
        notional;
      if (makerOpenUsdc > makerPolicy.microMaxOpenUsdc) {
        return {
          reason: "maker-micro-open-cap-exceeded",
          code: ExchangeErrorCode.LivePolicyBlocked,
        };
      }
    }

    const cumulativeRejection = this.makerCumulativeCapRejection(
      cmd,
      notional,
      makerPolicy.microLiveWindow,
    );
    if (cumulativeRejection) return cumulativeRejection;

    return null;
  }

  private makerCumulativeCapRejection(
    cmd: PlaceOrderCommand,
    notional: number,
    window: MakerMicroLiveWindow | undefined,
  ): { reason: string; code: ExchangeErrorCode } | null {
    if (window === undefined) return null;
    if (!this.deps.orderRepo.getMakerBuyWindowUsage) {
      return {
        reason: "maker-micro-cumulative-cap-unavailable",
        code: ExchangeErrorCode.LivePolicyBlocked,
      };
    }
    const persistedOpenOrders = this.deps.orderRepo
      .findOpen()
      .filter((order) => order.clientOrderId !== cmd.clientOrderId);
    const otherReservations = this.otherUnpersistedReservations(cmd, persistedOpenOrders);
    const makerReservations = otherReservations.filter(
      (reservation) => reservation.side === "buy" && reservation.entryStyle === "maker",
    );
    const pendingUsdc = computeMakerPendingReservationUsdc(makerReservations);
    const usage = this.deps.orderRepo.getMakerBuyWindowUsage(
      window.activatedAtUtc,
      window.expiresAtUtc,
      String(cmd.conditionId),
      String(cmd.clientOrderId),
    );
    const commitmentIncrement = this.isMakerCaptureReplacement(cmd) ? 0 : notional;
    if (
      usage.committedUsdc + pendingUsdc + commitmentIncrement >
      window.maxCumulativeAcceptedPendingUsdc
    ) {
      return this.makerCapRejection("maker-micro-cumulative-cap-exceeded");
    }

    const conditionPendingUsdc = computeMakerPendingReservationUsdc(
      makerReservations.filter(
        (reservation) => String(reservation.conditionId) === String(cmd.conditionId),
      ),
    );
    if (
      window.maxCumulativeAcceptedPendingUsdcPerCondition !== undefined &&
      usage.conditionCommittedUsdc + conditionPendingUsdc + commitmentIncrement >
        window.maxCumulativeAcceptedPendingUsdcPerCondition
    ) {
      return this.makerCapRejection("maker-micro-condition-cap-exceeded");
    }

    if (window.maxDistinctAcceptedConditions !== undefined) {
      const conditions = new Set(usage.committedConditionIds);
      for (const reservation of makerReservations) conditions.add(String(reservation.conditionId));
      conditions.add(String(cmd.conditionId));
      if (conditions.size > window.maxDistinctAcceptedConditions) {
        return this.makerCapRejection("maker-micro-distinct-condition-cap-exceeded");
      }
    }

    const remainingOtherOpenUsdc = computeMakerOpenOrderUsdc(
      persistedOpenOrders,
      this.deps.fillRepo,
    );
    if (
      window.maxCumulativeFilledUsdc !== undefined &&
      usage.filledUsdc + remainingOtherOpenUsdc + pendingUsdc + notional >
        window.maxCumulativeFilledUsdc
    ) {
      return this.makerCapRejection("maker-micro-filled-cap-exceeded");
    }
    return null;
  }

  private makerCapRejection(reason: string): { reason: string; code: ExchangeErrorCode } {
    return { reason, code: ExchangeErrorCode.LivePolicyBlocked };
  }

  private otherUnpersistedReservations(
    cmd: PlaceOrderCommand,
    persistedOpenOrders: readonly Order[],
  ): PendingReservation[] {
    const persistedClientOrderIds = new Set(
      persistedOpenOrders.map((order) => String(order.clientOrderId)),
    );
    return [...this.pendingReservations]
      .filter(([commandId]) => commandId !== String(cmd.commandId))
      .map(([, reservation]) => reservation)
      .filter(
        (reservation) =>
          String(reservation.clientOrderId) !== String(cmd.clientOrderId) &&
          !persistedClientOrderIds.has(String(reservation.clientOrderId)),
      );
  }

  // ─── Place order handler ──────────────────────────────────────────────

  private async handlePlace(cmd: PlaceOrderCommand, recoveryOnly = false): Promise<void> {
    const recoveryAuthorized =
      recoveryOnly && this.activeExitRecoveryClientIds.has(String(cmd.clientOrderId));
    if (this.deps.runtimeControl?.isPaused() && !recoveryAuthorized) {
      this.log.warn({ commandId: cmd.commandId }, "order rejected — runtime paused");
      await this.rejectOrder(cmd, "runtime-paused", ExchangeErrorCode.RuntimePaused);
      return;
    }

    // Finding 6: hard startup fence — refuse EVERY placement until the startup
    // transitions are seeded, independent of pause (the command-poller can resume
    // during supervisor.start(), before seeding).
    if (this.startupFenceActive) {
      this.log.warn({ commandId: cmd.commandId }, "order rejected — startup fence active");
      await this.rejectOrder(cmd, "startup-fence-active", ExchangeErrorCode.LivePolicyBlocked);
      return;
    }

    // Market active check: reject orders on deactivated/resolved markets
    const market = this.deps.marketRepo.findByTokenId(cmd.tokenId);
    if (market && !market.active) {
      this.log.warn(
        { commandId: cmd.commandId, tokenId: cmd.tokenId },
        "order rejected — market inactive",
      );
      await this.rejectOrder(cmd, "market-inactive", ExchangeErrorCode.MarketInactive);
      return;
    }

    const invalidPriceRejection = this.getInvalidPriceRejection(cmd);
    if (invalidPriceRejection) {
      this.log.warn(
        {
          commandId: cmd.commandId,
          tokenId: cmd.tokenId,
          side: cmd.side,
          price: cmd.price,
          tickSize: invalidPriceRejection.tickSize,
          minPrice: invalidPriceRejection.minPrice,
          maxPrice: invalidPriceRejection.maxPrice,
          validationReason: invalidPriceRejection.reason,
        },
        "order rejected — invalid execution price",
      );
      await this.rejectOrder(cmd, "invalid-order-price", ExchangeErrorCode.InvalidPrice);
      return;
    }

    const captureRejection = this.makerCaptureRepriceRejection(cmd);
    if (captureRejection) {
      await this.rejectOrder(cmd, captureRejection.reason, captureRejection.code);
      return;
    }

    // Release A Phase 3: bounce-exclusivity / position-identity guard (admission).
    const exitOwnerRejAdmit = this.exitOwnerIdentityRejection(cmd);
    if (exitOwnerRejAdmit) {
      this.log.warn(
        {
          commandId: cmd.commandId,
          tokenId: cmd.tokenId,
          side: cmd.side,
          positionId: cmd.positionId ?? null,
          reason: exitOwnerRejAdmit.reason,
        },
        "order rejected — exit-owner/position-identity guard (admission)",
      );
      await this.rejectOrder(cmd, exitOwnerRejAdmit.reason, exitOwnerRejAdmit.code);
      return;
    }

    // Release A Phase 3 (P6): executor-owned per-token transition barrier. Opens
    // (if this BUY just exposed a stale/cross-cycle working SELL) or checks
    // (if the token is already draining) before anything else is admitted.
    const transitionRejAdmit = await this.transitionRejection(cmd);
    if (transitionRejAdmit) {
      this.log.warn(
        {
          commandId: cmd.commandId,
          tokenId: cmd.tokenId,
          side: cmd.side,
          positionId: cmd.positionId ?? null,
          reason: transitionRejAdmit.reason,
        },
        "order rejected — token transition draining (admission)",
      );
      await this.rejectOrder(cmd, transitionRejAdmit.reason, transitionRejAdmit.code);
      return;
    }

    const notional = cmd.price * cmd.size;

    // Computed early — reused by both the balance-block bypass and the
    // bounce-exit micro-cap bypass below (bounce-exit ladder redesign,
    // Phase 3 Codex fix): the BACKSTOP taker is exempt from both.
    const isBounceBackstop = isBounceForceExit({
      side: cmd.side,
      decisionRuleId: cmd.decisionRuleId ?? null,
    });

    // Release A Phase 3 (P7 — transactional B1): a bounce backstop must not place
    // while its cycle's resting BOUNCE_EXIT_TARGET rungs are still working. Preflight
    // the loss floor (HOLD without cancelling if the taker is below floor), else open
    // the P6 transition to cancel + CONFIRM the rungs and record a durable deferred
    // intent (`pendingBackstops`) — the executor itself places the reconciled residual
    // once the token barrier reaches quiescent (`placeDeferredBackstop`), never a
    // planner re-emission or a timer.
    if (isBounceBackstop) {
      const backstopRej = await this.openBackstopTransitionIfRungsResting(cmd);
      if (backstopRej) {
        this.log.warn(
          { commandId: cmd.commandId, tokenId: cmd.tokenId, reason: backstopRej.reason },
          "bounce backstop deferred — draining resting rungs / holding below floor",
        );
        await this.rejectOrder(cmd, backstopRej.reason, backstopRej.code);
        return;
      }
    }

    if (cmd.side === "buy" && this.deps.positionConcentration) {
      const executionPolicy = this.deps.executionPolicy?.() ?? DEFAULT_EXECUTION_POLICY;
      const concentrationDecision = this.deps.positionConcentration.evaluateBuy({
        tokenId: cmd.tokenId,
        conditionId: cmd.conditionId,
        candidateNotionalUsdc: notional,
        minExecutableNotionalUsdc: (this.resolveCommandMinOrderSize(cmd) ?? 0) * cmd.price,
        policy: executionPolicy.positionConcentration,
        stage: "execution",
        signalReason: cmd.signalReason,
        decisionRuleId: cmd.decisionRuleId ?? null,
      });
      if (concentrationDecision.action !== "allow") {
        this.log.warn(
          {
            commandId: cmd.commandId,
            tokenId: cmd.tokenId,
            reason: concentrationDecision.reason,
            action: concentrationDecision.action,
            notional,
            effectiveNotionalUsdc: concentrationDecision.effectiveNotionalUsdc,
            keyType: concentrationDecision.keyType,
          },
          "order rejected — position concentration cap exceeded",
        );
        await this.rejectOrder(
          cmd,
          `position-concentration-${concentrationDecision.reason}`,
          ExchangeErrorCode.LivePolicyBlocked,
        );
        return;
      }
    }

    // Live-lite order cap check (Layer 4). The BOUNCE_EXIT_BACKSTOP force-exit
    // is exempt (docs/plans/2026-07-16-bounce-exit-ladder-redesign.md, final
    // Codex fix): it must liquidate the whole residual position regardless of
    // notional, and this per-order envelope cap is bot-bookkeeping, not an
    // exchange-feasibility check — same bypass category as the GATE/bounce
    // micro-caps and balance-block further down in this method.
    if (this.deps.liveLiteGuard?.isActive && !isBounceBackstop) {
      if (!this.deps.liveLiteGuard.isOrderWithinCap(notional)) {
        this.log.warn(
          { commandId: cmd.commandId, notional },
          "order rejected — exceeds live-lite order cap",
        );
        await this.rejectOrder(
          cmd,
          "live-lite-order-cap-exceeded",
          ExchangeErrorCode.LiveLiteOrderCap,
        );
        return;
      }

      // Live-lite steady-state caps (ADR-009): runtime enforcement of the
      // same open-value + active-markets envelope that preflight checks at
      // startup. Only applied to BUY — SELL reduces exposure.
      if (cmd.side === "buy" && this.deps.positionRepo) {
        const totalExposureAfter = calculateTotalExposure(
          this.deps.positionRepo,
          this.deps.orderRepo,
          notional,
        );
        if (this.deps.liveLiteGuard.wouldExceedOpenValueCap(totalExposureAfter, 0)) {
          this.log.warn(
            { commandId: cmd.commandId, totalExposureAfter },
            "order rejected — exceeds live-lite open-value cap",
          );
          await this.rejectOrder(
            cmd,
            "live-lite-open-value-cap-exceeded",
            ExchangeErrorCode.LivePolicyBlocked,
          );
          return;
        }

        const openMarkets = countActiveOpenMarkets(this.deps.positionRepo);
        const wouldBeNewMarket = !openMarkets.has(String(cmd.tokenId));
        if (
          wouldBeNewMarket &&
          this.deps.liveLiteGuard.wouldExceedActiveMarketsCap(openMarkets.size, 1)
        ) {
          this.log.warn(
            { commandId: cmd.commandId, activeMarkets: openMarkets.size },
            "order rejected — exceeds live-lite active-markets cap",
          );
          await this.rejectOrder(
            cmd,
            "live-lite-active-markets-cap-exceeded",
            ExchangeErrorCode.LivePolicyBlocked,
          );
          return;
        }
      }
    }

    // Micro-live maker BUY cap: fail-closed defense-in-depth. A maker BUY whose
    // mode/whitelist/caps don't check out is now REJECTED here (not silently
    // skipped) — the same makerBuyLiveRejection validator runs again at both
    // exchange submit sites to close the TOCTOU window between admission and
    // submit (Fix #1+TOCTOU, docs/plans/2026-07-23-maker-rails-slice1-4a.md).
    const makerRej = this.makerBuyLiveRejection(cmd, notional);
    if (makerRej) {
      this.log.warn(
        { commandId: cmd.commandId, notional, reason: makerRej.reason },
        "maker BUY rejected at admission",
      );
      await this.rejectOrder(cmd, makerRej.reason, makerRej.code);
      return;
    }

    // Micro-live GATE BUY cap: defense-in-depth cap, mirrors the maker-BUY
    // per-order cap above (docs/plans/2026-07-15-gate-bounce-live-experiment.md,
    // Phase 4 / Codex C3). GATE has no open-exposure cap analog in policy —
    // only a per-order notional cap, so that's the only check here. Sizing
    // already clamps to this same cap in signal-to-order.ts; this is the
    // independent execution-side enforcement required by the plan.
    if (cmd.side === "buy" && cmd.decisionRuleId === GATE_ENTRY_RULE_ID) {
      const gatePolicy = this.deps.executionPolicy?.()?.gateEntry;
      if (
        gatePolicy &&
        gatePolicy.mode === "micro_live" &&
        gatePolicy.microMaxOrderUsdc > 0 &&
        notional > gatePolicy.microMaxOrderUsdc
      ) {
        this.log.warn(
          {
            commandId: cmd.commandId,
            notional,
            microMaxOrderUsdc: gatePolicy.microMaxOrderUsdc,
          },
          "GATE BUY rejected — exceeds microMaxOrderUsdc per-order cap",
        );
        await this.rejectOrder(
          cmd,
          "gate-micro-order-cap-exceeded",
          ExchangeErrorCode.LivePolicyBlocked,
        );
        return;
      }
    }

    // Bounce-exit ladder rung $ cap: defense-in-depth cap, mirrors the GATE
    // BUY / maker-BUY per-order caps above (docs/plans/2026-07-16-bounce-
    // exit-ladder-redesign.md, Phase 3 Codex fix). signal-to-order.ts already
    // clamps rung notional to bounceExit.microMaxOrderUsdc, but this is the
    // independent execution-side enforcement so a malformed/direct
    // PlaceOrderRequested can't place an over-cap rung. The BACKSTOP taker is
    // explicitly exempt — it liquidates whatever residual remains and must
    // not be capped like a resting rung. The Phase-3 "cleanup" rung (Codex C2
    // fix, docs/plans/2026-07-19-sellable-sizing-bounce-for-all.md) is
    // exempt for the same reason: it's deliberately sized to clear the
    // ladder's fill-aware uncommitted residual in one shot, and re-capping it
    // here would strand shares the same way the cleanup rung exists to
    // prevent (mirrors signal-to-order.ts's own cap-exemption check).
    if (
      cmd.side === "sell" &&
      cmd.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID &&
      !isBounceBackstop &&
      !this.isCleanupBounceRungCommand(cmd)
    ) {
      const bounceExitPolicy = this.deps.executionPolicy?.()?.bounceExit;
      if (
        bounceExitPolicy &&
        bounceExitPolicy.microMaxOrderUsdc > 0 &&
        notional > bounceExitPolicy.microMaxOrderUsdc
      ) {
        this.log.warn(
          {
            commandId: cmd.commandId,
            notional,
            microMaxOrderUsdc: bounceExitPolicy.microMaxOrderUsdc,
          },
          "BOUNCE_EXIT_TARGET rejected — exceeds microMaxOrderUsdc per-order cap",
        );
        await this.rejectOrder(
          cmd,
          "bounce-micro-order-cap-exceeded",
          ExchangeErrorCode.LivePolicyBlocked,
        );
        return;
      }
    }

    if (cmd.side !== "sell") {
      const minOrderSizeRejection = this.getMinOrderSizeRejection(cmd);
      if (minOrderSizeRejection) {
        this.log.warn(
          {
            commandId: cmd.commandId,
            tokenId: cmd.tokenId,
            side: cmd.side,
            originalSize: cmd.size,
            clampedSize: null,
            minOrderSize: minOrderSizeRejection.minOrderSize,
            positionSize: this.deps.positionRepo?.findByTokenId(cmd.tokenId)?.size ?? null,
            tickSize: cmd.tickSize,
            reason: "below_min_size",
            phase: "pre-clamp",
          },
          "order rejected — below exchange minimum size",
        );
        await this.rejectOrder(
          cmd,
          "exchange-min-order-size-rejected",
          ExchangeErrorCode.InvalidSize,
        );
        return;
      }
    }

    // Idempotency: skip already-processed commandId
    if (this.processedCommandIds.has(cmd.commandId)) {
      this.log.debug({ commandId: cmd.commandId }, "duplicate commandId — skipping");
      return;
    }

    // Deterministic clientOrderId reuse is unsafe even after terminal local rows:
    // CLOB may accept the resend while SQLite rejects the duplicate client ID.
    const existing = this.deps.orderRepo.findByClientOrderId(cmd.clientOrderId);
    if (existing) {
      await this.skipDuplicateClientOrderIdPreSubmit(cmd, existing);
      this.processedCommandIds.add(cmd.commandId);
      return;
    }

    this.processedCommandIds.add(cmd.commandId);
    this.processedCommandOrder.push(String(cmd.commandId));
    this.pruneProcessedCommandIds();

    // Balance-block check must run BEFORE sell replacement so a blocked token
    // does not get its existing exit SELL cancelled into a void: replacement
    // would cancel the live order then the new SELL would itself be rejected
    // by the same block, leaving no exit order on the book.
    //
    // Bounce-exit backstop force-exit (docs/plans/2026-07-16-bounce-exit-
    // ladder-redesign.md, Phase 3 Codex fix): signal-to-order.ts already
    // cancelled every resting BOUNCE_EXIT_TARGET rung before publishing this
    // taker command. If this balance-block rejected the backstop too, the
    // rungs would already be gone with no replacement exit order ever placed
    // — the residual position would be orphaned with no live exit at all.
    // The backstop must always proceed, consistent with the other bot-
    // bookkeeping bypasses guarded by isBounceForceExit.
    if (cmd.side === "sell" && !isBounceBackstop && this.isBalanceBlocked(cmd)) {
      this.recordInternalReservationReject("pending-wallet-sync");
      this.recordExecutionCapacityReject(cmd, "pending-wallet-sync");
      await this.rejectOrder(cmd, "pending-wallet-sync", ExchangeErrorCode.InsufficientBalance);
      return;
    }

    const postOnlyCross = this.getPostOnlyCrossPreSubmitSkip(cmd);
    if (postOnlyCross) {
      await this.skipPostOnlyCrossPreSubmit(cmd, postOnlyCross);
      return;
    }

    if (await this.skipGateOverCapIfNeeded(cmd)) {
      return;
    }

    if (await this.skipDuplicateBuyPreSubmitIfNeeded(cmd)) {
      return;
    }

    if (await this.deferBuyForTargetedCapacityReplacementIfNeeded(cmd)) {
      return;
    }

    if (await this.blockSellReplacementBelowExitLossFloor(cmd)) {
      return;
    }

    if (await this.deferSellReplacementIfNeeded(cmd)) {
      return;
    }

    const decision = this.getReservationDecision(cmd, notional);
    if (decision.kind === "reject") {
      this.recordInternalReservationReject(decision.reason);
      if (!decision.capacitySampleRecorded) {
        this.recordExecutionCapacityReject(cmd, decision.reason);
      }
      this.log.debug(decision.details, decision.message);
      await this.rejectOrder(
        cmd,
        decision.reason,
        decision.errorCode ?? ExchangeErrorCode.InsufficientBalance,
      );
      return;
    }

    let effectiveCmd = cmd;
    if (decision.kind === "clamp") {
      const clampedCmd: PlaceOrderCommand = { ...cmd, size: decision.newSize };
      const postClampMinCheck = this.getMinOrderSizeRejection(clampedCmd);
      if (postClampMinCheck) {
        this.recordInternalReservationReject("clamped-below-min-order-size");
        this.log.warn(
          {
            commandId: cmd.commandId,
            tokenId: cmd.tokenId,
            side: cmd.side,
            originalSize: cmd.size,
            clampedSize: decision.newSize,
            minOrderSize: postClampMinCheck.minOrderSize,
            positionSize: this.deps.positionRepo?.findByTokenId(cmd.tokenId)?.size ?? null,
            tickSize: cmd.tickSize,
            reason: "below_min_size",
            phase: "post-clamp",
          },
          "sell order rejected — clamped size below exchange minimum",
        );
        await this.rejectOrder(cmd, "clamped-below-min-order-size", ExchangeErrorCode.InvalidSize);
        return;
      }
      this.sellSizeClamps++;
      this.log.info(
        { commandId: cmd.commandId, ...decision.details },
        "sell order size clamped to available position (ADR-008)",
      );
      effectiveCmd = clampedCmd;
    }

    const reserveMakerRejection = this.makerBuyLiveRejection(
      effectiveCmd,
      effectiveCmd.price * effectiveCmd.size,
    );
    if (reserveMakerRejection) {
      await this.rejectOrder(
        effectiveCmd,
        reserveMakerRejection.reason,
        reserveMakerRejection.code,
      );
      return;
    }

    this.pendingReservations.set(String(effectiveCmd.commandId), {
      clientOrderId: effectiveCmd.clientOrderId,
      conditionId: effectiveCmd.conditionId,
      tokenId: effectiveCmd.tokenId,
      side: effectiveCmd.side,
      size: effectiveCmd.size,
      price: effectiveCmd.price,
      decisionRuleId: effectiveCmd.decisionRuleId,
      signalReason: effectiveCmd.signalReason,
      metadata: effectiveCmd.metadata,
      entryStyle: effectiveCmd.entryStyle ?? null,
    });
    this.acceptedCommandAt.set(String(effectiveCmd.commandId), Date.now());

    // P7 finding 3: track an admitted bounce rung as in-flight from the moment it's
    // accepted for dispatch — closes the "queued/executing but not yet persisted"
    // gap a persisted-orders-only check (`findCycleBounceRungs`) can't see, so a
    // backstop reaching the submit boundary at that exact moment isn't fooled into
    // thinking the cycle has no resting rung. Cleared in `executeCommand`'s finally.
    if (
      effectiveCmd.side === "sell" &&
      effectiveCmd.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID
    ) {
      this.inFlightBounceRungs.set(String(effectiveCmd.commandId), {
        tokenId: String(effectiveCmd.tokenId),
        positionId: String(effectiveCmd.positionId ?? null),
      });
    }

    await this.dispatchCommand(effectiveCmd, recoveryAuthorized);
  }

  makerBuyInFlightCount(): number {
    return [...this.pendingReservations.values()].filter(
      (reservation) => reservation.side === "buy" && reservation.entryStyle === "maker",
    ).length;
  }

  async authorizeResumeAfterStartupExitRecovery(): Promise<boolean> {
    let predecessors: Order[] = [];
    try {
      if (!this.deps.orderRepo.findStartupExitRecoveryBlocked) {
        throw new Error("startup exit-recovery blocker lookup is unavailable");
      }
      predecessors = this.deps.orderRepo.findStartupExitRecoveryBlocked();
      for (const predecessor of predecessors) {
        if (
          predecessor.metadata?.startupExitRecoveryBlockV1 !== undefined &&
          !parseStartupExitRecoveryBlockV1(predecessor)
        ) {
          throw new Error("startup exit-recovery marker is invalid");
        }
        const fence = parseExitRecoveryFenceV1(predecessor);
        if (fence?.phase !== "complete") {
          throw new Error("startup exit-recovery fence is incomplete");
        }
        this.requireRecoveryPredecessor(predecessor, true);
        const child = this.deps.orderRepo.findByClientOrderId(fence.childClientOrderId);
        if (!child) throw new Error("startup exit-recovery child is missing");
        await this.verifyRecoveryChild(predecessor, child, fence, true);
      }
      return true;
    } catch (err) {
      this.log.warn(
        { err, blockerCount: predecessors.length },
        "resume blocked — startup missing-bounce recovery coverage is not proven",
      );
      return false;
    }
  }

  async recoverMissingBounceExit(
    predecessorOrderId: OrderId,
    operatorCommandId: number,
  ): Promise<MissingBounceExitRecoveryResult> {
    if (!this.started || this.startupFenceActive) return { status: "deferred" };
    const key = String(predecessorOrderId);
    if (this.exitRecoveriesInFlight.has(key)) return { status: "deferred" };
    this.exitRecoveriesInFlight.add(key);
    try {
      return await this.runMissingBounceExitRecovery(predecessorOrderId, operatorCommandId);
    } catch (err) {
      this.deps.pauseLiveTrading?.();
      const predecessor = this.deps.orderRepo.findById(predecessorOrderId);
      const fence = predecessor ? parseExitRecoveryFenceV1(predecessor) : null;
      this.log.error(
        { err, predecessorOrderId: key, operatorCommandId },
        "missing bounce-exit recovery failed — runtime remains paused",
      );
      return { status: fence ? "deferred" : "rejected" };
    } finally {
      this.exitRecoveriesInFlight.delete(key);
    }
  }

  private async runMissingBounceExitRecovery(
    predecessorOrderId: OrderId,
    operatorCommandId: number,
  ): Promise<MissingBounceExitRecoveryResult> {
    this.assertRecoveryRuntimeClosed();
    let predecessor = this.deps.orderRepo.findById(predecessorOrderId);
    if (!predecessor) throw new Error("recovery predecessor not found");
    let fence = parseExitRecoveryFenceV1(predecessor);
    if (predecessor.metadata?.exitRecoveryFenceV1 !== undefined && !fence) {
      throw new Error("invalid existing exitRecoveryFenceV1");
    }
    predecessor = this.requireRecoveryPredecessor(predecessor, fence !== null);

    const initialProof = await this.readRecoverySnapshot(predecessor);
    const residualShares = this.resolveRecoveryResidual(predecessor, initialProof.fills);
    if (fence && !this.sameShares(fence.residualShares, residualShares)) {
      throw new Error("recovery residual changed after fence creation");
    }
    const childClientOrderId = buildClientOrderId({
      signalId: `exit-recovery:${String(predecessor.orderId)}`,
      tokenId: predecessor.tokenId,
      side: "sell",
    });
    if (fence && fence.childClientOrderId !== String(childClientOrderId)) {
      throw new Error("recovery child client id mismatch");
    }
    if (!fence) {
      this.assertRecoveryCommandSafe(
        this.buildRecoveryCommand(predecessor, residualShares, childClientOrderId),
      );
      this.assertPredecessorAbsent(initialProof, predecessor);
      this.assertAssetOpenOrders(initialProof, predecessor.tokenId, null);
      fence = this.newRecoveryFence(
        predecessor,
        operatorCommandId,
        residualShares,
        String(childClientOrderId),
        initialProof,
      );
      predecessor = this.casRecoveryFence(predecessor, fence);
    }

    if (fence.phase === "prepared") {
      const repeatedProof = await this.readRecoverySnapshot(predecessor);
      this.assertPredecessorAbsent(repeatedProof, predecessor);
      this.assertAssetOpenOrders(repeatedProof, predecessor.tokenId, null);
      const postFence = await this.readRecoverySnapshot(predecessor);
      this.assertPredecessorAbsent(postFence, predecessor);
      this.assertAssetOpenOrders(postFence, predecessor.tokenId, null);
      fence = {
        ...fence,
        phase: "fenced",
        fenceCompletedAt: new Date().toISOString(),
        postFenceOpenSnapshotHash: postFence.openHash,
        postFenceFillSnapshotHash: postFence.fillHash,
        postFenceFillWatermark: postFence.fillWatermark,
      };
      predecessor = this.casRecoveryFence(predecessor, fence);
      this.refreshExchangeSellSnapshot(postFence.openOrders);
    }

    if (fence.phase === "fenced") {
      const postFence = await this.readRecoverySnapshot(predecessor);
      this.assertPredecessorAbsent(postFence, predecessor);
      this.assertAssetOpenOrders(postFence, predecessor.tokenId, null);
      fence = { ...fence, phase: "child_pending" };
      predecessor = this.casRecoveryFence(predecessor, fence);
    }

    this.assertRecoveryRuntimeClosed();
    let child = this.deps.orderRepo.findByClientOrderId(fence.childClientOrderId);
    const command = this.buildRecoveryCommand(predecessor, residualShares, childClientOrderId);
    try {
      if (!child) {
        const beforeChild = await this.readRecoverySnapshot(predecessor);
        this.assertPredecessorAbsent(beforeChild, predecessor);
        this.assertAssetOpenOrders(beforeChild, predecessor.tokenId, null);
        if (
          !this.sameShares(
            this.resolveRecoveryResidual(predecessor, beforeChild.fills),
            residualShares,
          )
        ) {
          throw new Error("recovery residual changed before placement");
        }
        this.assertRecoveryCommandSafe(command);
        this.activeExitRecoveryClientIds.add(fence.childClientOrderId);
        try {
          await this.handlePlace(command, true);
        } finally {
          this.activeExitRecoveryClientIds.delete(fence.childClientOrderId);
        }
        child = this.deps.orderRepo.findByClientOrderId(fence.childClientOrderId);
      } else if (child.status === "pending" || child.status === "rejected") {
        child = await this.resumeAmbiguousRecoveryChild(predecessor, child, fence, command);
      }
      if (!child) throw new Error("recovery child did not persist");

      const completedAt = await this.verifyRecoveryChild(predecessor, child, fence);
      if (fence.phase !== "complete") {
        fence = { ...fence, phase: "complete", completedAt, childOrderId: String(child.orderId) };
        this.casRecoveryFence(predecessor, fence, true);
      }
      return { status: "applied", completedAt };
    } catch (error) {
      const submitted = this.recoverySubmissionAttempts.has(fence.childClientOrderId);
      child ??= this.deps.orderRepo.findByClientOrderId(fence.childClientOrderId);
      if (child && (submitted || error instanceof UnsafeRecoveryChildError)) {
        await this.cleanupRecoveryChild(predecessor, fence);
      }
      throw error;
    } finally {
      this.recoverySubmissionAttempts.delete(fence.childClientOrderId);
    }
  }

  private assertRecoveryRuntimeClosed(): void {
    if (this.deps.runtimeMode !== "live-lite") {
      throw new Error("missing bounce-exit recovery is live-lite only");
    }
    const runtimeState = this.deps.controlDb
      ?.prepare("SELECT runtime_status, paused FROM runtime_control_state WHERE id = 1")
      .get() as { runtime_status?: unknown; paused?: unknown } | undefined;
    if (
      !this.deps.runtimeControl?.isPaused() ||
      runtimeState?.runtime_status !== "ready_paused" ||
      runtimeState.paused !== 1
    ) {
      throw new Error("runtime is not READY_PAUSED");
    }
    if ((this.deps.executionPolicy?.() ?? DEFAULT_EXECUTION_POLICY).makerEntry.mode !== "off") {
      throw new Error("maker entry mode is not off");
    }
    if (!this.deps.gateway.getOpenOrdersResult || !this.deps.gateway.getFillsResult) {
      throw new Error("reliable exchange snapshots are unavailable");
    }
    if (!this.deps.gateway.getOrderResult) {
      throw new Error("exact order capability is unavailable");
    }
    if (!this.deps.orderRepo.updateMetadataIfUnchanged) {
      throw new Error("order metadata CAS is unavailable");
    }
  }

  private requireRecoveryPredecessor(order: Order, fenced: boolean): Order {
    const working =
      order.status === "pending" || order.status === "open" || order.status === "partially-filled";
    const markerBackedTerminal =
      parseStartupExitRecoveryBlockV1(order) !== null &&
      (order.status === "cancelled" || order.status === "rejected");
    const fencedTerminal = fenced && (order.status === "cancelled" || order.status === "rejected");
    if (
      order.side !== "sell" ||
      order.decisionRuleId !== BOUNCE_EXIT_TARGET_RULE_ID ||
      order.postOnly !== true ||
      (!working && !fencedTerminal && !markerBackedTerminal) ||
      !order.exchangeOrderId ||
      !order.positionId ||
      !order.metadata?.bounceRung
    ) {
      throw new Error("recovery predecessor is not a working post-only bounce rung");
    }
    return order;
  }

  private resolveRecoveryResidual(
    predecessor: Order,
    exchangeFills: readonly ExchangeFill[],
  ): number {
    const positions = this.deps.positionRepo?.findActiveByTokenId(predecessor.tokenId) ?? [];
    if (
      positions.length !== 1 ||
      String(positions[0]!.positionId) !== String(predecessor.positionId) ||
      String(positions[0]!.conditionId) !== String(predecessor.conditionId)
    ) {
      throw new Error("recovery predecessor has no single matching active position");
    }
    if (this.deps.fillRepo.findByOrderId(predecessor.orderId).length !== 0) {
      throw new Error("recovery predecessor has linked local fills");
    }
    const lots = this.deps.inventoryLotRepo?.findOpen(positions[0]!.positionId) ?? [];
    const lotResidual = lots.reduce((sum, lot) => sum + lot.remainingSize, 0);
    const walletResidual = this.deps.exchangeStateStore?.getWalletPositionSize(predecessor.tokenId);
    const walletCapturedAt = this.deps.exchangeStateStore?.getWalletPositionCapturedAt(
      predecessor.tokenId,
    );
    if (
      walletResidual === null ||
      walletResidual === undefined ||
      walletCapturedAt === null ||
      walletCapturedAt === undefined
    ) {
      throw new Error("fresh recovery wallet snapshot is unavailable");
    }
    const latestTokenFillAt = exchangeFills
      .filter((fill) => String(fill.tokenId) === String(predecessor.tokenId))
      .reduce((latest, fill) => Math.max(latest, fill.timestamp), 0);
    if (walletCapturedAt < latestTokenFillAt) {
      throw new Error("recovery wallet snapshot predates the latest token fill");
    }
    const values = [positions[0]!.size, lotResidual, walletResidual];
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error("recovery residual evidence is unavailable");
    }
    if (values.some((value) => !this.sameShares(value, values[0]!))) {
      throw new Error("position/FIFO/wallet residual mismatch");
    }
    if (
      !Number.isFinite(predecessor.size) ||
      predecessor.size <= 0 ||
      predecessor.size - values[0]! > ExecutionModule.SIZE_EPSILON_SHARES
    ) {
      throw new Error("recovery predecessor size exceeds active residual");
    }
    return values[0]!;
  }

  private buildRecoveryCommand(
    predecessor: Order,
    size: number,
    clientOrderId: PlaceOrderCommand["clientOrderId"],
  ): PlaceOrderCommand {
    const market = this.deps.marketRepo.findByTokenId(predecessor.tokenId);
    if (
      !market ||
      !market.active ||
      String(market.conditionId) !== String(predecessor.conditionId)
    ) {
      throw new Error("recovery market is not active or does not match predecessor");
    }
    const metadata = { ...(predecessor.metadata ?? {}) } as Record<string, unknown>;
    delete metadata.exitRecoveryFenceV1;
    delete metadata.startupExitRecoveryBlockV1;
    return {
      type: "PlaceOrderCommand",
      commandId: createCommandId(`exit-recovery:${String(predecessor.orderId)}`),
      clientOrderId,
      source: "operator",
      tokenId: predecessor.tokenId,
      conditionId: predecessor.conditionId,
      positionId: predecessor.positionId ?? null,
      side: "sell",
      size,
      price: predecessor.price,
      postOnly: true,
      orderType: predecessor.orderType,
      tickSize: market.tickSize,
      negRisk: market.negRisk,
      sequenceInTick: 0,
      signalReason: predecessor.signalReason,
      signalId: predecessor.signalId ?? null,
      decisionRuleId: predecessor.decisionRuleId ?? null,
      signalTimestamp: predecessor.signalTimestamp ?? null,
      metadata: {
        ...metadata,
        exitRecoveryChildV1: {
          version: 1,
          predecessorOrderId: String(predecessor.orderId),
          childClientOrderId: String(clientOrderId),
          coverage: "full_active_residual",
          predecessorShares: predecessor.size,
          residualShares: size,
        },
      },
    };
  }

  private assertRecoveryCommandSafe(cmd: PlaceOrderCommand): void {
    if (this.getInvalidPriceRejection(cmd)) throw new Error("recovery price is not executable");
    if (this.getSellPreSubmitMinOrderBlock(cmd))
      throw new Error("recovery residual is below minimum");
    if (this.exitOwnerIdentityRejection(cmd))
      throw new Error("recovery position ownership mismatch");
    if (this.isBalanceBlocked(cmd)) throw new Error("recovery token is balance-blocked");
    if (this.getNotAcceptingOrdersSkip(cmd))
      throw new Error("recovery market is not accepting orders");
    if (this.getPostOnlyCrossPreSubmitSkip(cmd)) throw new Error("recovery price would cross");
    if (this.evaluateSellExitLossFloor(cmd, cmd.price).block) {
      throw new Error("recovery price is below exit loss floor");
    }
    const maxNotional = (this.deps.executionPolicy?.() ?? DEFAULT_EXECUTION_POLICY).bounceExit
      .microMaxOrderUsdc;
    if (maxNotional > 0 && cmd.price * cmd.size > maxNotional) {
      throw new Error("recovery residual exceeds bounce micro order cap");
    }
    if (
      this.deps.liveLiteGuard?.isActive &&
      !this.deps.liveLiteGuard.isOrderWithinCap(cmd.price * cmd.size)
    ) {
      throw new Error("recovery residual exceeds live-lite order cap");
    }
  }

  private async assertRecoverySubmitBoundary(cmd: PlaceOrderCommand): Promise<void> {
    const marker = cmd.metadata?.exitRecoveryChildV1 as Record<string, unknown> | undefined;
    if (marker?.version !== 1 || typeof marker.predecessorOrderId !== "string") {
      throw new Error("recovery submit marker is invalid");
    }
    const predecessor = this.deps.orderRepo.findById(createOrderId(marker.predecessorOrderId));
    if (!predecessor) throw new Error("recovery submit predecessor is missing");
    const fence = parseExitRecoveryFenceV1(predecessor);
    if (!fence || fence.phase === "complete") throw new Error("recovery submit fence is invalid");
    this.requireRecoveryPredecessor(predecessor, true);
    this.assertRecoveryRuntimeClosed();
    const snapshot = await this.readRecoverySnapshot(predecessor);
    this.assertPredecessorAbsent(snapshot, predecessor);
    this.assertAssetOpenOrders(snapshot, predecessor.tokenId, null);
    const residual = this.resolveRecoveryResidual(predecessor, snapshot.fills);
    if (
      fence.childClientOrderId !== String(cmd.clientOrderId) ||
      fence.residualShares !== cmd.size ||
      marker.childClientOrderId !== fence.childClientOrderId ||
      marker.coverage !== "full_active_residual" ||
      marker.predecessorShares !== predecessor.size ||
      marker.residualShares !== fence.residualShares ||
      !this.sameShares(residual, cmd.size) ||
      String(cmd.tokenId) !== fence.tokenId ||
      String(cmd.conditionId) !== fence.conditionId ||
      String(cmd.positionId) !== fence.positionId ||
      cmd.decisionRuleId !== fence.decisionRuleId ||
      cmd.side !== "sell" ||
      cmd.postOnly !== true ||
      cmd.orderType !== predecessor.orderType ||
      cmd.price !== predecessor.price ||
      canonicalRecoveryMetadata(cmd.metadata?.bounceRung) !== fence.bounceRungJson
    ) {
      throw new Error("recovery submit command identity mismatch");
    }
    this.assertRecoveryCommandSafe(cmd);
  }

  private async readRecoverySnapshot(predecessor: Order): Promise<ExitRecoverySnapshot> {
    const [openResult, fillResult, exactResult] = await Promise.all([
      this.deps.gateway.getOpenOrdersResult!(),
      this.deps.gateway.getFillsResult!(0),
      this.deps.gateway.getOrderResult!(predecessor.exchangeOrderId!),
    ]);
    if (!openResult.ok || !fillResult.ok || !exactResult.ok) {
      throw new Error("reliable recovery snapshot failed");
    }
    return {
      openOrders: openResult.data,
      fills: fillResult.data,
      exactPredecessor: exactResult.data,
      openHash: hashOpenOrders(openResult.data),
      fillHash: hashFills(fillResult.data),
      fillWatermark: fillWatermark(fillResult.data),
    };
  }

  private assertPredecessorAbsent(snapshot: ExitRecoverySnapshot, predecessor: Order): void {
    const exact = snapshot.exactPredecessor;
    if (
      exact !== null &&
      !(
        exact.orderId === predecessor.exchangeOrderId &&
        String(exact.tokenId) === String(predecessor.tokenId) &&
        exact.side === "sell" &&
        this.sameShares(exact.price, predecessor.price) &&
        this.sameShares(exact.sizeTotal, predecessor.size) &&
        this.sameShares(exact.sizeFilled, 0) &&
        this.sameShares(exact.sizeRemaining, predecessor.size) &&
        (exact.status === "CANCELLED" || exact.status === "EXPIRED" || exact.status === "REJECTED")
      )
    ) {
      throw new Error("predecessor exact order reappeared or is not safely terminal");
    }
    if (snapshot.openOrders.some((order) => order.orderId === predecessor.exchangeOrderId)) {
      throw new Error("predecessor is present in open orders");
    }
    if (
      snapshot.fills.some(
        (fill) =>
          fill.orderId === predecessor.exchangeOrderId ||
          fill.clientOrderId === String(predecessor.clientOrderId),
      )
    ) {
      throw new Error("predecessor has linked exchange fills");
    }
    if (this.deps.fillRepo.findByOrderId(predecessor.orderId).length !== 0) {
      throw new Error("predecessor gained linked local fills");
    }
  }

  private assertAssetOpenOrders(
    snapshot: ExitRecoverySnapshot,
    tokenId: TokenId,
    allowedOrderId: string | null,
  ): void {
    const assetOrders = snapshot.openOrders.filter(
      (order) => String(order.tokenId) === String(tokenId),
    );
    if (allowedOrderId === null && assetOrders.length !== 0) {
      throw new Error("asset has another exact-open order");
    }
    if (
      allowedOrderId !== null &&
      (assetOrders.length !== 1 || assetOrders[0]!.orderId !== allowedOrderId)
    ) {
      throw new Error("asset open-order set does not contain exactly the recovery child");
    }
  }

  private newRecoveryFence(
    predecessor: Order,
    operatorCommandId: number,
    residualShares: number,
    childClientOrderId: string,
    snapshot: ExitRecoverySnapshot,
  ): ExitRecoveryFenceV1 {
    return {
      version: 1,
      action: "recover_missing_bounce_exit",
      operatorCommandId,
      predecessorOrderId: String(predecessor.orderId),
      tokenId: String(predecessor.tokenId),
      conditionId: String(predecessor.conditionId),
      positionId: String(predecessor.positionId),
      decisionRuleId: predecessor.decisionRuleId!,
      bounceRungJson: canonicalRecoveryMetadata(predecessor.metadata?.bounceRung),
      createdAt: new Date().toISOString(),
      preOpenSnapshotHash: snapshot.openHash,
      preFillSnapshotHash: snapshot.fillHash,
      preFillWatermark: snapshot.fillWatermark,
      residualShares,
      childClientOrderId,
      phase: "prepared",
    };
  }

  private casRecoveryFence(
    predecessor: Order,
    fence: ExitRecoveryFenceV1,
    clearStartupBlock = false,
  ): Order {
    const metadata: Record<string, unknown> = {
      ...(predecessor.metadata ?? {}),
      exitRecoveryFenceV1: fence,
    };
    if (clearStartupBlock) delete metadata.startupExitRecoveryBlockV1;
    const updated = this.deps.orderRepo.updateMetadataIfUnchanged!(
      predecessor.orderId,
      predecessor.metadata ?? null,
      metadata,
    );
    if (!updated) throw new Error("exit recovery metadata CAS failed");
    return updated;
  }

  private refreshExchangeSellSnapshot(openOrders: readonly ExchangeOrder[]): void {
    this.deps.exchangeStateStore?.updateExchangeSellOrders(
      openOrders
        .filter((order) => order.side === "sell")
        .map((order) => ({
          orderId: order.orderId,
          tokenId: order.tokenId,
          sizeRemaining: order.sizeRemaining,
        })),
    );
  }

  private async resumeAmbiguousRecoveryChild(
    predecessor: Order,
    child: Order,
    fence: ExitRecoveryFenceV1,
    command: PlaceOrderCommand,
  ): Promise<Order> {
    if (!child.exchangeOrderId) throw new Error("recovery child has no exact exchange identity");
    const [snapshot, exact] = await Promise.all([
      this.readRecoverySnapshot(predecessor),
      this.deps.gateway.getOrderResult!(child.exchangeOrderId),
    ]);
    if (!exact.ok) throw new Error("recovery child exact state is unreliable");
    this.assertRecoveryChildLocalIdentity(predecessor, child, fence, false);
    try {
      this.assertPredecessorAbsent(snapshot, predecessor);
    } catch (error) {
      throw new UnsafeRecoveryChildError(
        error instanceof Error ? error.message : "unsafe recovery predecessor snapshot",
      );
    }
    if (
      snapshot.fills.some(
        (fill) =>
          fill.orderId === child.exchangeOrderId ||
          fill.clientOrderId === String(child.clientOrderId),
      ) ||
      this.deps.fillRepo.findByOrderId(child.orderId).length !== 0
    ) {
      throw new UnsafeRecoveryChildError("ambiguous recovery child has linked fills");
    }
    if (exact.data?.status === "OPEN") {
      this.assertRecoveryChildSnapshotSafe(snapshot, predecessor, child.exchangeOrderId);
      if (child.status !== "open") {
        this.deps.orderRepo.updateStatus(child.orderId, "open", child.exchangeOrderId);
      }
      return this.deps.orderRepo.findByClientOrderId(fence.childClientOrderId)!;
    }
    if (exact.data?.status === "PARTIALLY_FILLED" || exact.data?.status === "FILLED") {
      throw new UnsafeRecoveryChildError("ambiguous recovery child may have filled");
    }
    if (exact.data && !this.sameShares(exact.data.sizeFilled, 0)) {
      throw new UnsafeRecoveryChildError("ambiguous recovery child has exact fill evidence");
    }
    this.assertRecoveryChildSnapshotSafe(snapshot, predecessor, null);
    if (
      !this.sameShares(
        this.resolveRecoveryResidual(predecessor, snapshot.fills),
        fence.residualShares,
      )
    ) {
      throw new Error("recovery residual changed before re-submission");
    }
    this.assertRecoveryCommandSafe(command);
    this.recoveryPendingReplacements.set(fence.childClientOrderId, child);
    this.activeExitRecoveryClientIds.add(fence.childClientOrderId);
    try {
      await this.dispatchCommand(command, true);
    } finally {
      this.activeExitRecoveryClientIds.delete(fence.childClientOrderId);
      this.recoveryPendingReplacements.delete(fence.childClientOrderId);
    }
    const replacement = this.deps.orderRepo.findByClientOrderId(fence.childClientOrderId);
    if (!replacement) throw new Error("recovery child replacement did not persist");
    return replacement;
  }

  private async cleanupRecoveryChild(
    predecessor: Order,
    fence: ExitRecoveryFenceV1,
  ): Promise<void> {
    const child = this.deps.orderRepo.findByClientOrderId(fence.childClientOrderId);
    if (!child?.exchangeOrderId) return;
    await this.deps.gateway.cancelOrder({ orderId: child.exchangeOrderId });
    const [open, fills, exact] = await Promise.all([
      this.deps.gateway.getOpenOrdersResult!(),
      this.deps.gateway.getFillsResult!(0),
      this.deps.gateway.getOrderResult!(child.exchangeOrderId),
    ]);
    if (!open.ok || !fills.ok || !exact.ok) throw new Error("recovery cleanup proof failed");
    await importExchangeFills(
      fills.data.filter(
        (fill) =>
          fill.orderId === child.exchangeOrderId ||
          fill.clientOrderId === String(child.clientOrderId),
      ),
      {
        fillRepo: this.deps.fillRepo,
        orderRepo: this.deps.orderRepo,
        bus: this.deps.bus,
        log: this.log,
        gateway: this.deps.gateway,
        fillCompletionTolerance: this.deps.fillCompletionTolerance,
      },
    );
    if (
      open.data.some((order) => order.orderId === child.exchangeOrderId) ||
      exact.data?.status === "OPEN" ||
      exact.data?.status === "PARTIALLY_FILLED"
    ) {
      throw new Error("recovery child remains exchange-open after cleanup");
    }
    if (this.deps.fillRepo.findByOrderId(child.orderId).length === 0) {
      this.deps.orderRepo.updateStatus(child.orderId, "rejected", child.exchangeOrderId);
    } else {
      await applyOrderVerdict({
        orderRepo: this.deps.orderRepo,
        fillRepo: this.deps.fillRepo,
        log: this.log,
        orderId: child.orderId,
        exchange: exact.data,
        fillCompletionTolerance: this.deps.fillCompletionTolerance,
      });
    }
    this.refreshExchangeSellSnapshot(open.data);
  }

  private assertRecoveryChildLocalIdentity(
    predecessor: Order,
    child: Order,
    fence: ExitRecoveryFenceV1,
    requireWorking: boolean,
  ): void {
    if (!isRecoveryChildLocalIdentity(predecessor, child, fence, requireWorking)) {
      throw new UnsafeRecoveryChildError("recovery child identity mismatch");
    }
  }

  private assertRecoveryChildSnapshotSafe(
    snapshot: ExitRecoverySnapshot,
    predecessor: Order,
    allowedChildOrderId: string | null,
  ): void {
    try {
      this.assertPredecessorAbsent(snapshot, predecessor);
      this.assertAssetOpenOrders(snapshot, predecessor.tokenId, allowedChildOrderId);
    } catch (error) {
      throw new UnsafeRecoveryChildError(
        error instanceof Error ? error.message : "unsafe recovery child snapshot",
      );
    }
  }

  private async verifyRecoveryChild(
    predecessor: Order,
    child: Order,
    fence: ExitRecoveryFenceV1,
    allowReconciledTerminal = false,
  ): Promise<string> {
    if (!child.exchangeOrderId) throw new Error("recovery child has no exact exchange identity");
    const [snapshot, exactChild] = await Promise.all([
      this.readRecoverySnapshot(predecessor),
      this.deps.gateway.getOrderResult!(child.exchangeOrderId),
    ]);
    if (!exactChild.ok) throw new Error("recovery child exact state is unreliable");
    this.assertRecoveryChildLocalIdentity(predecessor, child, fence, false);
    const siblings = this.deps.orderRepo.findByTokenId(predecessor.tokenId).filter((order) => {
      const marker = order.metadata?.exitRecoveryChildV1 as Record<string, unknown> | undefined;
      return marker?.predecessorOrderId === String(predecessor.orderId);
    });
    if (siblings.length !== 1 || siblings[0]!.orderId !== child.orderId) {
      throw new UnsafeRecoveryChildError("recovery sibling prevention failed");
    }
    const reconciledCoverage = allowReconciledTerminal
      ? this.reconciledRecoveryCoverage(predecessor, child, fence, snapshot, exactChild.data)
      : null;
    if (reconciledCoverage) {
      this.assertPredecessorAbsent(snapshot, predecessor);
      this.assertAssetOpenOrders(
        snapshot,
        predecessor.tokenId,
        reconciledCoverage === "partial" ? child.exchangeOrderId : null,
      );
      this.refreshExchangeSellSnapshot(snapshot.openOrders);
      return fence.completedAt ?? new Date().toISOString();
    }
    this.assertRecoveryChildLocalIdentity(predecessor, child, fence, true);
    if (
      !this.sameShares(
        this.resolveRecoveryResidual(predecessor, snapshot.fills),
        fence.residualShares,
      )
    ) {
      throw new UnsafeRecoveryChildError("recovery child no longer covers the active residual");
    }
    this.assertRecoveryChildSnapshotSafe(snapshot, predecessor, child.exchangeOrderId);
    if (
      exactChild.data === null ||
      exactChild.data.orderId !== child.exchangeOrderId ||
      String(exactChild.data.tokenId) !== String(child.tokenId) ||
      exactChild.data.side !== "sell" ||
      exactChild.data.status !== "OPEN" ||
      !this.sameShares(exactChild.data.price, predecessor.price) ||
      !this.sameShares(exactChild.data.sizeTotal, fence.residualShares) ||
      !this.sameShares(exactChild.data.sizeFilled, 0) ||
      !this.sameShares(exactChild.data.sizeRemaining, fence.residualShares) ||
      snapshot.fills.some(
        (fill) =>
          fill.orderId === child.exchangeOrderId ||
          fill.clientOrderId === String(child.clientOrderId),
      ) ||
      this.deps.fillRepo.findByOrderId(child.orderId).length !== 0
    ) {
      throw new UnsafeRecoveryChildError("recovery child is not exact-open with full fill parity");
    }
    this.refreshExchangeSellSnapshot(snapshot.openOrders);
    return fence.completedAt ?? new Date().toISOString();
  }

  private reconciledRecoveryCoverage(
    predecessor: Order,
    child: Order,
    fence: ExitRecoveryFenceV1,
    snapshot: ExitRecoverySnapshot,
    exactChild: ExchangeOrder | null,
  ): "partial" | "terminal" | null {
    if (
      !exactChild ||
      exactChild.orderId !== child.exchangeOrderId ||
      String(exactChild.tokenId) !== String(child.tokenId) ||
      exactChild.side !== "sell" ||
      !this.sameShares(exactChild.price, predecessor.price) ||
      !this.sameShares(exactChild.sizeTotal, fence.residualShares)
    ) {
      return null;
    }
    const positions = this.deps.positionRepo?.findActiveByTokenId(predecessor.tokenId) ?? [];
    const lots = this.deps.inventoryLotRepo?.findOpen(predecessor.positionId!) ?? [];
    const walletShares = this.deps.exchangeStateStore?.getWalletPositionSize(predecessor.tokenId);
    const walletCapturedAt = this.deps.exchangeStateStore?.getWalletPositionCapturedAt(
      predecessor.tokenId,
    );
    const authoritativeZero =
      walletShares == null
        ? this.deps.exchangeStateStore?.getAuthoritativeWalletZero(predecessor.tokenId)
        : null;
    const effectiveWalletShares = walletShares ?? authoritativeZero?.size;
    const effectiveWalletCapturedAt = walletCapturedAt ?? authoritativeZero?.capturedAt;
    const exchangeFills = snapshot.fills.filter(
      (fill) =>
        fill.orderId === child.exchangeOrderId ||
        fill.clientOrderId === String(child.clientOrderId),
    );
    const localFills = this.deps.fillRepo.findByOrderId(child.orderId);
    const unreconciledIds = new Set(
      this.deps.fillRepo.findUnreconciled().map((fill) => String(fill.fillId)),
    );
    const latestTokenFillAt = snapshot.fills
      .filter((fill) => String(fill.tokenId) === String(predecessor.tokenId))
      .reduce((latest, fill) => Math.max(latest, fill.timestamp), 0);
    const exchangeShares = exchangeFills.reduce((sum, fill) => sum + fill.size, 0);
    const localShares = localFills.reduce((sum, fill) => sum + fill.size, 0);
    const fillIds = (fills: readonly { fillId: string }[]) =>
      fills
        .map((fill) => String(fill.fillId))
        .sort()
        .join("\0");
    if (
      exchangeShares <= 0 ||
      !this.sameShares(exchangeShares, localShares) ||
      !this.sameShares(exchangeShares, exactChild.sizeFilled) ||
      !this.sameShares(exactChild.sizeRemaining, fence.residualShares - exchangeShares) ||
      fillIds(exchangeFills) !== fillIds(localFills) ||
      localFills.some((fill) => unreconciledIds.has(String(fill.fillId))) ||
      effectiveWalletShares == null ||
      effectiveWalletCapturedAt == null ||
      effectiveWalletCapturedAt < latestTokenFillAt
    ) {
      return null;
    }
    const fifoShares = lots.reduce((sum, lot) => sum + lot.remainingSize, 0);
    if (exactChild.status === "PARTIALLY_FILLED" && child.status === "partially-filled") {
      const position = positions[0];
      return positions.length === 1 &&
        String(position?.positionId) === String(predecessor.positionId) &&
        String(position?.conditionId) === String(predecessor.conditionId) &&
        this.sameShares(position?.size ?? NaN, exactChild.sizeRemaining) &&
        this.sameShares(fifoShares, exactChild.sizeRemaining) &&
        this.sameShares(effectiveWalletShares, exactChild.sizeRemaining)
        ? "partial"
        : null;
    }
    return child.status === "filled" &&
      (exactChild.status === "FILLED" ||
        exactChild.status === "CANCELLED" ||
        exactChild.status === "EXPIRED") &&
      this.sameShares(exactChild.sizeFilled, fence.residualShares) &&
      positions.length === 0 &&
      this.sameShares(fifoShares, 0) &&
      this.sameShares(effectiveWalletShares, 0)
      ? "terminal"
      : null;
  }

  private sameShares(left: number, right: number): boolean {
    return Math.abs(left - right) <= ExecutionModule.SIZE_EPSILON_SHARES;
  }

  // ─── Cancel order handler ─────────────────────────────────────────────

  private async handleCancel(cmd: CancelOrderCommand): Promise<void> {
    if (this.processedCommandIds.has(cmd.commandId)) {
      this.log.debug({ commandId: cmd.commandId }, "duplicate cancel commandId — skipping");
      return;
    }
    this.processedCommandIds.add(cmd.commandId);
    this.processedCommandOrder.push(String(cmd.commandId));
    this.pruneProcessedCommandIds();
    this.acceptedCommandAt.set(String(cmd.commandId), Date.now());

    await this.dispatchCommand(cmd);
  }

  // ─── Command dispatcher ───────────────────────────────────────────────

  /** Shared enqueue-or-execute path for both PlaceOrderCommand and CancelOrderCommand. */
  private dispatchCommand(
    cmd: PlaceOrderCommand | CancelOrderCommand,
    awaitCompletion = false,
  ): Promise<void> {
    this.incrementTokenInFlight(cmd);
    if (this.queue) {
      if (awaitCompletion) {
        return this.queue.enqueueAndWait(cmd).then((accepted) => {
          if (!accepted) this.unwindRefusedDispatch(cmd);
        });
      }
      if (!this.queue.enqueue(cmd)) this.unwindRefusedDispatch(cmd);
      return Promise.resolve();
    }
    // Without a queue this call IS the in-flight work, and `stop()` has no other handle on it: the
    // caller that awaits it is a bus handler the supervisor does not wait for. Untracked, `stop()`
    // declared the module drained while a command was mid-`executePlace` and bulk-released its
    // deferred idempotency mark — the reservation still live — which is the exact accounting the
    // deferred release exists to keep intact.
    // Claimed BEFORE `executeCommand` is invoked. It reaches a SYNCHRONOUS publish, and a handler on
    // that publish can call stop() from inside this very stack frame — a claim registered only after
    // the call RETURNS leaves that stop draining an empty set, declaring the module drained over a
    // command that is mid-flight, and bulk-releasing its idempotency mark while the reservation is
    // still live. That is the production defect, re-entered through the door.
    //
    // Never rejects: `drainGenerations` awaits these together, and one rejection would abandon the
    // wait and report a drain that never happened.
    let finished!: () => void;
    const claim = new Promise<void>((resolve) => (finished = resolve));
    this.directInFlight.add(claim);
    const running = this.executeCommand(cmd);
    void running.then(
      () => {
        this.directInFlight.delete(claim);
        finished();
      },
      () => {
        this.directInFlight.delete(claim);
        finished();
      },
    );
    return running;
  }

  /**
   * The queue refuses commands only after a shutdown, and it refuses them SILENTLY: the command
   * never reaches {@link executeCommand}, so its `finally` never runs. Everything admission
   * already recorded would then outlive the command — the idempotency mark most of all, which
   * for a deterministic retry id means the retry is swallowed for the life of the process (the
   * exact tight loop the deferred release exists to end), plus a reservation and an in-flight
   * slot that permanently shrink capacity. Nothing was submitted, so leave no trace.
   *
   * Deliberately NOT the full `executeCommand` unwind: no rung was ever persisted here, so there
   * is no cycle to connect a deferred backstop to.
   */
  private unwindRefusedDispatch(cmd: PlaceOrderCommand | CancelOrderCommand): void {
    const commandId = String(cmd.commandId);
    this.acceptedCommandAt.delete(commandId);
    if (cmd.type === "PlaceOrderCommand") {
      this.pendingReservations.delete(commandId);
      this.inFlightBounceRungs.delete(commandId);
      this.clearPendingDeferredSubmit(cmd);
    }
    this.decrementTokenInFlight(cmd);
    this.commandIdsPendingRelease.delete(commandId);
    this.releaseProcessedCommandId(commandId);
    this.maybeCloseTokenTransition(this.resolveCommandTokenId(cmd));
  }

  private async executeCommand(cmd: PlaceOrderCommand | CancelOrderCommand): Promise<void> {
    let failed = true;
    try {
      if (cmd.type === "PlaceOrderCommand") {
        await this.executePlace(cmd);
      } else {
        await this.executeCancel(cmd);
      }
      failed = false;
    } finally {
      if (cmd.type === "PlaceOrderCommand") {
        this.pendingReservations.delete(String(cmd.commandId));
        const wasBounceRung = this.inFlightBounceRungs.delete(String(cmd.commandId));
        // Finding 3: a just-finished in-flight rung connects to any deferred backstop
        // waiting on its cycle (opens the drain, or fires the backstop if it failed).
        if (wasBounceRung) {
          void this.connectPersistedRungToPendingBackstop(cmd).catch((err: unknown) => {
            this.log.error(
              { err, tokenId: String(cmd.tokenId) },
              "failed to connect persisted rung to pending backstop",
            );
          });
        }
        // Finding 1 (round 6-7): a deferred backstop submit has now resolved (dispatched
        // path). Clear the in-flight marker (accounting already happened at the gateway
        // boundary). Admission-stage rejects clear it via rejectOrder/publishOrderSkipped.
        this.clearPendingDeferredSubmit(cmd);
      }
      this.decrementTokenInFlight(cmd);
      this.recordExecutionLatency(cmd);
      // Release A Phase 3 (P6): the terminal-confirmation hooks
      // (`removeTransitionTargetIfTerminal`, fired from INSIDE `executeCancel`
      // for this very command) always run while this command still counts as
      // in-flight, so `maybeCloseTokenTransition`'s in-flight guard blocks
      // closing there even once the last target is gone. Re-check now, after
      // the decrement above, so a drain whose last target was confirmed by
      // THIS command's own cancel still closes instead of staying stuck open.
      this.maybeCloseTokenTransition(this.resolveCommandTokenId(cmd));
      // LAST: every other trace of this attempt (reservation, in-flight slot,
      // deferred-submit marker) is gone by now, so the identical retry this
      // release exists to admit cannot collide with its own predecessor.
      if (
        cmd.type === "PlaceOrderCommand" &&
        this.commandIdsPendingRelease.delete(String(cmd.commandId))
      ) {
        this.releaseProcessedCommandId(String(cmd.commandId));
      }
      const attempted = this.makerCaptureGatewayAttempts.delete(String(cmd.commandId));
      if (failed && cmd.type === "PlaceOrderCommand" && !attempted) {
        this.releaseFailedMakerCaptureCommand(cmd);
      }
    }
  }

  private recordExecutionLatency(cmd: PlaceOrderCommand | CancelOrderCommand): void {
    const key = String(cmd.commandId);
    const startedAt = this.acceptedCommandAt.get(key);
    if (startedAt == null) return;
    this.acceptedCommandAt.delete(key);

    const latencyMs = Date.now() - startedAt;
    if (cmd.type === "PlaceOrderCommand") {
      this.placeCompleted++;
      this.placeLatencyTotalMs += latencyMs;
    } else {
      this.cancelCompleted++;
      this.cancelLatencyTotalMs += latencyMs;
    }
  }

  // ─── Exit loss-floor gate (docs/plans/2026-07-20-exit-loss-floor.md) ──

  /**
   * Shared evaluator call for every sell-submit checkpoint: the two
   * authoritative ones (main submit and invalid-tick retry, both pass a
   * PlaceOrderCommand) plus the best-effort pre-cancel screen and the
   * PositionUpdated re-eval (Part 1/2 below, which pass an already-resting
   * Order). `Pick` keeps this structurally compatible with both shapes
   * without a translation layer — Order and PlaceOrderCommand both carry
   * `tokenId`/`postOnly`. Missing position/lots are NOT treated as "gate not
   * applicable" — they are passed through as missing inputs so the pure
   * evaluator fails CLOSED (blocks), per the plan.
   */
  /**
   * Per-share NON-underestimated exit fee at a submit price = platform fee +
   * additive CLOB-V2 builder fee (code-review 2026-07-20 finding: an under-
   * estimated fee can let a near-boundary dump pass, so this must be an UPPER
   * bound on what the exchange will actually deduct).
   *
   * Platform fee: empirically (verified live on clob.polymarket.com/markets,
   * 2026-07-20) the CLOB never supplies the `fd` object — only
   * `taker_base_fee=1000` → `{rate: 0.07, exponent: 1}`, so exponent<1 markets do
   * NOT exist here and `computePolymarketPlatformFeeRate` at exponent=1 is
   * authoritative. A maker (postOnly, and every RESTING sell — it fills as maker)
   * pays no platform taker fee.
   *
   * Builder fee: live-lite attaches a builder code and the builder rate is mutable
   * OUTSIDE this code, so we bound it by the protocol MAXIMA (0.5% maker / 1%
   * taker of notional = `rate × price` per share). Current prod builder rates are
   * 0, so this is a conservative over-estimate today — the safe direction.
   */
  private exitLossFloorFeePerShare(price: number, postOnly: boolean): number {
    const platformFee = postOnly
      ? 0
      : computePolymarketPlatformFeeRate({
          price,
          rate: POLYMARKET_CRYPTO_TAKER_FEE_RATE,
          exponent: 1,
        });
    const builderFeeRateMax = postOnly
      ? EXIT_LOSS_FLOOR_BUILDER_MAKER_FEE_MAX
      : EXIT_LOSS_FLOOR_BUILDER_TAKER_FEE_MAX;
    return platformFee + builderFeeRateMax * price;
  }

  /**
   * Max-lot exit loss-floor verdict for a SELL at `submittedPrice` (design:
   * research_plankton/exit_loss_floor_maxlot_decision_2026-07-20.md). Bounds the
   * realized loss by the position's most expensive remaining lot, so it needs no
   * sell size, competing-order set, priority, or exclusions and is safe under any
   * fill order / partial fill / concurrency. Fails CLOSED on missing/inconsistent
   * position or lot data.
   */
  private evaluateSellExitLossFloor(
    cmd: Pick<PlaceOrderCommand, "tokenId" | "postOnly">,
    submittedPrice: number,
  ): ExitLossFloorVerdict {
    const position = this.deps.positionRepo?.findByTokenId(cmd.tokenId) ?? null;
    const lots = position ? (this.deps.inventoryLotRepo?.findOpen(position.positionId) ?? []) : [];
    const policy = this.deps.executionPolicy?.() ?? DEFAULT_EXECUTION_POLICY;
    return evaluateExitLossFloor({
      submittedPrice,
      fifoLots: lots.map((lot) => ({
        remainingSize: lot.remainingSize,
        entryPrice: lot.entryPrice,
      })),
      positionSize: position?.size ?? null,
      positionCostBasisUsdc: position?.costBasisUsdc ?? null,
      estSellFeePerShare: this.exitLossFloorFeePerShare(submittedPrice, cmd.postOnly === true),
      maxExitLossFraction: policy.maxExitLossFraction,
    });
  }

  /**
   * Best-effort pre-cancel screen (docs/plans/2026-07-20-exit-loss-floor.md
   * §Phase 1 "Resolution (rev 5)", §Phase 4 checkpoint 1) — runs BEFORE
   * `deferSellReplacementIfNeeded` so a below-floor replacement never gets a
   * chance to cancel the safe resting order it would replace. NOT the
   * guarantee: the authoritative checkpoint inside `executePlace` (already
   * wired) is what actually blocks a bad submit. This screen only tries to
   * avoid the wasted (and observable) cancel-then-reject churn — so any
   * uncertainty here (no target, no position, ambiguous size) must fall
   * through to `deferSellReplacementIfNeeded` unchanged, never block on its
   * own authority. Returns true only when it confirmed a below-floor replace
   * and skipped it.
   */
  private async blockSellReplacementBelowExitLossFloor(cmd: PlaceOrderCommand): Promise<boolean> {
    const target = this.identifyReplacementCancelTarget(cmd);
    if (!target) return false;

    const prospectiveSize = this.computeProspectiveReplacementSellSize(cmd, target.orderId);
    if (prospectiveSize == null || prospectiveSize <= 0) return false;

    const verdict = this.evaluateSellExitLossFloor(cmd, cmd.price);
    // Only act on a CONFIRMED below-floor result. Every other reason
    // (invalid_submitted_price, invalid_position_size, insufficient_fifo_lots,
    // cost_inconsistent, ...) means the inputs were missing/inconsistent, not
    // that a loss was actually confirmed — best-effort means treating that
    // uncertainty as "let it flow to the authoritative gate", never a block.
    if (!verdict.block || verdict.reason !== "exit_loss_floor_blocked") return false;

    this.log.warn(
      {
        commandId: cmd.commandId,
        tokenId: cmd.tokenId,
        existingOrderId: String(target.orderId),
        submittedPrice: cmd.price,
        prospectiveReplacementSize: prospectiveSize,
      },
      "sell replacement skipped — prospective replacement below exit loss floor (pre-cancel screen)",
    );
    this.recordExitLossFloorCounter(verdict.reason, "pre-cancel-screen");
    await this.publishOrderSkipped(cmd, "exit_loss_floor_blocked", {
      exitLossFloorReason: verdict.reason,
      submittedPrice: cmd.price,
      effectiveSellShares: prospectiveSize,
      phase: "pre-cancel-screen",
      existingOrderId: String(target.orderId),
    });
    return true;
  }

  /**
   * Read-only mirror of `deferSellReplacementIfNeeded`'s target-selection
   * logic (same bypasses, same existingSells[0]/profileLadderReplacement
   * resolution — see ~:2472 and its existingSell derivation) — identifies
   * WHICH resting order that method would cancel, without any of its
   * side-effecting reject/lock/cancel decisions. Deliberately duplicated
   * rather than extracted into a shared helper: this is money-critical
   * cancellation-flow code, and refactoring the tested, authoritative
   * selector carries more regression risk than a dozen duplicated lines.
   * Returns null on any bypass/ambiguity — callers treat null as "uncertain,
   * let it flow to deferSellReplacementIfNeeded unchanged".
   */
  private identifyReplacementCancelTarget(cmd: PlaceOrderCommand): Order | null {
    if (cmd.side !== "sell") return null;
    if (
      isBounceForceExit({ side: cmd.side, decisionRuleId: cmd.decisionRuleId ?? null }) ||
      cmd.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID ||
      this.isSellReplacementSubmit(cmd)
    ) {
      return null;
    }
    const existingSells = this.findOpenSellOrdersForToken(cmd.tokenId, cmd.positionId ?? null);
    if (existingSells.length === 0) return null;
    const profileLadderOldOrderId = this.getProfileLadderReplacementOldOrderId(cmd);
    if (profileLadderOldOrderId == null) return existingSells[0] ?? null;
    return (
      existingSells.find((order) => orderMatchesOrderId(order, profileLadderOldOrderId)) ?? null
    );
  }

  /**
   * Prospective size of the replacement SELL that would follow cancelling
   * `excludeOrderId` — the reservation snapshot minus that one order (all
   * other local/pending/exchange-only reservations still count), clamped
   * against the wallet/local upper bound exactly like the authoritative
   * reservation clamp in `getReservationDecision`. Returns null when there is
   * no position to size against (uncertain — let the screen pass through).
   */
  private computeProspectiveReplacementSellSize(
    cmd: PlaceOrderCommand,
    excludeOrderId: OrderId,
  ): number | null {
    const position = this.deps.positionRepo?.findByTokenId(cmd.tokenId);
    if (!position) return null;
    const reservations = this.getReservationSnapshotExcludingOrder(cmd, excludeOrderId);
    const localReservedSell = getReservedSellSize(reservations, cmd.tokenId);
    const reservedSell = this.effectiveReservedSell(cmd.tokenId, localReservedSell);
    const upperBound = this.computeSellUpperBound(cmd.tokenId, position.size);
    const availableSize = upperBound - reservedSell;
    return Math.min(cmd.size, Math.max(0, availableSize));
  }

  private getReservationSnapshotExcludingOrder(
    cmd: PlaceOrderCommand,
    excludeOrderId: OrderId,
  ): ReservationSnapshot {
    const openOrders = this.excludeBounceTargetBeingReplaced(
      this.deps.orderRepo.findOpen(),
      cmd,
    ).filter((order) => order.orderId !== excludeOrderId);
    return buildReservationSnapshot(
      openOrders,
      this.deps.fillRepo,
      this.pendingReservations.values(),
    );
  }

  /**
   * PositionUpdated re-evaluation (docs/plans/2026-07-20-exit-loss-floor.md
   * §Phase 6): published AFTER the inventory module applies a fill, so lots
   * and cost basis here are already current. Unlike the best-effort pre-
   * cancel screen above, this re-eval is fully fail-closed — any `block`
   * result (any reason, not just a confirmed loss) cancels the resting SELL,
   * because cancelling is the SAFE direction here (leaves an unquoted
   * residual, never risks a dump) — the mirror image of the pre-cancel
   * screen's "never block on uncertainty" stance. Re-evaluates every open
   * SELL for the token; there is no prior-basis comparison.
   */
  private async handlePositionUpdated(payload: RuntimeEventMap["PositionUpdated"]): Promise<void> {
    // A scale-in that raised the max remaining lot can push a resting exit SELL
    // below the floor — re-check each of the token's resting SELLs independently.
    for (const order of this.findOpenSellOrdersForToken(payload.position.tokenId)) {
      await this.cancelRestingSellIfBelowFloor(order, "position-updated-reeval");
    }
  }

  /**
   * Per-order remaining (unfilled) share count. Mirrors the private
   * `getRemainingOrderSize` in reservation-utils.ts (not exported, and that
   * file is out of scope for this change) but only ever needs one order at a
   * time here, so the batched fill lookup used there isn't warranted.
   */
  private getRemainingOrderShares(order: Order): number {
    const filled = this.deps.fillRepo
      .findByOrderId(order.orderId)
      .reduce((sum, fill) => sum + fill.size, 0);
    return Math.max(0, order.size - filled);
  }

  private async requestExitLossFloorCancel(orderId: OrderId): Promise<void> {
    await this.publishManagedCancel(orderId, "exit_loss_floor");
  }

  private async publishManagedCancel(orderId: OrderId, reason: CancelOrderReason): Promise<void> {
    const now = Date.now();
    await this.deps.bus.publish("CancelOrderRequested", {
      command: {
        type: "CancelOrderCommand",
        commandId: createCommandId(
          `${reason}-${String(orderId)}-${now}-${Math.random().toString(36).slice(2)}`,
        ),
        orderId,
        reason,
      },
      timestamp: now,
    });
  }

  // ─── Place execution (gateway call) ──────────────────────────────────

  private async executePlace(cmd: PlaceOrderCommand): Promise<void> {
    const sellMinOrderBlock = this.getSellPreSubmitMinOrderBlock(cmd);
    if (sellMinOrderBlock) {
      if (sellMinOrderBlock.reason === SELL_RESIDUAL_UNKNOWN_MIN_ORDER_SIZE_REASON) {
        this.requestMinOrderSizeHydrationFor(String(cmd.tokenId), Date.now());
        // Only this reason releases: it is the one the hydration above is
        // actively repairing, so the identical retry is the whole point. The
        // other pre-submit blocks keep the idempotency mark.
        //
        // DEFERRED, not released here: this attempt still holds a reservation
        // (`pendingReservations`) and an in-flight token slot, both cleared only
        // by `executeCommand`'s `finally`. Releasing the mark now lets a
        // concurrent delivery of the SAME commandId past the idempotency check
        // while that accounting is still live; it is then rejected as
        // `reserved-token-limit` — a branch that does NOT release — and burns
        // the id for good, so the post-hydration retry is dropped as a
        // duplicate and the exit stays blocked. Release after the unwind.
        this.commandIdsPendingRelease.add(String(cmd.commandId));
      }
      this.recordInternalReservationReject(sellMinOrderBlock.reason);
      this.recordExecutionCapacityReject(cmd, sellMinOrderBlock.reason);
      this.log.warn(
        {
          commandId: cmd.commandId,
          tokenId: cmd.tokenId,
          conditionId: cmd.conditionId,
          side: cmd.side,
          size: cmd.size,
          price: cmd.price,
          minOrderSize: sellMinOrderBlock.minOrderSize,
          reason: sellMinOrderBlock.reason,
          phase: "pre-submit",
        },
        "sell order blocked before CLOB submit — residual below or missing exchange minimum",
      );
      await this.rejectOrder(cmd, sellMinOrderBlock.reason, ExchangeErrorCode.InvalidSize);
      return;
    }

    // Phase 3: suppress placement when the market is explicitly not accepting
    // orders (fail-open: unknown / absent from cache → proceed).
    // NEVER calls marketRepo.deactivate() — active=1 must be preserved for
    // open-position pricing regardless of transient liveness state.
    if (this.getNotAcceptingOrdersSkip(cmd)) {
      await this.skipNotAcceptingOrders(cmd);
      return;
    }

    const postOnlyCross = this.getPostOnlyCrossPreSubmitSkip(cmd);
    if (postOnlyCross) {
      await this.skipPostOnlyCrossPreSubmit(cmd, postOnlyCross);
      return;
    }

    // Phase 1: resolve authoritative CLOB tick at the order boundary (cached,
    // lazy). Falls back to cmd.tickSize on any lookup failure — never blocks.
    // tokenId is passed for the /tick-size last-resort fallback (step 3).
    const authTick = this.deps.tickResolver
      ? await this.deps.tickResolver.resolve(cmd.conditionId, cmd.tickSize, cmd.tokenId)
      : cmd.tickSize;

    let effectiveTick = cmd.tickSize;
    let effectivePrice = cmd.price;

    if (authTick !== cmd.tickSize) {
      if (cmd.metadata?.exitRecoveryChildV1 !== undefined) {
        await this.rejectOrder(
          cmd,
          "exit-recovery-tick-drift",
          ExchangeErrorCode.LivePolicyBlocked,
        );
        return;
      }
      if (this.isMakerCaptureReplacement(cmd)) {
        await this.rejectOrder(
          cmd,
          "maker-capture-tick-drift",
          ExchangeErrorCode.LivePolicyBlocked,
        );
        return;
      }
      // Re-snap the price to the corrected tick grid (side-aware) before validating.
      // If re-snap fails we fall back to the original cmd tick/price — the order
      // may still get an exchange reject, but we never place a knowingly invalid one.
      const resnap = resnapPriceToTick(cmd.price, cmd.side, authTick);
      if (resnap.valid) {
        effectiveTick = authTick;
        effectivePrice = resnap.price;
        this.log.info(
          {
            commandId: cmd.commandId,
            conditionId: cmd.conditionId,
            staleTick: cmd.tickSize,
            authTick,
            originalPrice: cmd.price,
            snappedPrice: resnap.price,
          },
          "authoritative CLOB tick differs — price re-snapped and tick corrected before submit",
        );
        await this.applyTickCorrection(cmd.conditionId, cmd.tokenId, authTick);
      } else {
        this.log.warn(
          {
            commandId: cmd.commandId,
            conditionId: cmd.conditionId,
            staleTick: cmd.tickSize,
            authTick,
            originalPrice: cmd.price,
          },
          "authoritative tick mismatch but re-snap invalid — keeping original tick/price",
        );
      }
    }

    // C1: effectiveCmd carries the final price/tick so DB rows and events
    // always reflect exactly what was submitted to the exchange.
    const effectiveCmd: PlaceOrderCommand =
      effectiveTick === cmd.tickSize && effectivePrice === cmd.price
        ? cmd
        : ({ ...cmd, price: effectivePrice, tickSize: effectiveTick } as PlaceOrderCommand);

    // M3: if a proactive correction changed price/tick, re-run the guards
    // that depend on those values before the first submit — the corrected
    // price might now cross the book or match an open near-duplicate BUY.
    if (effectiveCmd !== cmd) {
      const reCross = this.getPostOnlyCrossPreSubmitSkip(effectiveCmd);
      if (reCross) {
        await this.skipPostOnlyCrossPreSubmit(effectiveCmd, reCross);
        return;
      }
      if (effectiveCmd.side === "buy") {
        const reDuplicate = findNearDuplicateOpenBuy(
          this.deps.orderRepo.findOpen(),
          effectiveCmd,
          effectiveTick,
        );
        if (reDuplicate) {
          this.log.warn(
            {
              commandId: cmd.commandId,
              conditionId: cmd.conditionId,
              effectivePrice,
              effectiveTick,
            },
            "proactive tick correction produced near-duplicate BUY — skipping",
          );
          await this.publishOrderSkipped(effectiveCmd, "tick-corrected-near-duplicate-buy", {
            effectiveTick,
            effectivePrice,
          });
          return;
        }
      }
      const priceCheck = validateExecutablePrice(effectivePrice, effectiveTick);
      if (!priceCheck.ok) {
        this.log.warn(
          {
            commandId: cmd.commandId,
            conditionId: cmd.conditionId,
            effectivePrice,
            effectiveTick,
            reason: priceCheck.reason,
          },
          "proactive tick correction produced invalid price — skipping",
        );
        await this.publishOrderSkipped(effectiveCmd, "tick-corrected-invalid-price", {
          effectiveTick,
          effectivePrice,
          reason: priceCheck.reason,
        });
        return;
      }
    }

    const placeParams = {
      clientOrderId: cmd.clientOrderId as string,
      tokenId: cmd.tokenId,
      side: cmd.side,
      size: cmd.size,
      price: effectivePrice,
      ...(cmd.postOnly !== undefined ? { postOnly: cmd.postOnly } : {}),
      orderType: cmd.orderType,
      tickSize: effectiveTick,
      negRisk: cmd.negRisk,
      ...(cmd.expiration !== undefined ? { expiration: cmd.expiration } : {}),
    };

    // Authoritative exit loss-floor checkpoint (docs/plans/2026-07-20-exit-
    // loss-floor.md §Phase 4, step 2) — the ACTUAL price/size about to be
    // submitted, after tick resnap and sell-size clamp. Never rewrite the
    // price: block-and-skip, or submit unchanged.
    if (cmd.side === "sell") {
      const floorVerdict = this.evaluateSellExitLossFloor(effectiveCmd, placeParams.price);
      if (floorVerdict.block) {
        this.log.warn(
          {
            commandId: cmd.commandId,
            tokenId: cmd.tokenId,
            conditionId: cmd.conditionId,
            submittedPrice: placeParams.price,
            effectiveSellShares: placeParams.size,
            exitLossFloorReason: floorVerdict.reason,
          },
          "exit SELL blocked by loss-floor gate — not submitted to exchange",
        );
        this.recordExitLossFloorCounter(floorVerdict.reason, "authoritative");
        this.recordExitLossFloorRiskEvent(floorVerdict.reason, "authoritative", {
          commandId: String(cmd.commandId),
          tokenId: String(cmd.tokenId),
          conditionId: cmd.conditionId ? String(cmd.conditionId) : undefined,
          submittedPrice: placeParams.price,
          effectiveSellShares: placeParams.size,
        });
        await this.publishOrderSkipped(effectiveCmd, "exit_loss_floor_blocked", {
          exitLossFloorReason: floorVerdict.reason,
          submittedPrice: placeParams.price,
          effectiveSellShares: placeParams.size,
        });
        return;
      }
    }

    // Fix #1+TOCTOU — revalidate the maker-BUY at the actual submit boundary. The
    // validator excludes this command's own (possibly stale-priced) reservation and
    // re-counts the LIVE submit notional, so an upward tick re-snap between admission
    // and submit is capped at its final notional.
    const submitNotional = placeParams.price * placeParams.size;
    const submitRej = this.makerBuyLiveRejection(effectiveCmd, submitNotional);
    if (submitRej) {
      this.log.warn(
        { commandId: cmd.commandId, submitNotional, reason: submitRej.reason },
        "maker BUY rejected at submit",
      );
      await this.rejectOrder(effectiveCmd, submitRej.reason, submitRej.code);
      return;
    }

    // Release A Phase 3: bounce-exclusivity / position-identity guard (main submit) —
    // re-checked against the authoritative live position just before the exchange call.
    const exitOwnerRejSubmit = this.exitOwnerIdentityRejection(effectiveCmd);
    if (exitOwnerRejSubmit) {
      this.log.warn(
        { commandId: cmd.commandId, reason: exitOwnerRejSubmit.reason },
        "order rejected — exit-owner/position-identity guard (submit)",
      );
      await this.rejectOrder(effectiveCmd, exitOwnerRejSubmit.reason, exitOwnerRejSubmit.code);
      return;
    }

    // Release A Phase 3 (P6): re-check the transition barrier right before the
    // exchange call — a competing BUY could have opened a drain between admission
    // and here (the two boundaries are not atomic with each other).
    const transitionRejSubmit = await this.transitionRejection(effectiveCmd);
    if (transitionRejSubmit) {
      this.log.warn(
        {
          commandId: cmd.commandId,
          tokenId: effectiveCmd.tokenId,
          reason: transitionRejSubmit.reason,
        },
        "order rejected — token transition draining (main submit)",
      );
      await this.rejectOrder(effectiveCmd, transitionRejSubmit.reason, transitionRejSubmit.code);
      return;
    }

    // Release A Phase 3 (P7 rework, finding 3): backstop-specific rung re-check at
    // the token-serialized submit boundary, covering persisted AND in-flight rungs
    // (see backstopSubmitRungRejection) — the admission-time check alone can miss a
    // rung that was admitted after this backstop but persists/executes first.
    const backstopSubmitRej = await this.backstopSubmitRungRejection(effectiveCmd);
    if (backstopSubmitRej) {
      this.log.warn(
        {
          commandId: cmd.commandId,
          tokenId: effectiveCmd.tokenId,
          reason: backstopSubmitRej.reason,
        },
        "bounce backstop refused at submit — resting/in-flight rung still present",
      );
      await this.rejectOrder(effectiveCmd, backstopSubmitRej.reason, backstopSubmitRej.code);
      return;
    }

    // Finding 2 (round 6-7): this is the ACTUAL exchange-submit boundary for a deferred
    // backstop — count the placement attempt + start the grace HERE, so a pre-gateway
    // reject/skip above (pause / fence / loss-floor / acceptingOrders) never consumes the
    // cap or sets the grace. Reached only for a real gateway submit.
    if (effectiveCmd.metadata?.["__deferredBackstop"] === true) {
      const tk = String(effectiveCmd.tokenId);
      this.lastDeferredPlaceAt.set(tk, Date.now());
      this.deferredBackstopRetries.set(tk, (this.deferredBackstopRetries.get(tk) ?? 0) + 1);
    }

    const preparedLive = await this.submitPreparedLiveOrder(
      effectiveCmd,
      placeParams,
      this.recoveryPendingReplacements.get(String(effectiveCmd.clientOrderId)),
    );
    if (preparedLive?.submit.kind === "unknown") return;
    let result: import("@krabs/domain").PlaceOrderResult;
    if (preparedLive) {
      result = this.preparedSubmitResultToPlaceOrderResult(preparedLive.submit);
    } else {
      if (this.isMakerCaptureReplacement(effectiveCmd)) {
        await this.rejectOrder(
          effectiveCmd,
          "maker-capture-prepared-submit-required",
          ExchangeErrorCode.LivePolicyBlocked,
        );
        return;
      }
      result = await this.deps.gateway.placeOrder(placeParams);
    }

    const now = Date.now();

    if (!result.success) {
      const errorCode = result.errorCode ?? ExchangeErrorCode.Unknown;
      this.recordGatewayReject(errorCode);
      const reason = this.gatewayRejectReason(result.errorCode, result.errorMessage);
      this.log.warn(
        { commandId: cmd.commandId, errorCode, exchangeErrorDetails: result.errorDetails ?? null },
        "order rejected by gateway",
      );

      this.handleExchangeBalanceRejection(cmd, {
        errorCode: result.errorCode ?? null,
        errorMessage: result.errorMessage ?? null,
        errorDetails: result.errorDetails ?? null,
      });

      if (cmd.side === "sell") {
        const isMinSizeRejection =
          result.errorCode === "INVALID_SIZE" ||
          ExecutionModule.looksLikeMinSizeError(result.errorMessage, result.errorDetails);
        if (isMinSizeRejection) {
          this.maybeIncrementDustCounterForExecutionReject(
            cmd,
            SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
          );
        }
      }

      const exchangeErrorDetails = result.errorDetails ?? null;
      const exchangeRejectionReason = this.classifyExchangeRejection(
        exchangeErrorDetails,
        cmd.commandId,
      );

      // Phase 2: before persisting the first-attempt rejection, try once more
      // with a corrected tick/price if the CLOB told us the tick was wrong.
      // Hard cap = 1: retryAfterInvalidTick handles both success and failure
      // persistence paths and returns true so we exit immediately.
      if (
        exchangeRejectionReason === "rejection_invalid_tick" &&
        !this.isMakerCaptureReplacement(effectiveCmd)
      ) {
        const firstRejected = preparedLive
          ? this.buildPreparedOrder(
              effectiveCmd,
              placeParams,
              preparedLive.pending.orderId,
              "rejected",
              {
                errorCode,
                errorMessage: result.errorMessage ?? reason,
                errorDetails: exchangeErrorDetails,
                rejectionReason: exchangeRejectionReason,
              },
            )
          : undefined;
        if (firstRejected) this.deps.orderRepo.save(firstRejected);
        if (await this.retryAfterInvalidTick(cmd, effectiveTick, placeParams, now, firstRejected)) {
          return;
        }
      }

      // C1: use effectiveCmd so the persisted row reflects the price/tick
      // that was actually sent to the exchange (not the stale original).
      const rejectedOrder = preparedLive
        ? this.buildPreparedOrder(
            effectiveCmd,
            placeParams,
            preparedLive.pending.orderId,
            "rejected",
            {
              errorCode,
              errorMessage: result.errorMessage ?? reason,
              errorDetails: exchangeErrorDetails,
              rejectionReason: exchangeRejectionReason,
            },
          )
        : this.buildOrder(effectiveCmd, "rejected", null, {
            errorCode,
            errorMessage: result.errorMessage ?? reason,
            errorDetails: exchangeErrorDetails,
            rejectionReason: exchangeRejectionReason,
          });
      this.deps.orderRepo.save(rejectedOrder);

      await this.publishOrderRejected(effectiveCmd, {
        reason,
        errorCode,
        exchangeErrorMessage: result.errorMessage ?? null,
        exchangeErrorDetails: result.errorDetails ?? null,
        timestamp: now,
      });
      return;
    }

    if (!result.orderId || result.orderId.trim().length === 0) {
      this.log.error(
        { commandId: cmd.commandId },
        "gateway reported success without order id -- treating as rejection",
      );

      const exchangeErrorDetails = { responseBody: null, reason: "missing-order-id" };
      const exchangeRejectionReason = this.classifyExchangeRejection(
        exchangeErrorDetails,
        cmd.commandId,
      );
      // C1: use effectiveCmd here too.
      const rejectedOrder = this.buildOrder(effectiveCmd, "rejected", null, {
        errorCode: ExchangeErrorCode.Unknown,
        errorMessage: "gateway returned success without order id",
        errorDetails: exchangeErrorDetails,
        rejectionReason: exchangeRejectionReason,
      });
      this.deps.orderRepo.save(rejectedOrder);

      await this.publishOrderRejected(effectiveCmd, {
        reason: "gateway returned success without order id",
        errorCode: ExchangeErrorCode.Unknown,
        exchangeErrorMessage: "gateway returned success without order id",
        exchangeErrorDetails,
        timestamp: now,
      });
      return;
    }

    // Order accepted — use effectiveCmd (C1) so DB row and event carry the
    // price/tick that the exchange actually accepted, not the stale original.
    const orderId = createOrderId(result.orderId);
    if (preparedLive) {
      this.persistPreparedAcceptedOrder(effectiveCmd, preparedLive.pending, result.orderId);
    } else {
      const order = this.buildOrder(effectiveCmd, "open", result.orderId);
      this.markMakerCaptureSubmittedOrThrow(effectiveCmd, order.orderId);
      this.persistAcceptedOrderOrThrow(effectiveCmd, order, result.orderId);
    }

    this.log.info({ commandId: effectiveCmd.commandId, orderId: result.orderId }, "order placed");

    await this.deps.bus.publish("OrderPlaced", {
      commandId: effectiveCmd.commandId,
      clientOrderId: effectiveCmd.clientOrderId,
      orderId,
      tokenId: effectiveCmd.tokenId,
      conditionId: effectiveCmd.conditionId,
      side: effectiveCmd.side,
      price: effectiveCmd.price,
      size: effectiveCmd.size,
      orderType: effectiveCmd.orderType,
      signalReason: effectiveCmd.signalReason ?? null,
      timestamp: now,
    });

    // Check for immediate fills (simulation and paper modes use SimulationExchangeGateway
    // which fills orders immediately in memory — must import fills inline, not via recon)
    if (
      !this.deps.runtimeMode ||
      this.deps.runtimeMode === "simulation" ||
      this.deps.runtimeMode === "paper"
    ) {
      await this.checkForFills(orderId);
    }
  }

  // ─── Cancel execution (gateway call) ─────────────────────────────────

  private async executeCancel(cmd: CancelOrderCommand): Promise<void> {
    const orderKey = String(cmd.orderId);

    // Idempotency (docs/plans/2026-07-20-exit-loss-floor.md §Phase 6, finding #5).
    // An ordinary terminal order needs no duplicate cancel. A transition target is
    // different: startup or another consumer may have observed it exchange-live despite
    // the local terminal row, so only the exact resolver may release that fence.
    const existingOrder = this.deps.orderRepo.findById(cmd.orderId);
    const isTransitionTarget = this.hasTransitionTarget(cmd.orderId);
    if (existingOrder && isTerminalOrderStatus(existingOrder.status) && !isTransitionTarget) {
      this.log.debug(
        { commandId: cmd.commandId, orderId: cmd.orderId, status: existingOrder.status },
        "cancel skipped — order already in a terminal status",
      );
      return;
    }
    if (this.deps.runtimeMode === "live-lite" && existingOrder?.status === "pending") {
      const captureDeadlineMs = resolveMakerMicroLiveFillDeadlineMs(existingOrder);
      const hasMatchingReservation = [...this.pendingReservations.values()].some(
        (reservation) => reservation.clientOrderId === existingOrder.clientOrderId,
      );
      if (
        cmd.reason !== "stale_entry_ttl" ||
        captureDeadlineMs == null ||
        Date.now() < captureDeadlineMs ||
        hasMatchingReservation
      ) {
        this.log.warn(
          { commandId: cmd.commandId, orderId: cmd.orderId },
          "cancel blocked — live order submission is still pending",
        );
        return;
      }
    }
    if (this.cancelReservations.has(orderKey)) {
      this.log.debug(
        { commandId: cmd.commandId, orderId: cmd.orderId },
        "cancel skipped — a cancel for this order is already in flight",
      );
      return;
    }
    this.cancelReservations.add(orderKey);
    this.pruneCancelReservations();
    registerCancelIntent(orderKey, cmd.reason);

    // Retain the reservation ONLY when the cancel AND its terminal persistence
    // both complete; clear it on ANY non-success — a {success:false} result OR a
    // THROWN gateway/repo/bus error — so a transient failure can't permanently
    // poison the reservation and suppress a needed later retry (code-review #4).
    let cancelPersisted = false;
    try {
      const result = await this.deps.gateway.cancelOrder({
        orderId: orderKey,
      });

      if (!result.success) {
        this.log.warn(
          { commandId: cmd.commandId, orderId: cmd.orderId, errorCode: result.errorCode },
          "cancel rejected by gateway",
        );
      }
      const createdAtMs = existingOrder ? Date.parse(existingOrder.createdAt) : NaN;
      if (!Number.isFinite(createdAtMs)) {
        this.log.warn(
          { commandId: cmd.commandId, orderId: cmd.orderId },
          "cancel terminal proof blocked — order creation time is invalid",
        );
        return;
      }
      const fillsResult = this.deps.gateway.getFillsResult
        ? await this.deps.gateway.getFillsResult(createdAtMs)
        : { ok: true as const, data: await this.deps.gateway.getFills(createdAtMs) };
      if (fillsResult.ok)
        await importExchangeFills(
          fillsResult.data.filter((fill) => fill.orderId === orderKey),
          {
            fillRepo: this.deps.fillRepo,
            orderRepo: this.deps.orderRepo,
            bus: this.deps.bus,
            log: this.log,
            gateway: this.deps.gateway,
            fillCompletionTolerance: this.deps.fillCompletionTolerance,
          },
        );
      const exact = this.deps.gateway.getOrderResult
        ? await this.deps.gateway.getOrderResult(orderKey)
        : result.success && this.deps.runtimeMode !== "live-lite"
          ? {
              ok: true as const,
              data: { orderId: orderKey, status: "CANCELLED" as const, sizeFilled: 0 },
            }
          : null;
      if (!exact || !exact.ok) return;
      const orderForTelemetry = this.deps.orderRepo.findById(cmd.orderId);
      const cancelTelemetry = orderForTelemetry
        ? buildCancelTelemetry({
            order: orderForTelemetry,
            nowMs: Date.now(),
            fillRepo: this.deps.fillRepo,
            marketRepo: this.deps.marketRepo,
          })
        : undefined;
      const verdict = await applyOrderVerdict({
        orderRepo: this.deps.orderRepo,
        fillRepo: this.deps.fillRepo,
        bus: this.deps.bus,
        log: this.log,
        orderId: cmd.orderId,
        exchange: exact.data,
        publish: true,
        ...(this.deps.fillCompletionTolerance === undefined
          ? {}
          : { fillCompletionTolerance: this.deps.fillCompletionTolerance }),
        ...(cancelTelemetry === undefined ? {} : { cancelTelemetry }),
      });
      if (
        verdict.status !== "cancelled" &&
        verdict.status !== "filled" &&
        verdict.status !== "rejected"
      )
        return;
      const settledOrder = this.deps.orderRepo.findById(cmd.orderId);
      if (settledOrder) {
        if (verdict.status === "cancelled" || verdict.status === "rejected") {
          await this.releasePendingSellReplacement(cmd.orderId);
        }
        this.removeTransitionTargetIfTerminal(settledOrder.tokenId, cmd.orderId);
      }
      cancelPersisted = true;
    } finally {
      if (!cancelPersisted) {
        this.cancelReservations.delete(orderKey);
        if (cmd.reason === "maker_capture_reprice") {
          this.releaseProcessedCommandId(String(cmd.commandId));
        }
      }
    }
  }

  // ─── Fill detection ───────────────────────────────────────────────────

  private async checkForFills(orderId: OrderId): Promise<void> {
    const orderIdStr = String(orderId);
    const gateway = this.deps.gateway as OrderFillLookupGateway;
    const orderFills = gateway.getFillsForOrder
      ? await gateway.getFillsForOrder(orderIdStr)
      : (await gateway.getFills(0)).filter((f) => f.orderId === orderIdStr);
    if (orderFills.length === 0) return;

    await importExchangeFills(orderFills, {
      fillRepo: this.deps.fillRepo,
      orderRepo: this.deps.orderRepo,
      bus: this.deps.bus,
      log: this.log,
      gateway: this.deps.gateway,
      fillCompletionTolerance: this.deps.fillCompletionTolerance,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private getReservationSnapshot(cmd?: PlaceOrderCommand) {
    const openOrders = this.excludeBounceTargetBeingReplaced(this.deps.orderRepo.findOpen(), cmd);
    return buildReservationSnapshot(
      openOrders,
      this.deps.fillRepo,
      this.pendingReservations.values(),
    );
  }

  /**
   * A BOUNCE_EXIT_BACKSTOP force-exit cancels the resting BOUNCE_EXIT_TARGET maker
   * SELL (see signal-to-order.ts) then immediately places its own taker SELL for
   * the full remaining position. The CancelOrderRequested is processed
   * asynchronously, so the target order can still show as "open" in orderRepo
   * when this reservation check runs. Left uncorrected, the target's reserved
   * size double-counts against the backstop's own full-position SELL and can
   * trip reserved-token-limit, defeating the guaranteed force-exit. Excluding it
   * only applies when the incoming command IS that same-token backstop force-exit,
   * so reservation accounting for every other order is unchanged.
   *
   * Ladder redesign (docs/plans/2026-07-16-bounce-exit-ladder-redesign.md
   * Phase 3): `.filter` below drops every matching resting rung for this
   * token, not just one — the ladder can rest multiple rungs simultaneously
   * (see the `resolveMaxOpenSellOrdersPerToken` carve-out above), and the
   * backstop cancels all of them, so all of them must be excluded here too.
   */
  /**
   * Codex C2 fix (docs/plans/2026-07-19-sellable-sizing-bounce-for-all.md,
   * Phase 3): identifies the residual-driven "cleanup" bounce rung so the
   * microMaxOrderUsdc cap check above can exempt it — mirrors the same
   * `isCleanupRung` flag signal-to-order.ts's own cap-exemption reads off
   * `signal.bounceRung`, here read off the command's persisted metadata.
   */
  private isCleanupBounceRungCommand(cmd: PlaceOrderCommand): boolean {
    const bounceRung = cmd.metadata?.bounceRung as { isCleanupRung?: boolean } | undefined;
    return bounceRung?.isCleanupRung === true;
  }

  private excludeBounceTargetBeingReplaced(
    openOrders: Order[],
    cmd: PlaceOrderCommand | undefined,
  ): Order[] {
    if (
      !cmd ||
      !isBounceForceExit({ side: cmd.side, decisionRuleId: cmd.decisionRuleId ?? null })
    ) {
      return openOrders;
    }
    return openOrders.filter(
      (order) =>
        !(
          order.side === "sell" &&
          order.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID &&
          String(order.tokenId) === String(cmd.tokenId) &&
          this.matchesPositionCycle(order.positionId, cmd.positionId ?? null)
        ),
    );
  }

  private recordExecutionCapacityReject(cmd: PlaceOrderCommand, reason: string): void {
    const reservations = this.getReservationSnapshot();
    this.deps.capacityMetricsSink?.({
      source: "execution",
      side: cmd.side,
      approved: false,
      rejectionReason: reason,
      sellCapacitySource: cmd.side === "sell" ? classifySellCapacitySource(cmd) : undefined,
      openBuyOrderCount: reservations.openBuyOrderCount,
      openSellOrderCount: reservations.openSellOrderCount,
      openProfileLadderSellOrderCount: reservations.openProfileLadderSellOrderCount,
      openNonProfileLadderSellOrderCount: reservations.openNonProfileLadderSellOrderCount,
      openOrdersTotal: reservations.openOrdersTotal,
      perTokenOpenBuyOrderCount: getOpenOrderCountForToken(reservations, cmd.tokenId, "buy"),
      perTokenOpenSellOrderCount: getOpenOrderCountForToken(reservations, cmd.tokenId, "sell"),
    });
  }

  private recordExecutionSellCapacitySample(
    cmd: PlaceOrderCommand,
    approved: boolean,
    rejectionReason: string | null,
    sellCapacity: WalletSellCapacityDecision,
    reservations: ReservationSnapshot,
  ): void {
    this.deps.capacityMetricsSink?.({
      source: "execution",
      side: "sell",
      approved,
      rejectionReason,
      sellCapacitySource: sellCapacity.source,
      sellCapacityRejectReason: sellCapacity.rejectionDetail,
      sellCapacityMode: sellCapacity.mode,
      profileOwnedOpenPositionCount: sellCapacity.dynamic?.profileOwnedOpenPositionCount,
      profileLadderCapRaw: sellCapacity.dynamic?.profileLadderCapRaw,
      effectiveProfileLadderCap: sellCapacity.dynamic?.effectiveProfileLadderCap,
      nonLadderReserve: sellCapacity.dynamic?.nonLadderReserve,
      dynamicGlobalCap: sellCapacity.dynamic?.dynamicGlobalCap,
      openBuyOrderCount: reservations.openBuyOrderCount,
      openSellOrderCount: reservations.openSellOrderCount,
      openProfileLadderSellOrderCount: reservations.openProfileLadderSellOrderCount,
      openNonProfileLadderSellOrderCount: reservations.openNonProfileLadderSellOrderCount,
      openOrdersTotal: reservations.openOrdersTotal,
      perTokenOpenBuyOrderCount: getOpenOrderCountForToken(reservations, cmd.tokenId, "buy"),
      perTokenOpenSellOrderCount: getOpenOrderCountForToken(reservations, cmd.tokenId, "sell"),
    });
  }

  private currentProfileOwnedOpenPositionCount(): number {
    const count = this.deps.profileOwnedOpenPositionCount?.() ?? 0;
    return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  }

  private currentBuyCapacityPolicy(): ExecutionPolicy["buyCapacity"] | undefined {
    return this.deps.executionPolicy?.().buyCapacity;
  }

  private currentSellCapacityPolicy(): ExecutionPolicy["sellCapacity"] | undefined {
    return this.deps.executionPolicy?.().sellCapacity;
  }

  private currentTrackS1Policy(): ExecutionPolicy["trackS1"] | undefined {
    return this.deps.executionPolicy?.().trackS1;
  }

  private currentBounceExitPolicy(): ExecutionPolicy["bounceExit"] | undefined {
    return this.deps.executionPolicy?.().bounceExit;
  }

  private currentOrderCapacityPolicy(): ExecutionPolicy["orderCapacity"] | undefined {
    return this.deps.executionPolicy?.().orderCapacity;
  }

  private getReservationDecision(
    cmd: PlaceOrderCommand,
    notional: number,
  ):
    | { kind: "accept" }
    | {
        kind: "reject";
        reason: string;
        errorCode?: ExchangeErrorCode;
        message: string;
        details: Record<string, unknown>;
        capacitySampleRecorded?: boolean;
      }
    | {
        kind: "clamp";
        newSize: number;
        details: Record<string, unknown>;
      } {
    const reservations = this.getReservationSnapshot(cmd);
    let orderCapacity = evaluateTotalOrdersCapacity({
      policy: this.currentOrderCapacityPolicy(),
      openOrdersTotal: reservations.openOrdersTotal,
    });
    // BOUNCE_EXIT_BACKSTOP force-exit bypasses every bot-bookkeeping SELL
    // capacity check below (wallet sell / per-token sell / total order —
    // docs/plans/2026-07-16-bounce-exit-ladder-redesign.md, final Codex fix).
    // It does NOT bypass the position-existence / residual-below-exchange-
    // min-size checks further down, which are exchange-feasibility, not caps.
    const isBounceBackstop = isBounceForceExit({
      side: cmd.side,
      decisionRuleId: cmd.decisionRuleId ?? null,
    });

    if (cmd.side === "buy") {
      const executionPolicy = this.deps.executionPolicy?.();
      const buyPolicy = normalizeBuyCapacityPolicy(executionPolicy?.buyCapacity);
      const perTokenBuy = evaluatePerTokenOrderCapacity({
        side: "buy",
        maxOpenOrdersPerToken: buyPolicy.maxOpenBuyOrdersPerToken,
        openOrdersForToken: getOpenOrderCountForToken(reservations, cmd.tokenId, "buy"),
        enabled: buyPolicy.enabled,
      });
      if (!perTokenBuy.allowed) {
        return {
          kind: "reject",
          reason: PER_TOKEN_BUY_LIMIT_REASON,
          message: "order skipped — per-token BUY order capacity exhausted",
          details: {
            tokenId: String(cmd.tokenId),
            openBuyOrdersForToken: perTokenBuy.openOrdersForToken,
            maxOpenBuyOrdersPerToken: perTokenBuy.maxOpenOrdersPerToken,
          },
        };
      }

      const walletBudget = resolveWalletBuyBudget(
        {
          controlDb: this.deps.controlDb,
          activeProfile: this.deps.activeProfile,
          walletBufferPct: this.deps.walletBufferPct,
          walletBufferMinUsdc: this.deps.walletBufferMinUsdc,
        },
        reservations.reservedBuyUsdc,
      );
      const protectedRequirement = resolveProtectedWalletBuyRequirement({
        makerEntry: executionPolicy?.makerEntry ?? null,
        authorization: {
          conditionId: cmd.conditionId,
          source: cmd.source,
          side: cmd.side,
          entryStyle: cmd.entryStyle,
          postOnly: cmd.postOnly,
          decisionRuleId: cmd.decisionRuleId,
          signalReason: cmd.signalReason,
          signalTimestamp: cmd.signalTimestamp,
        },
        proposedNotionalUsdc: notional,
        pendingBuyNotionalUsdc: 0,
        nowMs: Date.now(),
      });
      const buyCapacity = evaluateWalletBuyCapacity({
        policy: buyPolicy,
        snapshot: walletBudget,
        requiredNotionalUsdc: protectedRequirement.requiredNotionalUsdc,
        signalReason: cmd.signalReason,
        openBuyOrderCount: reservations.openBuyOrderCount,
        protectedOpenBuySlots: protectedRequirement.protectedOpenBuySlots,
      });
      orderCapacity = evaluateTotalOrdersCapacity({
        policy: executionPolicy?.orderCapacity,
        openOrdersTotal: reservations.openOrdersTotal,
        protectedOpenOrderSlots: protectedRequirement.protectedOpenBuySlots,
      });
      if (!buyCapacity.allowed) {
        return {
          kind: "reject",
          reason: WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
          message: "order skipped — wallet buy capacity exhausted",
          details: {
            wallet: walletBudget?.walletBalanceUsdc ?? null,
            reservedBuy: reservations.reservedBuyUsdc,
            openBuyOrders: reservations.openBuyOrderCount,
            order: notional,
            capacityKind: buyCapacity.kind,
            requiredHeadroomUsdc: buyCapacity.requiredHeadroomUsdc,
            availableAfterOrderUsdc: buyCapacity.availableAfterOrderUsdc,
            maxOpenBuyOrders: buyCapacity.maxOpenBuyOrders,
            protectedOpenBuySlots: buyCapacity.protectedOpenBuySlots,
            effectiveMaxOpenBuyOrders: buyCapacity.effectiveMaxOpenBuyOrders,
          },
        };
      }
      if (!orderCapacity.allowed) {
        return {
          kind: "reject",
          reason: TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON,
          message: "order skipped — total open order capacity exhausted",
          details: {
            openOrdersTotal: orderCapacity.openOrdersTotal,
            maxOpenOrdersTotal: orderCapacity.maxOpenOrdersTotal,
          },
        };
      }
      if (hasWalletBuyBudget(walletBudget, protectedRequirement.requiredNotionalUsdc)) {
        return { kind: "accept" };
      }

      return {
        kind: "reject",
        reason: "reserved-usdc-limit",
        message: "order skipped — insufficient wallet balance after open-order reservations",
        details: {
          wallet: walletBudget?.walletBalanceUsdc ?? null,
          reservedBuy: reservations.reservedBuyUsdc,
          walletBuffer: walletBudget?.walletBufferUsdc ?? null,
          available: walletBudget?.freeUsdcForNewOrders ?? null,
          order: notional,
        },
      };
    }

    const sellPolicy = normalizeSellCapacityPolicy(this.currentSellCapacityPolicy());
    const sellCapacitySource = classifySellCapacitySource(cmd);
    const sellCapacity = evaluateWalletSellCapacity({
      policy: sellPolicy,
      source: sellCapacitySource,
      openSellOrderCount: reservations.openSellOrderCount,
      openProfileLadderSellOrderCount: reservations.openProfileLadderSellOrderCount,
      openNonProfileLadderSellOrderCount: reservations.openNonProfileLadderSellOrderCount,
      profileOwnedOpenPositionCount: this.currentProfileOwnedOpenPositionCount(),
    });
    if (!sellCapacity.allowed && !isBounceBackstop) {
      this.recordExecutionSellCapacitySample(
        cmd,
        false,
        WALLET_SELL_CAPACITY_EXHAUSTED_REASON,
        sellCapacity,
        reservations,
      );
      return {
        kind: "reject",
        reason: WALLET_SELL_CAPACITY_EXHAUSTED_REASON,
        message: "order skipped — wallet sell capacity exhausted",
        capacitySampleRecorded: true,
        details: {
          openSellOrders: sellCapacity.openSellOrderCount,
          openProfileLadderSellOrders: sellCapacity.openProfileLadderSellOrderCount,
          openNonProfileLadderSellOrders: sellCapacity.openNonProfileLadderSellOrderCount,
          maxOpenSellOrders: sellCapacity.maxOpenSellOrders,
          sellCapacitySource: sellCapacity.source,
          sellCapacityMode: sellCapacity.mode,
          sellCapacityRejectReason: sellCapacity.rejectionDetail,
          dynamic: sellCapacity.dynamic,
        },
      };
    }
    const perTokenSell = evaluatePerTokenOrderCapacity({
      side: "sell",
      maxOpenOrdersPerToken: this.resolveMaxOpenSellOrdersPerToken(cmd, sellPolicy),
      openOrdersForToken: getOpenOrderCountForToken(reservations, cmd.tokenId, "sell"),
      enabled: sellPolicy.enabled,
    });
    if (!perTokenSell.allowed && !isBounceBackstop) {
      return {
        kind: "reject",
        reason: PER_TOKEN_SELL_LIMIT_REASON,
        message: "order skipped — per-token SELL order capacity exhausted",
        details: {
          tokenId: String(cmd.tokenId),
          openSellOrdersForToken: perTokenSell.openOrdersForToken,
          maxOpenSellOrdersPerToken: perTokenSell.maxOpenOrdersPerToken,
        },
      };
    }

    if (!orderCapacity.allowed && !isBounceBackstop) {
      return {
        kind: "reject",
        reason: TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON,
        message: "order skipped — total open order capacity exhausted",
        details: {
          openOrdersTotal: orderCapacity.openOrdersTotal,
          maxOpenOrdersTotal: orderCapacity.maxOpenOrdersTotal,
        },
      };
    }

    if (!this.deps.positionRepo) {
      this.recordExecutionSellCapacitySample(cmd, true, null, sellCapacity, reservations);
      return { kind: "accept" };
    }

    const position = this.deps.positionRepo.findByTokenId(cmd.tokenId);
    if (!position || position.status === "closed") {
      return {
        kind: "reject",
        reason: "reserved-token-limit",
        message: "sell order skipped — no open position for token",
        details: { tokenId: cmd.tokenId, orderSize: cmd.size },
      };
    }

    const localReservedSell = getReservedSellSize(reservations, cmd.tokenId);
    const reservedSell = this.effectiveReservedSell(cmd.tokenId, localReservedSell);
    const upperBound = this.computeSellUpperBound(cmd.tokenId, position.size);
    const availableSize = upperBound - reservedSell;
    if (availableSize + ExecutionModule.SIZE_EPSILON_SHARES >= cmd.size) {
      if (cmd.side === "sell") {
        const minOrderSize = this.resolveCommandExplicitMinOrderSize(cmd);
        const normalized = normalizeSellSizeForMinOrder({
          availableSize,
          desiredSize: cmd.size,
          marketMinOrderSize: minOrderSize,
        });
        if (normalized.kind === "unsellable") {
          return {
            kind: "reject",
            reason: SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
            errorCode: ExchangeErrorCode.InvalidSize,
            message: "sell order skipped — residual below exchange minimum",
            details: {
              tokenId: cmd.tokenId,
              positionSize: position.size,
              upperBound,
              reservedSell,
              localReservedSell,
              availableSize,
              orderSize: cmd.size,
              minOrderSize,
            },
          };
        }
        if (normalized.kind === "clamp") {
          const reason =
            normalized.reason === "intent-below-min"
              ? "intent-below-min-residual-above-min"
              : "orphan-residual-below-min";
          this.recordExecutionSellCapacitySample(cmd, true, null, sellCapacity, reservations);
          return {
            kind: "clamp",
            newSize: normalized.size,
            details: {
              tokenId: cmd.tokenId,
              positionSize: position.size,
              upperBound,
              reservedSell,
              localReservedSell,
              availableSize,
              intentSize: cmd.size,
              minOrderSize,
              clampDirection: "up-to-available",
              reason,
            },
          };
        }
      }
      this.recordExecutionSellCapacitySample(cmd, true, null, sellCapacity, reservations);
      return { kind: "accept" };
    }

    const clampEnabled = this.deps.allowSellSizeClamp !== false;
    if (clampEnabled && availableSize > ExecutionModule.SIZE_EPSILON_SHARES) {
      const minOrderSize = this.resolveCommandExplicitMinOrderSize(cmd);
      if (
        minOrderSize != null &&
        Number.isFinite(minOrderSize) &&
        minOrderSize > 0 &&
        availableSize + ExecutionModule.SIZE_EPSILON_SHARES < minOrderSize
      ) {
        return {
          kind: "reject",
          reason: SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
          errorCode: ExchangeErrorCode.InvalidSize,
          message: "sell order skipped — available residual below exchange minimum",
          details: {
            tokenId: cmd.tokenId,
            positionSize: position.size,
            upperBound,
            reservedSell,
            localReservedSell,
            availableSize,
            orderSize: cmd.size,
            minOrderSize,
          },
        };
      }
      this.recordExecutionSellCapacitySample(cmd, true, null, sellCapacity, reservations);
      return {
        kind: "clamp",
        newSize: availableSize,
        details: {
          tokenId: cmd.tokenId,
          positionSize: position.size,
          upperBound,
          reservedSell,
          localReservedSell,
          availableSize,
          intentSize: cmd.size,
        },
      };
    }

    return {
      kind: "reject",
      reason: "reserved-token-limit",
      message: "sell order skipped — token balance already reserved by open sell orders",
      details: {
        tokenId: cmd.tokenId,
        positionSize: position.size,
        upperBound,
        reservedSell,
        localReservedSell,
        availableSize,
        orderSize: cmd.size,
      },
    };
  }

  /**
   * GATE-lane bounce-exit ladder carve-out (docs/plans/2026-07-16-bounce-
   * exit-ladder-redesign.md Phase 3): a resting rung or the near-resolution
   * backstop must not trip the generic per-token SELL cap (default 2) once
   * `bounceExit.ladderFractions` configures more than 2 simultaneous rungs.
   * Delegates to the shared resolver (also used by algo-risk-gate.ts, which
   * enforces this same cap earlier in the pipeline) so both call sites agree.
   */
  private resolveMaxOpenSellOrdersPerToken(
    cmd: PlaceOrderCommand,
    sellPolicy: ReturnType<typeof normalizeSellCapacityPolicy>,
  ): number {
    return resolveEffectiveMaxOpenSellOrdersPerToken({
      decisionRuleId: cmd.decisionRuleId ?? null,
      sellPolicy,
      s1MaxOrdersPerToken: this.currentTrackS1Policy()?.s1MaxOrdersPerToken,
      bounceLadderRungCount: this.currentBounceExitPolicy()?.ladderFractions.length,
    });
  }

  /** CHANGE B — wallet/local upper-bound for SELL clamp. */
  private computeSellUpperBound(tokenId: TokenId, localPositionSize: number): number {
    if (!this.deps.exchangeStateStore) return localPositionSize;
    const walletSize = this.deps.exchangeStateStore.getWalletPositionSize(tokenId);
    const walletCapturedAt = this.deps.exchangeStateStore.getWalletPositionCapturedAt(tokenId);
    const latestFillMs = this.getLatestFillMs(tokenId);
    return computeSellUpperBound({
      localPositionSize,
      walletPositionSize: walletSize,
      walletCapturedAtMs: walletCapturedAt,
      latestFillMs,
    });
  }

  /**
   * CHANGE C — `localReservedSell + sum(exchange SELL orders unknown to local)`
   * when the flag is on. The conservative union avoids the undercount when
   * local and exchange order sets are not subsets (e.g. an in-flight local
   * SELL not yet visible to the exchange + a phantom exchange order with no
   * local record). Falls back to local-only when no fresh snapshot exists.
   */
  private effectiveReservedSell(tokenId: TokenId, localReservedSell: number): number {
    if (this.deps.sellExchangeReservedEnabled === false) return localReservedSell;
    const store = this.deps.exchangeStateStore;
    if (!store) return localReservedSell;
    const known = this.collectKnownLocalExchangeOrderIds(tokenId);
    const exchangeOnly = store.getOpenSellSizeUnknownToLocal(tokenId, known);
    if (exchangeOnly === null) return localReservedSell;
    return localReservedSell + exchangeOnly;
  }

  private collectKnownLocalExchangeOrderIds(tokenId: TokenId): Set<string> {
    const known = new Set<string>();
    for (const order of this.deps.orderRepo.findOpen()) {
      if (order.side !== "sell") continue;
      if (String(order.tokenId) !== String(tokenId)) continue;
      if (isExitRecoveryFencedPredecessor(order)) continue;
      if (order.exchangeOrderId) known.add(order.exchangeOrderId);
    }
    return known;
  }

  /** CHANGE A — true when the token is in a balance-reject cooldown. */
  private isBalanceBlocked(cmd: PlaceOrderCommand): boolean {
    if (this.deps.sellBalanceRejectBlockEnabled === false) return false;
    if (!this.deps.exchangeStateStore) return false;
    return this.deps.exchangeStateStore.isBalanceBlocked(cmd.tokenId);
  }

  private getLatestFillMs(tokenId: TokenId): number | null {
    const recent = this.deps.fillRepo.findRecentByTokenId?.(tokenId, 1);
    if (recent && recent.length > 0) {
      const ts = Date.parse(recent[0]!.filledAt);
      return Number.isFinite(ts) ? ts : null;
    }
    let latest: number | null = null;
    for (const fill of this.deps.fillRepo.findByTokenId(tokenId)) {
      const ts = Date.parse(fill.filledAt);
      if (!Number.isFinite(ts)) continue;
      if (latest === null || ts > latest) latest = ts;
    }
    return latest;
  }

  private getMinOrderSizeRejection(cmd: PlaceOrderCommand): { minOrderSize: number } | null {
    const minOrderSize = this.resolveCommandMinOrderSize(cmd);
    if (
      minOrderSize == null ||
      !Number.isFinite(minOrderSize) ||
      minOrderSize <= 0 ||
      cmd.size + ExecutionModule.SIZE_EPSILON_SHARES >= minOrderSize
    ) {
      return null;
    }
    return { minOrderSize };
  }

  private getSellPreSubmitMinOrderBlock(
    cmd: PlaceOrderCommand,
  ): { reason: string; minOrderSize: number | null } | null {
    if (cmd.side !== "sell") return null;
    const guard = evaluateSellPreSubmitGuard(
      cmd.size,
      this.resolveCommandExplicitMinOrderSize(cmd),
    );
    if (guard.proceed) return null;
    if (
      guard.reason === SELL_RESIDUAL_UNKNOWN_MIN_ORDER_SIZE_REASON &&
      this.deps.runtimeMode !== "live-lite"
    ) {
      return null;
    }
    return { reason: guard.reason, minOrderSize: guard.minOrderSize };
  }

  /**
   * One `/books` refresh per token per retry window, not one per blocked order:
   * an S1 ladder re-places every tier on each reprice, so an unthrottled call
   * here would reproduce the very hammering loop this whole change removes.
   *
   * Fire-and-forget by design — the refresh may legitimately come back without a
   * minimum. This order is rejected either way; the point is that the NEXT one
   * has a chance of finding the value cached.
   */
  private requestMinOrderSizeHydrationFor(tokenId: string, now: number): void {
    const requestHydration = this.deps.requestMinOrderSizeHydration;
    if (requestHydration == null) return;
    const lastRequestedAt = this.minOrderSizeHydrationRequestedAt.get(tokenId);
    if (lastRequestedAt != null && now - lastRequestedAt <= MIN_ORDER_SIZE_HYDRATION_RETRY_MS) {
      return;
    }
    // An expired entry can never throttle anything again, so sweeping on the
    // (already rate-limited) allow path bounds the map by the tokens actively
    // retrying rather than by every token ever blocked for the process lifetime.
    for (const [key, requestedAt] of this.minOrderSizeHydrationRequestedAt) {
      if (now - requestedAt > MIN_ORDER_SIZE_HYDRATION_RETRY_MS) {
        this.minOrderSizeHydrationRequestedAt.delete(key);
      }
    }
    this.minOrderSizeHydrationRequestedAt.set(tokenId, now);
    requestHydration(tokenId);
  }

  /**
   * Un-marks a command that was rejected BEFORE it ever reached the exchange, so
   * the identical retry is not swallowed as a duplicate.
   *
   * The producer that retries an unknown-minimum exit is the S1 ladder, and its
   * `commandId` is deterministic — `s1_<tokenId>_<ladderId>_<tierIndex>` with
   * `ladderId` hashed from (token, openedAt, avgEntryPrice). It re-places the
   * same tiers after a phantom release, rebuilding byte-identical ids. Since the
   * idempotency mark is taken before the pre-submit guards run, the retry would
   * hit `processedCommandIds` and be dropped silently — the minimum we just
   * hydrated could never be used, and algo SELLs stay suppressed for an
   * S1-owned token. Releasing is safe precisely here: nothing was submitted, no
   * order row and no client-order-id were persisted.
   */
  private releaseProcessedCommandId(commandId: string): void {
    if (!this.processedCommandIds.delete(commandId)) return;
    const index = this.processedCommandOrder.lastIndexOf(commandId);
    if (index >= 0) this.processedCommandOrder.splice(index, 1);
  }

  private releaseFailedMakerCaptureCommand(cmd: PlaceOrderCommand): void {
    try {
      const metadata = parseMakerCaptureRepriceSignal(cmd.metadata?.makerCaptureRepriceV1);
      const intent = cmd.signalId
        ? this.deps.orderRepo.findMakerCaptureRepriceIntentBySignal?.(cmd.signalId)
        : null;
      const clientOrderId = intent
        ? buildClientOrderId({
            signalId: intent.lifecycleSignalId,
            tokenId: intent.tokenId,
            side: "buy",
          })
        : null;
      if (
        !metadata ||
        !intent ||
        intent.status !== "ready" ||
        intent.childOrderId !== null ||
        !clientOrderId ||
        String(cmd.clientOrderId) !== String(clientOrderId) ||
        !matchesMakerCaptureIntent(cmd.signalId!, metadata, intent) ||
        this.deps.orderRepo.findByClientOrderId(clientOrderId)
      )
        return;
      this.releaseProcessedCommandId(String(cmd.commandId));
    } catch {
      // Fail closed: repository uncertainty must retain the idempotency fence.
    }
  }

  private getPostOnlyCrossPreSubmitSkip(cmd: PlaceOrderCommand): PostOnlyCrossPreSubmitSkip | null {
    if (cmd.postOnly !== true) return null;
    const market = this.marketCache.get(String(cmd.tokenId));

    if (cmd.side === "sell") {
      const bestBid = market?.bestBid ?? null;
      const bestAsk = market?.bestAsk ?? null;
      if (bestBid == null || !Number.isFinite(bestBid) || bestBid <= 0) return null;
      if (cmd.price > bestBid + ExecutionModule.PRICE_EPSILON) return null;
      return {
        bestBid,
        bestAsk,
        bookSource: market?.bookSource ?? null,
        snapshotTs: market?.snapshotTs ?? null,
      };
    }

    if (cmd.side === "buy") {
      const bestAsk = market?.bestAsk ?? null;
      if (bestAsk === null || !Number.isFinite(bestAsk)) return null;
      if (cmd.price + ExecutionModule.PRICE_EPSILON < bestAsk) return null;
      return {
        bestBid: market?.bestBid ?? 0,
        bestAsk,
        bookSource: market?.bookSource ?? null,
        snapshotTs: market?.snapshotTs ?? null,
      };
    }

    return null;
  }

  /**
   * Phase 3: returns true only when the in-memory marketCache EXPLICITLY says
   * acceptingOrders === false. Absent from cache (unknown liveness) → returns
   * false so the order proceeds (fail-open). Never calls deactivate().
   */
  private getNotAcceptingOrdersSkip(cmd: PlaceOrderCommand): boolean {
    const market = this.marketCache.get(String(cmd.tokenId));
    return market !== undefined && market.acceptingOrders === false;
  }

  private async skipNotAcceptingOrders(cmd: PlaceOrderCommand): Promise<void> {
    this.log.warn(
      {
        commandId: cmd.commandId,
        tokenId: cmd.tokenId,
        conditionId: cmd.conditionId,
        side: cmd.side,
        price: cmd.price,
      },
      "order suppressed — market not accepting orders",
    );
    await this.publishOrderSkipped(cmd, "not_accepting_orders", {
      conditionId: String(cmd.conditionId),
    });
  }

  /**
   * GATE sub-cap: at most MAX_OPEN_GATE_BUYS concurrent open GATE_ENTRY buys, so GATE's adaptive
   * long TTL cannot occupy more than its share of the shared 25-slot buy pool and starve R23.
   * Counts persisted + in-flight reservations via the reservation snapshot (race-safe).
   */
  private async skipGateOverCapIfNeeded(cmd: PlaceOrderCommand): Promise<boolean> {
    if (cmd.side !== "buy" || cmd.decisionRuleId !== GATE_ENTRY_RULE_ID) return false;
    const openGateBuys = this.getReservationSnapshot(cmd).openGateBuyOrderCount;
    if (openGateBuys < MAX_OPEN_GATE_BUYS) return false;
    this.log.debug(
      { commandId: cmd.commandId, tokenId: String(cmd.tokenId), openGateBuys },
      "GATE buy skipped — open GATE cap reached",
    );
    await this.publishOrderSkipped(cmd, "gate_open_cap", {
      openGateBuyOrders: openGateBuys,
      maxOpenGateBuys: MAX_OPEN_GATE_BUYS,
      decisionRuleId: cmd.decisionRuleId ?? null,
    });
    return true;
  }

  private async skipDuplicateBuyPreSubmitIfNeeded(cmd: PlaceOrderCommand): Promise<boolean> {
    if (cmd.side !== "buy") return false;
    const duplicate = findNearDuplicateOpenBuy(this.deps.orderRepo.findOpen(), cmd, cmd.tickSize);
    if (!duplicate) return false;

    const details = {
      existingOrderId: String(duplicate.orderId),
      existingPrice: duplicate.price,
      requestedPrice: cmd.price,
      tickSize: cmd.tickSize,
      signalReason: cmd.signalReason ?? null,
      decisionRuleId: cmd.decisionRuleId ?? null,
    };
    this.log.debug(
      { commandId: cmd.commandId, tokenId: String(cmd.tokenId), ...details },
      "buy order skipped — duplicate open BUY already resting",
    );
    this.recordBuyCounter("buy_duplicate_deduped", cmd);
    await this.publishOrderSkipped(cmd, BUY_DUPLICATE_DEDUPED_REASON, details);
    return true;
  }

  private async deferBuyForTargetedCapacityReplacementIfNeeded(
    cmd: PlaceOrderCommand,
  ): Promise<boolean> {
    if (cmd.side !== "buy") return false;
    const buyPolicy = normalizeBuyCapacityPolicy(this.currentBuyCapacityPolicy());
    if (!buyPolicy.enabled || buyPolicy.maxOpenBuyOrders <= 0) return false;

    const openOrders = this.deps.orderRepo.findOpen();
    const openBuyCount = openOrders.filter(
      (order) =>
        order.side === "buy" &&
        (order.status === "pending" ||
          order.status === "open" ||
          order.status === "partially-filled"),
    ).length;
    if (openBuyCount < buyPolicy.maxOpenBuyOrders) return false;

    const duplicatePair = findDuplicateOpenBuyPair(openOrders);
    const now = Date.now();
    const blocker =
      duplicatePair?.cancel ??
      findOldestStaleOpenBuy(
        openOrders,
        (order) => this.deps.marketRepo.findByTokenId(order.tokenId),
        now,
        (order) =>
          this.deps.tradeStatsReader?.getTradeStats3h(order.tokenId)?.publicTradeCount3h ?? null,
      );
    if (!blocker) return false;

    const replacementKind = duplicatePair?.cancel === blocker ? "duplicate" : "stale";
    const cancelReason =
      replacementKind === "duplicate" ? "buy_duplicate_replacement" : "stale_entry_ttl";
    await this.deps.bus.publish("CancelOrderRequested", {
      command: {
        type: "CancelOrderCommand",
        commandId: createCommandId(
          `buy-cap-replace-${String(blocker.orderId)}-${String(cmd.commandId)}-${now}`,
        ),
        orderId: blocker.orderId,
        reason: cancelReason,
      },
      timestamp: now,
    });

    const details = {
      replacementKind,
      cancelledOrderId: String(blocker.orderId),
      cancelReason,
      openBuyOrders: openBuyCount,
      maxOpenBuyOrders: buyPolicy.maxOpenBuyOrders,
      signalReason: cmd.signalReason ?? null,
      decisionRuleId: cmd.decisionRuleId ?? null,
    };
    this.recordBuyCounter("buy_cap_full_targeted_replacement", cmd, {
      replacementKind,
      cancelReason,
    });
    await this.publishOrderSkipped(cmd, BUY_CAP_FULL_TARGETED_REPLACEMENT_REASON, details);
    return true;
  }

  private async skipPostOnlyCrossPreSubmit(
    cmd: PlaceOrderCommand,
    postOnlyCross: PostOnlyCrossPreSubmitSkip,
  ): Promise<void> {
    const msg =
      cmd.side === "buy"
        ? "buy order skipped — post-only price would cross current ask"
        : "sell order skipped — post-only price would cross current bid";
    this.log.warn(
      {
        commandId: cmd.commandId,
        tokenId: cmd.tokenId,
        side: cmd.side,
        price: cmd.price,
        currentBestBid: postOnlyCross.bestBid,
        currentBestAsk: postOnlyCross.bestAsk,
        bookSource: postOnlyCross.bookSource,
      },
      msg,
    );
    const details = {
      price: cmd.price,
      currentBestBid: postOnlyCross.bestBid,
      currentBestAsk: postOnlyCross.bestAsk,
      bookSource: postOnlyCross.bookSource,
      snapshotTs: postOnlyCross.snapshotTs,
    };
    this.recordOrderSkipped(cmd, "post-only-cross-pre-submit", details);
    // Live no-op signal for the loop guard — published before any working order
    // exists, so it counts independently of deduplicated risk_events.
    await this.deps.bus.publish("OrderSkipped", {
      commandId: cmd.commandId,
      clientOrderId: cmd.clientOrderId,
      tokenId: cmd.tokenId,
      conditionId: cmd.conditionId,
      reasonCode: "post-only-cross-pre-submit",
      side: cmd.side,
      price: cmd.price,
      size: cmd.size,
      signalReason: cmd.signalReason ?? null,
      signalId: cmd.signalId ?? null,
      decisionRuleId: cmd.decisionRuleId ?? null,
      signalTimestamp: cmd.signalTimestamp ?? null,
      details,
      timestamp: Date.now(),
    });
  }

  private async skipDuplicateClientOrderIdPreSubmit(
    cmd: PlaceOrderCommand,
    existing: Order,
  ): Promise<void> {
    const details = {
      existingOrderId: String(existing.orderId),
      existingStatus: existing.status,
      existingExchangeOrderId: existing.exchangeOrderId ?? null,
      source: boundedMetricLabel(cmd.source),
    };
    this.log.warn(
      {
        commandId: cmd.commandId,
        clientOrderId: cmd.clientOrderId,
        tokenId: cmd.tokenId,
        side: cmd.side,
        existingOrderId: details.existingOrderId,
        existingStatus: details.existingStatus,
        existingExchangeOrderId: details.existingExchangeOrderId,
      },
      "order skipped before exchange submit — duplicate clientOrderId exists locally",
    );
    this.deps.runtimeMetrics?.writeCounter?.(
      "order_duplicate_client_order_id_pre_submit",
      1,
      JSON.stringify({
        side: cmd.side,
        source: boundedMetricLabel(cmd.source),
        signalReason: boundedMetricLabel(cmd.signalReason),
        decisionRuleId: boundedMetricLabel(cmd.decisionRuleId),
        existingStatus: boundedMetricLabel(existing.status),
      }),
    );
    await this.publishOrderSkipped(cmd, "duplicate_client_order_id_pre_submit", details);
  }

  private async publishOrderSkipped(
    cmd: PlaceOrderCommand,
    reasonCode: string,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.clearPendingDeferredSubmit(cmd); // finding 1 (round 7): any skip resolves the submit marker
    this.recordOrderSkipped(cmd, reasonCode, details);
    await this.deps.bus.publish("OrderSkipped", {
      commandId: cmd.commandId,
      clientOrderId: cmd.clientOrderId,
      tokenId: cmd.tokenId,
      conditionId: cmd.conditionId,
      reasonCode,
      side: cmd.side,
      price: cmd.price,
      size: cmd.size,
      signalReason: cmd.signalReason ?? null,
      signalId: cmd.signalId ?? null,
      decisionRuleId: cmd.decisionRuleId ?? null,
      signalTimestamp: cmd.signalTimestamp ?? null,
      details,
      timestamp: Date.now(),
    });
  }

  private async submitPreparedLiveOrder(
    cmd: PlaceOrderCommand,
    params: PlaceOrderParams,
    replacement?: Order,
  ): Promise<{ pending: Order; submit: PreparedOrderSubmitResult } | null> {
    if (this.deps.runtimeMode !== "live-lite") return null;
    const gateway = this.deps.gateway as PreparedLiveGateway;
    if (!gateway.prepareOrder || !gateway.submitPreparedOrder) {
      throw new Error("live-lite gateway does not support prepared order submission");
    }

    const prepared = await gateway.prepareOrder(params);
    const pending = this.buildPreparedOrder(cmd, params, prepared.orderId, "pending");
    this.markMakerCaptureSubmittedOrThrow(cmd, pending.orderId);
    if (replacement) {
      if (!this.deps.orderRepo.replacePendingIdentity) {
        throw new Error("order repository does not support prepared identity replacement");
      }
      this.deps.orderRepo.replacePendingIdentity(replacement.orderId, pending);
    } else {
      this.deps.orderRepo.save(pending);
    }

    const submit = await withinLiveSubmissionLane(async () => {
      if (liveSubmissionLatched) {
        throw new Error("live submission latch is closed");
      }
      const makerRejection = this.makerBuyLiveRejection(cmd, params.price * params.size);
      if (makerRejection) {
        return {
          kind: "rejected" as const,
          errorCode: makerRejection.code,
          errorMessage: makerRejection.reason,
          errorDetails: null,
        };
      }
      if (this.isMakerCaptureReplacement(cmd)) {
        const finalBook = await this.makerCaptureFreshBookRejection(cmd);
        if (!finalBook.ok) {
          return {
            kind: "rejected" as const,
            errorCode: finalBook.code,
            errorMessage: finalBook.reason,
            errorDetails: null,
          };
        }
        const context = this.makerCaptureExecutionContext(cmd);
        if (
          !context?.intent.childOrderId ||
          !this.deps.orderRepo.markMakerCaptureRepriceSubmitProof?.(
            context.intent.intentId,
            context.intent.childOrderId,
            String(cmd.clientOrderId),
            finalBook.proof,
          )
        ) {
          return {
            kind: "rejected" as const,
            errorCode: ExchangeErrorCode.LivePolicyBlocked,
            errorMessage: "maker-capture-submit-proof-cas-failed",
            errorDetails: null,
          };
        }
        this.makerCaptureGatewayAttempts.add(String(cmd.commandId));
      }
      if (this.activeExitRecoveryClientIds.has(String(cmd.clientOrderId))) {
        await this.assertRecoverySubmitBoundary(cmd);
        this.recoverySubmissionAttempts.add(String(cmd.clientOrderId));
      }
      const outcome = await gateway.submitPreparedOrder!(prepared);
      if (outcome.kind === "accepted" && outcome.orderId !== prepared.orderId) {
        this.closeLiveSubmissionLatch(prepared.orderId, outcome.orderId, cmd);
      }
      return outcome;
    });

    if (submit.kind === "unknown") {
      this.recordPreparedSubmitUnknown(cmd, pending, submit);
    }
    return { pending, submit };
  }

  private buildPreparedOrder(
    cmd: PlaceOrderCommand,
    params: PlaceOrderParams,
    exactOrderId: string,
    status: "pending" | "rejected",
    exchangeError?: {
      errorCode: string;
      errorMessage: string | null;
      errorDetails: Readonly<Record<string, unknown>> | null;
      rejectionReason?: string | null;
    },
  ): Order {
    const now = new Date().toISOString();
    const order: Order = {
      orderId: createOrderId(exactOrderId),
      clientOrderId: cmd.clientOrderId,
      tokenId: cmd.tokenId,
      conditionId: cmd.conditionId,
      positionId: cmd.positionId ?? null,
      side: cmd.side,
      orderType: cmd.orderType,
      postOnly: cmd.postOnly === true,
      price: params.price,
      size: params.size,
      sizeUsdc: params.size * params.price,
      status,
      fillProgressShares: status === "rejected" ? 0 : null,
      exchangeOrderId: exactOrderId,
      signalId: cmd.signalId ?? null,
      signalReason: cmd.signalReason ?? null,
      decisionRuleId: cmd.decisionRuleId ?? null,
      signalTimestamp: cmd.signalTimestamp ?? null,
      entryStyle: cmd.entryStyle ?? null,
      exchangeErrorCode: exchangeError?.errorCode ?? null,
      exchangeErrorMessage: exchangeError?.errorMessage ?? null,
      exchangeErrorPayload: stringifyExchangeErrorPayload(exchangeError?.errorDetails ?? null),
      exchangeRejectionReason: exchangeError?.rejectionReason ?? null,
      metadata: { ...(cmd.metadata ?? {}), orderSource: cmd.source },
      botRunId: this.deps.botRunId,
      createdAt: now,
      updatedAt: now,
    };
    return this.stampMakerCaptureLineage(order, cmd, status);
  }

  private stampMakerCaptureLineage(
    order: Order,
    cmd: PlaceOrderCommand,
    status: "pending" | "open" | "rejected",
  ): Order {
    if (status === "rejected") return order;
    if (this.isMakerCaptureReplacement(cmd)) {
      const context = this.makerCaptureExecutionContext(cmd);
      const rootLineage = context ? parseMakerCaptureLineage(context.root) : null;
      const deadline = context ? resolveMakerMicroLiveFillDeadlineMs(context.root) : null;
      const remainingFillWaitMs =
        deadline == null ? 0 : Math.floor(deadline - Date.parse(order.createdAt));
      if (!context || !rootLineage || remainingFillWaitMs <= 0) {
        throw new Error("maker capture child lineage validation failed");
      }
      const lifecycle = context.root.metadata?.makerMicroLiveLifecycle as Record<string, unknown>;
      return {
        ...order,
        metadata: {
          ...(order.metadata ?? {}),
          makerMicroLiveLifecycle: { ...lifecycle, fillWaitMs: remainingFillWaitMs },
          makerCaptureLineageV1: {
            version: 1,
            rootOrderId: context.intent.rootOrderId,
            predecessorOrderId: context.intent.predecessorOrderId,
            replacementIndex: context.intent.replacementIndex,
            rootNotionalUsdc: rootLineage.rootNotionalUsdc,
          },
        },
      };
    }
    if (parseQuoteMotionOrigin(order)?.kind !== "r23_capture") return order;
    if (resolveMakerMicroLiveFillDeadlineMs(order) === null) return order;
    return {
      ...order,
      metadata: {
        ...(order.metadata ?? {}),
        makerCaptureLineageV1: rootMakerCaptureLineage(order.orderId, order.sizeUsdc),
      },
    };
  }

  private markMakerCaptureSubmittedOrThrow(cmd: PlaceOrderCommand, childOrderId: OrderId): void {
    if (!this.isMakerCaptureReplacement(cmd)) return;
    const context = this.makerCaptureExecutionContext(cmd);
    if (
      !context ||
      !this.deps.orderRepo.markMakerCaptureRepriceSubmitted?.(context.intent.intentId, childOrderId)
    ) {
      throw new Error("maker capture child intent submission claim failed");
    }
  }

  private preparedSubmitResultToPlaceOrderResult(
    submit: Exclude<PreparedOrderSubmitResult, { kind: "unknown" }>,
  ): import("@krabs/domain").PlaceOrderResult {
    if (submit.kind === "accepted") return { success: true, orderId: submit.orderId };
    return {
      success: false,
      ...(submit.errorCode !== undefined ? { errorCode: submit.errorCode } : {}),
      ...(submit.errorMessage !== undefined ? { errorMessage: submit.errorMessage } : {}),
      ...(submit.errorDetails !== undefined ? { errorDetails: submit.errorDetails } : {}),
    };
  }

  private closeLiveSubmissionLatch(
    preparedOrderId: string,
    returnedOrderId: string,
    cmd: PlaceOrderCommand,
  ): never {
    liveSubmissionLatched = true;
    const payload = {
      commandId: String(cmd.commandId),
      clientOrderId: String(cmd.clientOrderId),
      preparedOrderId,
      returnedOrderId,
      tokenId: String(cmd.tokenId),
      occurredAt: new Date().toISOString(),
    };
    try {
      this.deps.riskEventRepo?.insert({ eventType: "live_order_hash_mismatch", payload });
    } catch (err) {
      this.log.error({ err, ...payload }, "failed to persist live order hash mismatch evidence");
    } finally {
      this.deps.pauseLiveTrading?.();
    }
    throw new Error(
      `live order hash mismatch: expected ${preparedOrderId}, received ${returnedOrderId}`,
    );
  }

  private recordPreparedSubmitUnknown(
    cmd: PlaceOrderCommand,
    pending: Order,
    submit: Extract<PreparedOrderSubmitResult, { kind: "unknown" }>,
  ): void {
    try {
      this.deps.riskEventRepo?.insert({
        eventType: "live_order_submit_unknown",
        payload: {
          commandId: String(cmd.commandId),
          orderId: String(pending.orderId),
          clientOrderId: String(cmd.clientOrderId),
          errorMessage: submit.errorMessage ?? null,
          errorDetails: submit.errorDetails ?? null,
        },
      });
    } catch (err) {
      this.log.warn({ err, commandId: cmd.commandId }, "failed to persist unknown submit evidence");
    }
  }

  private persistAcceptedOrderOrThrow(
    cmd: PlaceOrderCommand,
    order: Order,
    exchangeOrderId: string,
  ): void {
    try {
      this.deps.orderRepo.save(order);
      // Once the order is persisted "open", findOpen() accounts for its exposure.
      // Clear its pending reservation NOW (before the caller's awaited OrderPlaced
      // publish, and before executeCommand's finally) so a CONCURRENT maker BUY's
      // cap check cannot count this same order twice — once via findOpen() and once
      // via the still-live reservation. Idempotent with the finally delete.
      this.pendingReservations.delete(String(cmd.commandId));
    } catch (err) {
      const persistenceError = errorToLogMessage(err);
      const payload = {
        commandId: String(cmd.commandId),
        exchangeOrderId,
        clientOrderId: String(cmd.clientOrderId),
        tokenId: String(cmd.tokenId),
        conditionId: String(cmd.conditionId),
        side: cmd.side,
        price: cmd.price,
        size: cmd.size,
        signalReason: cmd.signalReason ?? null,
        signalId: cmd.signalId ?? null,
        decisionRuleId: cmd.decisionRuleId ?? null,
        signalTimestamp: cmd.signalTimestamp ?? null,
        persistenceError,
        occurredAt: new Date().toISOString(),
      };
      this.log.fatal(
        payload,
        "order persistence failed after exchange accept — exchange-live orphan risk",
      );
      try {
        this.deps.riskEventRepo?.insert({
          eventType: "order_persist_failed_after_exchange_accept",
          payload,
        });
      } catch (riskErr) {
        this.log.error(
          {
            err: riskErr,
            commandId: cmd.commandId,
            exchangeOrderId,
            clientOrderId: cmd.clientOrderId,
          },
          "failed to persist order_persist_failed_after_exchange_accept risk event",
        );
      }
      throw err;
    }
  }

  private persistPreparedAcceptedOrder(
    cmd: PlaceOrderCommand,
    pending: Order,
    exchangeOrderId: string,
  ): void {
    if (this.deps.orderRepo.findById(pending.orderId)?.status === "pending") {
      this.deps.orderRepo.updateStatus(pending.orderId, "open", exchangeOrderId);
    }
    this.pendingReservations.delete(String(cmd.commandId));
  }

  /** Write corrected tick to DB + refresh all in-memory caches. Fire-and-
   *  forget from the bus perspective — NormalizedMarketUpdated is awaited so
   *  the signal-to-order cache is updated before the next sweep.
   *
   *  M5: iterates the entire marketCache to update BOTH tokens of the binary
   *  market (YES and NO share the same conditionId but each has its own cache
   *  key). The tokenId param is kept for call-site compatibility but is unused
   *  — the conditionId is the authoritative key for the DB write. */
  private async applyTickCorrection(
    conditionId: string,
    _tokenId: TokenId,
    authTick: number,
  ): Promise<void> {
    // Narrow DB write: only tick_size + updated_at (no saveBatch clobber risk).
    this.deps.marketRepo.updateTickSize(conditionId, authTick);

    // Refresh every cached token that belongs to this condition (typically 2:
    // the YES and NO outcomes). Collect into an array for a single bus publish.
    const correctedMarkets: NormalizedMarket[] = [];
    for (const [key, market] of this.marketCache) {
      if (market.conditionId === conditionId) {
        const corrected: NormalizedMarket = { ...market, tickSize: authTick };
        this.marketCache.set(key, corrected);
        correctedMarkets.push(corrected);
      }
    }

    if (correctedMarkets.length > 0) {
      // Propagate to all EventBus subscribers (signal-to-order, etc.).
      await this.deps.bus.publish("NormalizedMarketUpdated", {
        markets: correctedMarkets,
        timestamp: Date.now(),
      });
    }
  }

  private getInvalidPriceRejection(cmd: PlaceOrderCommand): {
    reason: string;
    tickSize: number;
    minPrice: number;
    maxPrice: number;
  } | null {
    const validation = validateExecutablePrice(cmd.price, cmd.tickSize);
    if (validation.ok) return null;
    return {
      reason: validation.reason,
      tickSize: validation.tickSize,
      minPrice: validation.minPrice,
      maxPrice: validation.maxPrice,
    };
  }

  private resolveCommandMinOrderSize(cmd: PlaceOrderCommand): number | null {
    const explicitMinOrderSize = this.resolveCommandExplicitMinOrderSize(cmd);
    if (explicitMinOrderSize != null) return explicitMinOrderSize;

    return this.deps.runtimeMode === "live-lite" ? DEFAULT_FALLBACK_MIN_ORDER_SIZE : null;
  }

  private resolveCommandExplicitMinOrderSize(cmd: PlaceOrderCommand): number | null {
    const cachedMinOrderSize = this.resolveCachedMinOrderSize(cmd.tokenId);
    if (cachedMinOrderSize != null) return cachedMinOrderSize;

    const metadata = cmd.metadata;
    if (!metadata || typeof metadata !== "object") return null;
    const marketData = (metadata as Record<string, unknown>).marketData;
    if (!marketData || typeof marketData !== "object") return null;
    const rawMarketData = marketData as Record<string, unknown>;
    const value = rawMarketData.minOrderSize;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    return null;
  }

  private resolveCachedMinOrderSize(tokenId: TokenId): number | null {
    const value = this.marketCache.get(String(tokenId))?.minOrderSize;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  }

  private recordOrderSkipped(
    cmd: PlaceOrderCommand,
    reasonCode: string,
    details: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.deps.riskEventRepo?.insert({
        eventType: "order_skipped",
        payload: {
          commandId: String(cmd.commandId),
          clientOrderId: String(cmd.clientOrderId),
          tokenId: String(cmd.tokenId),
          conditionId: String(cmd.conditionId),
          reasonCode,
          side: cmd.side,
          price: cmd.price,
          size: cmd.size,
          signalReason: cmd.signalReason ?? null,
          signalId: cmd.signalId ?? null,
          decisionRuleId: cmd.decisionRuleId ?? null,
          signalTimestamp: cmd.signalTimestamp ?? null,
          ...details,
          skippedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      this.log.warn(
        { err, commandId: String(cmd.commandId), reasonCode },
        "failed to persist order_skipped risk event",
      );
    }
  }

  private recordBuyCounter(
    metricName: "buy_duplicate_deduped" | "buy_cap_full_targeted_replacement",
    cmd: PlaceOrderCommand,
    extraLabels: Readonly<Record<string, string>> = {},
  ): void {
    this.deps.runtimeMetrics?.writeCounter?.(
      metricName,
      1,
      JSON.stringify({
        signalReason: boundedMetricLabel(cmd.signalReason),
        decisionRuleId: boundedMetricLabel(cmd.decisionRuleId),
        ...extraLabels,
      }),
    );
  }

  private static looksLikeMinSizeError(
    message: string | null | undefined,
    details: unknown,
  ): boolean {
    const parts: string[] = [];
    if (typeof message === "string") parts.push(message);
    if (details != null) {
      try {
        parts.push(JSON.stringify(details));
      } catch {
        /* ignore */
      }
    }
    const lower = parts.join(" ").toLowerCase();
    return (
      lower.includes("lower than the minimum") ||
      lower.includes("invalid size") ||
      lower.includes("min order size") ||
      lower.includes("size must")
    );
  }

  private async deferSellReplacementIfNeeded(cmd: PlaceOrderCommand): Promise<boolean> {
    if (cmd.side !== "sell") return false;
    // Bounce-exit backstop force-exit (docs/plans/2026-07-16-bounce-exit-ladder-
    // redesign.md) bypasses the generic reprice-threshold/lock/chain-cap gating
    // below entirely — signal-to-order.ts already explicitly cancels the resting
    // BOUNCE_EXIT_TARGET order before submitting this taker command, and the
    // ExecutionQueue's per-token mutex (execution-queue.ts) independently
    // guarantees the cancel executes before this place does, regardless of
    // whether orderRepo has caught up with the cancel by the time this runs.
    //
    // A regular (non-backstop) bounce ladder rung bypasses this gate too: this
    // method's "keep one live price per token" model was built for the old
    // single-resting-SELL exit and would otherwise treat a second/third rung
    // as a "replacement" of whichever rung is already open (existingSells[0]),
    // cancelling it before the multi-rung capacity carve-out
    // (resolveMaxOpenSellOrdersPerToken) ever runs — defeating N-rung
    // coexistence entirely. Each BOUNCE_EXIT_TARGET command reaching here is,
    // by construction, a brand-new rung at a rung-specific price, never a
    // reprice of an already-placed one — signal-to-order.ts's
    // findDuplicateBounceRungOrder already scopes duplicate detection to the
    // same ladderId+rungIndex (a different rung is never treated as a
    // duplicate there), and the exchange-level deterministic clientOrderId
    // hash independently guards against a true resubmit of the same rung.
    if (
      isBounceForceExit({ side: cmd.side, decisionRuleId: cmd.decisionRuleId ?? null }) ||
      cmd.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID
    ) {
      return false;
    }
    if (this.isSellReplacementSubmit(cmd)) return false;

    // Normal exit management keeps one live price per token and replaces it
    // when strategy moves. The per-token SELL cap is a race/legacy-state
    // ceiling, not permission to stack multiple independent exit prices.
    const existingSells = this.findOpenSellOrdersForToken(cmd.tokenId, cmd.positionId ?? null);
    const key = String(cmd.tokenId);
    const profileLadderOldOrderId = this.getProfileLadderReplacementOldOrderId(cmd);
    if (profileLadderOldOrderId != null) {
      const validation = this.validateProfileLadderReplacementTarget(
        profileLadderOldOrderId,
        existingSells,
      );
      if (!validation.ok) {
        await this.rejectOrder(cmd, validation.reason, ExchangeErrorCode.LivePolicyBlocked);
        return true;
      }
    }
    if (existingSells.length === 0) {
      this.sellReplaceLocks.delete(key);
      return false;
    }

    const existingSell =
      profileLadderOldOrderId == null
        ? existingSells[0]!
        : existingSells.find((order) => orderMatchesOrderId(order, profileLadderOldOrderId))!;
    const policy = this.deps.executionPolicy?.();
    const now = Date.now();
    const repriceThreshold = resolveSellRepriceThreshold(existingSell.price, cmd.tickSize, policy);
    if (repriceThreshold === null) {
      this.log.warn(
        {
          tokenId: String(cmd.tokenId),
          existingOrderId: String(existingSell.orderId),
          existingPrice: existingSell.price,
          requestedPrice: cmd.price,
          tickSize: cmd.tickSize,
        },
        "sell replacement suppressed — invalid reprice threshold inputs",
      );
      await this.rejectOrder(
        cmd,
        "sell-replace-invalid-threshold",
        ExchangeErrorCode.LivePolicyBlocked,
      );
      return true;
    }
    const anchorDelta = Math.abs(existingSell.price - cmd.price);
    const timeoutSizeReplacement = isSellTimeoutReplacement({
      existingOrder: existingSell,
      requestedSize: cmd.size,
      nowMs: now,
      sellTimeoutMs: policy?.sellTimeoutMs,
    });
    if (anchorDelta <= repriceThreshold.thresholdAbs && !timeoutSizeReplacement) {
      this.deps.runtimeMetrics?.writeCounter?.(
        "exit_reprice_suppressed_threshold_total",
        1,
        JSON.stringify({ source: "sell_replace" }),
      );
      await this.rejectOrder(
        cmd,
        "sell-order-acceptable-price-already-open",
        ExchangeErrorCode.LivePolicyBlocked,
      );
      return true;
    }

    const existingLock = this.sellReplaceLocks.get(key);
    if (
      existingLock &&
      now - existingLock.createdAt < ExecutionModule.SELL_REPLACE_LOCK_TIMEOUT_MS
    ) {
      await this.rejectOrder(cmd, "sell-replace-lock-active", ExchangeErrorCode.LivePolicyBlocked);
      return true;
    }

    // CHANGE C — R65 p90 = 13 reprice events / 24h cap. Enforce on both the
    // initial sell_replace_reprice publish and on sell_replace_retry, so a
    // long-running lock cannot extend the chain past the ceiling.
    if (this.deps.legStateRepo && this.deps.repriceChainPolicy) {
      const policy = this.deps.repriceChainPolicy();
      const market = this.marketCache.get(key) ?? null;
      const cap = resolveDynamicChainCapDetails(market, policy);
      const effectivePolicy = { ...policy, maxChainCount: cap.maxChainCount };
      this.recordExitChainCapResolved(
        cap.bucket,
        existingLock
          ? "sell_replace_retry"
          : timeoutSizeReplacement
            ? "sell_timeout"
            : "sell_replace",
      );
      const legState = this.deps.legStateRepo.get(cmd.tokenId);
      if (shouldBlockRepriceChain(legState, now, effectivePolicy)) {
        try {
          this.deps.riskEventRepo?.insert({
            eventType: "signal_suppressed",
            payload: {
              tokenId: String(cmd.tokenId),
              orderId: String(existingSell.orderId),
              reasonCode: "sell-replace-chain-cap",
              source: existingLock
                ? "sell_replace_retry"
                : timeoutSizeReplacement
                  ? "sell_timeout_escalation"
                  : "sell_replace_reprice",
              count24h: legState?.repriceChainCount24h ?? 0,
              maxChainCount: effectivePolicy.maxChainCount,
              dynamicCapBucket: cap.bucket,
              publicTradeCount24h: cap.publicTradeCount24h,
              signalTimestamp: new Date(now).toISOString(),
            },
          });
        } catch (err) {
          this.log.warn(
            { err, tokenId: String(cmd.tokenId) },
            "failed to persist sell-replace-chain-cap risk event",
          );
        }
        await this.rejectOrder(cmd, "sell-replace-chain-cap", ExchangeErrorCode.LivePolicyBlocked);
        return true;
      }
    }

    this.sellReplaceLocks.set(key, { orderId: existingSell.orderId, command: cmd, createdAt: now });
    await this.deps.bus.publish("CancelOrderRequested", {
      command: {
        type: "CancelOrderCommand",
        commandId: createCommandId(`sell-replace-${String(existingSell.orderId)}-${now}`),
        orderId: existingSell.orderId,
        reason: existingLock
          ? "sell_replace_retry"
          : timeoutSizeReplacement
            ? "sell_timeout_escalation"
            : "sell_replace_reprice",
      },
      timestamp: now,
    });
    await this.rejectOrder(
      cmd,
      existingLock ? "sell-replace-lock-retry" : "sell-replace-pending",
      ExchangeErrorCode.LivePolicyBlocked,
    );
    return true;
  }

  /**
   * `positionId` omitted (not even `null`) = unscoped — every working SELL for
   * the token, regardless of cycle. Passing `cmd.positionId ?? null` (even
   * `null`) scopes the result to orders sharing that exact cycle, so a cancel
   * side effect can never target a different cycle's order by token match
   * alone. `handlePositionUpdated`'s loss-floor re-eval deliberately calls this
   * unscoped: a below-floor resting SELL is unconditionally worth cancelling
   * regardless of cycle ownership, and scoping it could leave a stale/legacy
   * below-floor order unmonitored.
   */
  private findOpenSellOrdersForToken(tokenId: TokenId, positionId?: string | null): Order[] {
    return this.deps.orderRepo
      .findByTokenId(tokenId)
      .filter(
        (order) =>
          order.side === "sell" &&
          (order.status === "pending" ||
            order.status === "open" ||
            order.status === "partially-filled") &&
          !isExitRecoveryFencedPredecessor(order) &&
          this.matchesPositionCycle(order.positionId, positionId),
      );
  }

  private isSellReplacementSubmit(cmd: PlaceOrderCommand): boolean {
    return (
      cmd.side === "sell" &&
      typeof cmd.metadata?.[ExecutionModule.SELL_REPLACEMENT_CANCELLED_ORDER_ID] === "string"
    );
  }

  private getProfileLadderReplacementOldOrderId(cmd: PlaceOrderCommand): string | null {
    const metadata = cmd.metadata;
    if (metadata == null || typeof metadata !== "object") return null;
    const replacement = metadata.profileLadderReplacement;
    if (replacement == null || typeof replacement !== "object") return null;
    const oldOrderId = (replacement as Readonly<Record<string, unknown>>).oldOrderId;
    return typeof oldOrderId === "string" && oldOrderId.length > 0 ? oldOrderId : null;
  }

  private validateProfileLadderReplacementTarget(
    oldOrderId: string,
    existingSells: readonly Order[],
  ): { ok: true } | { ok: false; reason: string } {
    return validateProfileLadderReplacementSellTarget(oldOrderId, existingSells);
  }

  private async releasePendingSellReplacement(cancelledOrderId: OrderId): Promise<void> {
    for (const [tokenKey, lock] of this.sellReplaceLocks) {
      if (lock.orderId !== cancelledOrderId) continue;
      this.sellReplaceLocks.delete(tokenKey);
      const replacement: PlaceOrderCommand = {
        ...lock.command,
        commandId: createCommandId(`sell-replace-submit-${String(cancelledOrderId)}-${Date.now()}`),
        metadata: {
          ...(lock.command.metadata ?? {}),
          [ExecutionModule.SELL_REPLACEMENT_CANCELLED_ORDER_ID]: String(cancelledOrderId),
        },
      };
      await this.deps.bus.publish("PlaceOrderRequested", {
        command: replacement,
        timestamp: Date.now(),
      });
      return;
    }
  }

  private recordExitChainCapResolved(bucket: string, source: string): void {
    this.deps.runtimeMetrics?.writeCounter?.(
      "exit_chain_cap_resolved_total",
      1,
      JSON.stringify({ bucket, source }),
    );
  }

  /**
   * Telemetry for the exit loss-floor gate (docs/plans/2026-07-20-exit-loss-
   * floor.md §Phase 7). `exit_loss_floor_blocked` is the one CONFIRMED-dump
   * reason `evaluateExitLossFloor` returns; every other reason means the
   * inputs needed to evaluate the floor were missing/inconsistent, so the
   * gate failed CLOSED without confirming an actual loss — tracked
   * separately so an operator can tell "we caught a dump" apart from "we
   * couldn't read cost basis" (the latter should be ~0 in steady state, per
   * the plan's prod baseline).
   */
  private recordExitLossFloorCounter(reason: string | null, phase: ExitLossFloorPhase): void {
    const metricName =
      reason === "exit_loss_floor_blocked"
        ? "exit_loss_floor_blocked_total"
        : "exit_loss_floor_cost_unavailable_total";
    this.deps.runtimeMetrics?.writeCounter?.(metricName, 1, JSON.stringify({ reason, phase }));
  }

  /**
   * Operator-visible risk event for a loss-floor STOP (code-review finding #5):
   * a counter alone is easy to miss, but a blocked exit SELL — or a fail-closed
   * data inconsistency that prevents one — is a money-critical event that must
   * surface in the risk log. Best-effort: a risk-event write failure must never
   * break the (already-correct) block decision.
   */
  private recordExitLossFloorRiskEvent(
    reason: string | null,
    phase: ExitLossFloorPhase,
    context: Record<string, unknown>,
  ): void {
    try {
      this.deps.riskEventRepo?.insert({
        eventType:
          reason === "exit_loss_floor_blocked"
            ? "exit_loss_floor_blocked"
            : "exit_loss_floor_cost_unavailable",
        payload: { reason, phase, ...context, occurredAt: new Date().toISOString() },
      });
    } catch (riskErr) {
      this.log.error(
        { err: riskErr, phase, reason },
        "failed to persist exit-loss-floor risk event",
      );
    }
  }

  private async rejectOrder(
    cmd: PlaceOrderCommand,
    reason: string,
    errorCode: ExchangeErrorCode,
  ): Promise<void> {
    this.clearPendingDeferredSubmit(cmd); // finding 1 (round 7): any reject resolves the submit marker
    await this.publishOrderRejected(cmd, { reason, errorCode, timestamp: Date.now() });
    this.maybeIncrementDustCounterForExecutionReject(cmd, reason);
  }

  private maybeIncrementDustCounterForExecutionReject(
    cmd: PlaceOrderCommand,
    reason: string,
  ): void {
    if (cmd.side !== "sell") return;
    if (reason !== SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON) return;
    const position = this.deps.positionRepo?.findByTokenId(cmd.tokenId);
    const minOrderSize = this.resolveCommandMinOrderSize(cmd);
    if (!position || !isPositionDust(position.size, minOrderSize)) return;
    const legStateRepo = this.deps.legStateRepo;
    const executionPolicy = this.deps.executionPolicy;
    if (!legStateRepo || !executionPolicy) return;
    const dustPolicy = executionPolicy().dustAbandonment;
    if (!dustPolicy.enabled) return;
    const nowIso = new Date().toISOString();
    const price = resolvePriceFromCmd(cmd);
    try {
      legStateRepo.incrementSellResidualReject(cmd.tokenId, nowIso, {
        threshold: dustPolicy.maxConsecutiveRejects,
        price,
      });
    } catch (err) {
      this.log.warn(
        { err, tokenId: cmd.tokenId, reason },
        "execution-level dust counter increment failed",
      );
    }
  }

  private async publishOrderRejected(
    cmd: PlaceOrderCommand,
    params: {
      reason: string;
      errorCode: ExchangeErrorCode;
      timestamp: number;
      exchangeErrorMessage?: string | null;
      exchangeErrorDetails?: Readonly<Record<string, unknown>> | null;
    },
  ): Promise<void> {
    await this.deps.bus.publish("OrderRejected", {
      commandId: cmd.commandId,
      clientOrderId: cmd.clientOrderId,
      tokenId: cmd.tokenId,
      conditionId: cmd.conditionId,
      reason: params.reason,
      errorCode: params.errorCode,
      signalReason: cmd.signalReason ?? null,
      side: cmd.side,
      signalId: cmd.signalId ?? null,
      decisionRuleId: cmd.decisionRuleId ?? null,
      signalTimestamp: cmd.signalTimestamp ?? null,
      exchangeErrorMessage: params.exchangeErrorMessage ?? null,
      exchangeErrorDetails: params.exchangeErrorDetails ?? null,
      timestamp: params.timestamp,
    });
  }

  private recordGatewayReject(errorCode: string): void {
    this.gatewayRejects.push({ ts: Date.now(), code: errorCode });
    this.pruneDiagnosticsWindows();
  }

  private handleExchangeBalanceRejection(
    cmd: PlaceOrderCommand,
    payload: {
      errorCode: ExchangeErrorCode | null;
      errorMessage: string | null;
      errorDetails: Readonly<Record<string, unknown>> | null;
    },
  ): void {
    if (cmd.side !== "sell") return;
    const isInsufficient =
      payload.errorCode === ExchangeErrorCode.InsufficientBalance ||
      isExchangeBalanceRejection(payload);
    if (!isInsufficient) return;
    const enabled = this.deps.sellBalanceRejectBlockEnabled !== false;
    const store = this.deps.exchangeStateStore;
    const block = enabled && store ? store.markBalanceReject(cmd.tokenId) : null;
    this.deps.runtimeMetrics?.writeEvent(
      "exchange_balance_reject_count",
      1,
      JSON.stringify({ tokenId: String(cmd.tokenId), side: cmd.side }),
      new Date().toISOString(),
    );
    this.log.warn(
      {
        tokenId: String(cmd.tokenId),
        commandId: cmd.commandId,
        blockedUntilMs: block?.blockedUntilMs ?? null,
        rejectCount: block?.count ?? null,
      },
      "exchange rejected SELL for balance/allowance — token put in cool-down",
    );
    // Trigger an immediate reconcile so the next SELL evaluates against the
    // refreshed wallet/exchange snapshot rather than waiting for the next tick.
    try {
      this.deps.reconciliationTrigger?.();
    } catch (err) {
      this.log.debug({ err }, "reconciliation trigger threw — ignoring");
    }
  }

  private gatewayRejectReason(
    errorCode: ExchangeErrorCode | undefined,
    message: string | undefined,
  ): string {
    const lower = (message ?? "").toLowerCase();
    if (
      errorCode === ExchangeErrorCode.InsufficientBalance &&
      lower.includes("balance") &&
      lower.includes("allowance")
    ) {
      return "exchange-insufficient-balance-or-allowance";
    }
    return message ?? "unknown";
  }

  private recordInternalReservationReject(reason: string): void {
    this.internalReservationRejects.push({ ts: Date.now(), reason });
    this.pruneDiagnosticsWindows();
  }

  // count + by-reason from ONE pruned window so the two diagnostic fields can never disagree at a
  // 10-minute boundary (two separate getters each pruning with their own Date.now() could).
  private getInternalReservationRejectsSnapshot(): {
    count: number;
    byReason: Record<string, number>;
  } {
    this.pruneDiagnosticsWindows();
    const byReason: Record<string, number> = {};
    for (const reject of this.internalReservationRejects) {
      byReason[reject.reason] = (byReason[reject.reason] ?? 0) + 1;
    }
    return { count: this.internalReservationRejects.length, byReason };
  }

  private getGatewayRejectsLast10mByCode(): Record<string, number> {
    this.pruneDiagnosticsWindows();
    const counts: Record<string, number> = {};
    for (const reject of this.gatewayRejects) {
      counts[reject.code] = (counts[reject.code] ?? 0) + 1;
    }
    return counts;
  }

  private pruneDiagnosticsWindows(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    while (this.gatewayRejects.length > 0 && this.gatewayRejects[0]!.ts < cutoff) {
      this.gatewayRejects.shift();
    }
    while (
      this.internalReservationRejects.length > 0 &&
      this.internalReservationRejects[0]!.ts < cutoff
    ) {
      this.internalReservationRejects.shift();
    }
  }

  private pruneProcessedCommandIds(): void {
    if (this.processedCommandIds.size > 10_000) {
      const toRemove = this.processedCommandOrder.splice(0, 1000);
      for (const id of toRemove) {
        this.processedCommandIds.delete(id);
      }
    }
  }

  /**
   * Bounds `cancelReservations` for a long-running process — entries for
   * successfully cancelled orders are retained (per the idempotency design in
   * executeCancel) rather than cleared, so without this the set would grow
   * for the lifetime of the bot. Mirrors `pruneProcessedCommandIds`'s
   * cap/evict-batch sizing. Set iteration order is insertion order, so the
   * oldest entries are evicted first.
   */
  private pruneCancelReservations(): void {
    if (this.cancelReservations.size <= 10_000) return;
    let removed = 0;
    for (const key of this.cancelReservations) {
      if (removed >= 1000) break;
      this.cancelReservations.delete(key);
      removed++;
    }
  }

  private buildOrder(
    cmd: PlaceOrderCommand,
    status: "open" | "rejected",
    exchangeOrderId: string | null,
    exchangeError?: {
      errorCode: string;
      errorMessage: string | null;
      errorDetails: Readonly<Record<string, unknown>> | null;
      rejectionReason?: string | null;
    },
  ): Order {
    const now = new Date().toISOString();
    const order: Order = {
      orderId: exchangeOrderId
        ? createOrderId(exchangeOrderId)
        : createOrderId(`rej-${cmd.commandId}`),
      clientOrderId: cmd.clientOrderId,
      tokenId: cmd.tokenId,
      conditionId: cmd.conditionId,
      positionId: cmd.positionId ?? null,
      side: cmd.side,
      orderType: cmd.orderType,
      postOnly: cmd.postOnly === true,
      price: cmd.price,
      size: cmd.size,
      sizeUsdc: cmd.size * cmd.price,
      status,
      fillProgressShares: status === "rejected" ? 0 : null,
      exchangeOrderId,
      signalId: cmd.signalId ?? null,
      signalReason: cmd.signalReason ?? null,
      decisionRuleId: cmd.decisionRuleId ?? null,
      signalTimestamp: cmd.signalTimestamp ?? null,
      entryStyle: cmd.entryStyle ?? null,
      exchangeErrorCode: exchangeError?.errorCode ?? null,
      exchangeErrorMessage: exchangeError?.errorMessage ?? null,
      exchangeErrorPayload: stringifyExchangeErrorPayload(exchangeError?.errorDetails ?? null),
      exchangeRejectionReason: exchangeError?.rejectionReason ?? null,
      metadata: cmd.metadata ?? null,
      botRunId: this.deps.botRunId,
      createdAt: now,
      updatedAt: now,
    };
    return this.stampMakerCaptureLineage(order, cmd, status);
  }

  /**
   * Phase 2: one-shot retry for rejection_invalid_tick, called from the rejection
   * branch BEFORE orderRepo.save(). Hard cap = 1 (the caller returns immediately on
   * `true`; it cannot be called again for the same executePlace invocation).
   * Returns true when a retry was attempted so the caller can return; false when a
   * pre-submit guard blocks the retry (caller falls through to persist the original
   * rejection normally).
   */
  private async retryAfterInvalidTick(
    cmd: PlaceOrderCommand,
    firstAttemptTick: number,
    firstPlaceParams: PlaceOrderParams,
    nowMs: number,
    rejectedPreparedOrder?: Order,
  ): Promise<boolean> {
    if (!this.deps.tickResolver) return false;

    // Evict the stale cache entry — the CLOB just confirmed the tick was wrong.
    this.deps.tickResolver.invalidate(cmd.conditionId);
    const retryTick = await this.deps.tickResolver.resolve(
      cmd.conditionId,
      cmd.tickSize,
      cmd.tokenId,
    );

    // M4: if the resolver returned the same tick as the first attempt (e.g.
    // all CLOB lookups failed and it fell back to the persisted value) there
    // is nothing to improve — skip the retry to avoid a guaranteed second rejection.
    if (retryTick === firstAttemptTick) {
      this.log.warn(
        { commandId: cmd.commandId, conditionId: cmd.conditionId, retryTick },
        "invalid-tick rejection — resolved retry tick matches first attempt, skipping retry",
      );
      return false;
    }

    const retryResnap = resnapPriceToTick(cmd.price, cmd.side, retryTick);
    if (!retryResnap.valid) {
      this.log.warn(
        { commandId: cmd.commandId, conditionId: cmd.conditionId, retryTick },
        "invalid-tick rejection — re-snap invalid for retry tick, skipping retry",
      );
      return false;
    }

    // Re-run all price/tick-dependent pre-submit guards on the corrected values.
    const retryCmd = { ...cmd, price: retryResnap.price, tickSize: retryTick } as PlaceOrderCommand;
    const retryPostOnlyCross = this.getPostOnlyCrossPreSubmitSkip(retryCmd);
    const retryDuplicate =
      cmd.side === "buy"
        ? findNearDuplicateOpenBuy(this.deps.orderRepo.findOpen(), retryCmd, retryTick)
        : null;
    const retryPriceValidation = validateExecutablePrice(retryResnap.price, retryTick);

    if (retryPostOnlyCross || retryDuplicate || !retryPriceValidation.ok) {
      this.log.warn(
        {
          commandId: cmd.commandId,
          conditionId: cmd.conditionId,
          retryTick,
          retryPrice: retryResnap.price,
          blockedByPostOnlyCross: !!retryPostOnlyCross,
          blockedByDuplicate: !!retryDuplicate,
          priceValid: retryPriceValidation.ok,
        },
        "invalid-tick rejection — retry blocked by pre-submit guard",
      );
      return false;
    }

    const retryParams: PlaceOrderParams = {
      ...firstPlaceParams,
      price: retryResnap.price,
      tickSize: retryTick,
    };
    this.log.info(
      {
        commandId: cmd.commandId,
        conditionId: cmd.conditionId,
        firstAttemptTick,
        retryTick,
        retryPrice: retryResnap.price,
      },
      "invalid-tick rejection — retrying once with corrected tick/price",
    );

    // Authoritative exit loss-floor checkpoint — retry path (docs/plans/2026-
    // 07-20-exit-loss-floor.md §Phase 4, step 3). Same gate as the main
    // submit, evaluated on the retry's resnapped price/size. On block, return
    // the same "false" a pre-submit guard uses above (~:2988) so the caller
    // falls through to persist/publish the ORIGINAL invalid-tick rejection
    // exactly once — no second OrderRejected for the retry attempt.
    if (cmd.side === "sell") {
      const floorVerdict = this.evaluateSellExitLossFloor(retryCmd, retryParams.price);
      if (floorVerdict.block) {
        this.log.warn(
          {
            commandId: cmd.commandId,
            conditionId: cmd.conditionId,
            retryTick,
            submittedPrice: retryParams.price,
            effectiveSellShares: retryParams.size,
            exitLossFloorReason: floorVerdict.reason,
          },
          "exit SELL blocked by loss-floor gate — invalid-tick retry not submitted",
        );
        this.recordExitLossFloorCounter(floorVerdict.reason, "invalid-tick-retry");
        await this.publishOrderSkipped(retryCmd, "exit_loss_floor_blocked", {
          exitLossFloorReason: floorVerdict.reason,
          submittedPrice: retryParams.price,
          effectiveSellShares: retryParams.size,
          phase: "invalid-tick-retry",
        });
        return false;
      }
    }

    // Fix #1+TOCTOU — revalidate the maker-BUY at the retry submit boundary too.
    // Must return true (not false) on rejection: false would fall through to the
    // caller's ORIGINAL invalid-tick rejection path and publish a SECOND
    // OrderRejected for the same command. rejectOrder here is the only
    // OrderRejected for this command.
    const retryRej = this.makerBuyLiveRejection(retryCmd, retryParams.price * retryParams.size);
    if (retryRej) {
      this.log.warn(
        { commandId: cmd.commandId, reason: retryRej.reason },
        "maker BUY rejected at invalid-tick retry submit",
      );
      await this.rejectOrder(retryCmd, retryRej.reason, retryRej.code);
      return true;
    }

    // Release A Phase 3: bounce-exclusivity / position-identity guard (invalid-tick
    // retry). Return true (like the maker guard above) so this rejectOrder is the
    // ONLY OrderRejected for the command, not a second one over the original path.
    const exitOwnerRejRetry = this.exitOwnerIdentityRejection(retryCmd);
    if (exitOwnerRejRetry) {
      this.log.warn(
        { commandId: cmd.commandId, reason: exitOwnerRejRetry.reason },
        "order rejected — exit-owner/position-identity guard (invalid-tick retry)",
      );
      await this.rejectOrder(retryCmd, exitOwnerRejRetry.reason, exitOwnerRejRetry.code);
      return true;
    }

    // Release A Phase 3 (P6): transition-barrier guard (invalid-tick retry).
    // Return true (like the guards above) so this rejectOrder is the ONLY
    // OrderRejected for the command, not a second one over the original path.
    const transitionRejRetry = await this.transitionRejection(retryCmd);
    if (transitionRejRetry) {
      this.log.warn(
        { commandId: cmd.commandId, reason: transitionRejRetry.reason },
        "order rejected — token transition draining (invalid-tick retry)",
      );
      await this.rejectOrder(retryCmd, transitionRejRetry.reason, transitionRejRetry.code);
      return true;
    }

    // Finding 2 (round 6-7): a deferred backstop reaching the gateway via the invalid-tick
    // retry path is a real submit too — count + set grace at this boundary.
    if (retryCmd.metadata?.["__deferredBackstop"] === true) {
      const tk = String(retryCmd.tokenId);
      this.lastDeferredPlaceAt.set(tk, Date.now());
      this.deferredBackstopRetries.set(tk, (this.deferredBackstopRetries.get(tk) ?? 0) + 1);
    }

    const retryPreparedLive = await this.submitPreparedLiveOrder(
      retryCmd,
      retryParams,
      rejectedPreparedOrder,
    );
    if (retryPreparedLive?.submit.kind === "unknown") return true;
    const retryResult = retryPreparedLive
      ? this.preparedSubmitResultToPlaceOrderResult(retryPreparedLive.submit)
      : await this.deps.gateway.placeOrder(retryParams);

    if (retryResult.success) {
      await this.applyTickCorrection(cmd.conditionId, cmd.tokenId, retryTick);

      if (!retryResult.orderId || retryResult.orderId.trim().length === 0) {
        // Success with no orderId — same treatment as the main path (lines ~1028+).
        const exchangeErrorDetails = { responseBody: null, reason: "missing-order-id" };
        const exchangeRejectionReason = this.classifyExchangeRejection(
          exchangeErrorDetails,
          cmd.commandId,
        );
        const rejectedOrder = this.buildOrder(retryCmd, "rejected", null, {
          errorCode: ExchangeErrorCode.Unknown,
          errorMessage: "gateway returned success without order id",
          errorDetails: exchangeErrorDetails,
          rejectionReason: exchangeRejectionReason,
        });
        this.deps.orderRepo.save(rejectedOrder);
        await this.publishOrderRejected(cmd, {
          reason: "gateway returned success without order id",
          errorCode: ExchangeErrorCode.Unknown,
          exchangeErrorMessage: "gateway returned success without order id",
          exchangeErrorDetails,
          timestamp: nowMs,
        });
        return true;
      }

      const orderId = createOrderId(retryResult.orderId);
      if (retryPreparedLive) {
        this.persistPreparedAcceptedOrder(retryCmd, retryPreparedLive.pending, retryResult.orderId);
      } else {
        const order = this.buildOrder(retryCmd, "open", retryResult.orderId);
        this.persistAcceptedOrderOrThrow(retryCmd, order, retryResult.orderId);
      }
      this.log.info(
        { commandId: cmd.commandId, orderId: retryResult.orderId },
        "order placed (invalid-tick retry)",
      );
      await this.deps.bus.publish("OrderPlaced", {
        commandId: cmd.commandId,
        clientOrderId: cmd.clientOrderId,
        orderId,
        tokenId: cmd.tokenId,
        conditionId: cmd.conditionId,
        side: cmd.side,
        price: retryCmd.price,
        size: cmd.size,
        orderType: cmd.orderType,
        signalReason: cmd.signalReason ?? null,
        timestamp: nowMs,
      });
      if (
        !this.deps.runtimeMode ||
        this.deps.runtimeMode === "simulation" ||
        this.deps.runtimeMode === "paper"
      ) {
        await this.checkForFills(orderId);
      }
      return true;
    }

    // Retry also failed — persist using the retry's (final) price and tick.
    const retryErrorCode = retryResult.errorCode ?? ExchangeErrorCode.Unknown;
    this.recordGatewayReject(retryErrorCode);
    const retryErrorDetails = retryResult.errorDetails ?? null;
    const retryRejectionReason = this.classifyExchangeRejection(retryErrorDetails, cmd.commandId);
    const rejectedOrder = retryPreparedLive
      ? this.buildPreparedOrder(
          retryCmd,
          retryParams,
          retryPreparedLive.pending.orderId,
          "rejected",
          {
            errorCode: retryErrorCode,
            errorMessage:
              retryResult.errorMessage ??
              this.gatewayRejectReason(retryResult.errorCode, retryResult.errorMessage),
            errorDetails: retryErrorDetails,
            rejectionReason: retryRejectionReason,
          },
        )
      : this.buildOrder(retryCmd, "rejected", null, {
          errorCode: retryErrorCode,
          errorMessage:
            retryResult.errorMessage ??
            this.gatewayRejectReason(retryResult.errorCode, retryResult.errorMessage),
          errorDetails: retryErrorDetails,
          rejectionReason: retryRejectionReason,
        });
    this.deps.orderRepo.save(rejectedOrder);
    await this.publishOrderRejected(cmd, {
      reason: this.gatewayRejectReason(retryResult.errorCode, retryResult.errorMessage),
      errorCode: retryErrorCode,
      exchangeErrorMessage: retryResult.errorMessage ?? null,
      exchangeErrorDetails: retryErrorDetails,
      timestamp: nowMs,
    });
    return true;
  }

  private classifyExchangeRejection(
    payload: Readonly<Record<string, unknown>> | null,
    commandId: string,
  ): string {
    const reason = classifyExchangeRejectionReason(payload);
    if (reason === "rejection_unknown" && getExchangeRejectionPayloadText(payload) != null) {
      this.log.warn(
        { commandId, exchangeErrorDetails: payload },
        "unknown exchange rejection reason -- classifier needs a new pattern",
      );
    }
    return reason;
  }
}

function stringifyExchangeErrorPayload(
  payload: Readonly<Record<string, unknown>> | null,
): string | null {
  if (!payload) return null;
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function errorToLogMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown persistence error";
  }
}
