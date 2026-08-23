import type { OrderSide, OrderStatus, ProfileId, SwitchState } from "./enums.js";
import type {
  FillId,
  OrderId,
  PositionId,
  TokenId,
  SwitchId,
  ReportId,
  ImportId,
  ConditionId,
} from "./ids.js";
import type {
  CancelAgeBucket,
  Fill,
  InventoryLot,
  Market,
  MarketResolution,
  MarketSnapshot,
  OperatorAction,
  OperatorCommand,
  Order,
  Position,
  PositionDrift,
  ExecutionPolicyObservation,
  Profile,
  ProfileSettings,
  ProfileSummary,
  RuntimeControlState,
  SwitchRequest,
  PreflightReport,
  ServiceHeartbeat,
  ConfigImport,
  AlgoDecisionRule,
  AlgoSizeRule,
  DecisionSignalLog,
  LegState,
  LegStateTransition,
  AlgoTokenModeState,
  OrderPriceCooldown,
  SettlementRecord,
  MarketBookSource,
} from "./types.js";
import type { TradingCalendarException, TradingCalendarMetadata } from "./effective-resolution.js";
import { toCanonicalIso } from "./timestamp.js";

/**
 * ADR-025 §D-B telemetry payload, persisted on transition into
 * `cancelled`. Every field is independently nullable: a missing
 * cancel-age (e.g. malformed `createdAt`) does not block the
 * cancel write itself.
 */
export interface OrderCancelTelemetry {
  cancelAgeMs: number | null;
  cancelAgeBucket: CancelAgeBucket | null;
  fillProgressShares: number | null;
  marketHorizon: string | null;
}

// ─── MarketRepository ────────────────────────────────────────────────────

/**
 * Tiered result from `findTrackedForPricingTiered`.
 * `executionCritical + entryCandidates` feed the WS stream (bounded by maxTokens).
 * `discoveryOnly` is polled via Gamma in rolling batches.
 */
export interface TrackedForPricing {
  /** Markets with open/dust positions or pending/open orders — never dropped from WS. */
  executionCritical: Market[];
  /**
   * Signature-matching markets (spec 2026-07-01). When `opts.reserveSignature`
   * is true (live/default), these are pulled out of the V4 pool and given a
   * guaranteed live slot before V4 ranking. When `opts.reserveSignature` is
   * false (shadow mode), this is a measurement projection ONLY — these markets
   * are left in the V4 pool and flow into `entryCandidates`/`discoveryOnly` on
   * their own merit, exactly as they would without the signature feature.
   */
  planktonSignature: Market[];
  /** Active+tradable markets up to the remaining cap after executionCritical. */
  entryCandidates: Market[];
  /** Active+tradable markets beyond the cap — polled via discovery loop, not WS. */
  discoveryOnly: Market[];
  /** Count of signature-matching markets that did NOT get a live slot (coverage metric denominator). */
  signatureOverflow: number;
}

/**
 * Thresholds gating the reserved plankton-signature tier (spec 2026-07-01 §4.1/§4.2).
 * All fields are required — callers pass a fully-resolved config, defaults live
 * with the repository implementation.
 */
export interface SignatureThresholds {
  minLiquidity: number;
  minMid: number;
  maxMid: number;
  minRemainingDays: number;
  minVol24h: number;
  minTick: number;
  featureTtlMs: number;
}

export interface MarketRepository {
  /** Insert or update a market record. tokenId is the primary key. */
  save(market: Market): void;

  /**
   * Batch upsert in a single SQL transaction with a cached prepared statement.
   * Scanner write path: replaces per-token `save()` calls with one commit per
   * page to reduce commit count and allocation churn during the scan cycle.
   */
  saveBatch(markets: readonly Market[]): void;

  /** Find a market by its CLOB token ID (primary key). */
  findByTokenId(tokenId: TokenId): Market | null;

  /** Find markets by multiple token IDs (bulk lookup). */
  findByTokenIds(tokenIds: TokenId[]): Market[];

  /** Find all markets belonging to a condition (YES + NO outcome rows). */
  findByConditionId(conditionId: string): Market[];

  /** Find all markets currently marked active. */
  findActive(): Market[];

  /**
   * Iterate token IDs of every active market one at a time (cursor-based).
   * Preferred over `findActive()` during large scans to avoid materialising the
   * full tracked slice (~115k Market objects) simultaneously with other scan
   * state — reduces scanner transient peak anon-rss by ~70 MB per cycle.
   */
  iterateActiveTokenIds(): IterableIterator<TokenId>;

  /**
   * Iterate token IDs of every market (active OR inactive). Used by the scanner
   * to detect "first sighting" of a token — newly discovered tokens not present
   * in the result set drive the `discoveryLatencyMs` telemetry.
   */
  iterateAllTokenIds(): IterableIterator<TokenId>;

  /** Return every market row, active or inactive. */
  findAll(): Market[];

  /** Mark a market as inactive (active = 0). Used when a market resolves. */
  deactivate(tokenId: TokenId): void;

  /**
   * Deactivate every currently-active market whose token_id is NOT in
   * `discoveredTokenIds` AND NOT in `preservedTokenIds`, in a single SQL batch.
   * Returns the count of rows deactivated. Preferred over scanner-side loops
   * because it avoids loading Market rows into JS only to write them back.
   */
  deactivateMissing(
    discoveredTokenIds: ReadonlySet<string>,
    preservedTokenIds: ReadonlySet<string>,
    updatedAt: string,
  ): number;

  /**
   * Return all markets that need live pricing: tradable markets plus any with
   * an open position or open/pending order. Used by the pricing loop so it
   * never drops a market mid-trade even when `tradable` flips to false.
   *
   * @deprecated Use `findTrackedForPricingTiered` instead — this flat version
   *   returns the unbounded tradable universe and is kept only for existing tests
   *   and simulation/paper mode compatibility.
   */
  findTrackedForPricing(): Market[];

  /**
   * Return markets split into three tiers for bounded pricing subscription.
   *
   * **Tier semantics (v1 — available columns only):**
   *
   * 1. `executionCritical` — markets with an open/dust position OR pending/open
   *    order. Always included regardless of the cap. Expected cardinality 0–50.
   *
   * 2. `entryCandidates` — `active=1 AND tradable=1` markets NOT in
   *    executionCritical, ordered by:
   *    - `selection_status` priority: `matched_include` (0) >
   *      legacy `step2_fallback_include` (1) > `unknown` (2)
   *    - `created_at DESC` within the same tier
   *    - `token_id ASC` as a deterministic tie-break
   *    Filled greedily up to `maxTokens - executionCritical.length`.
   *    When `executionCritical.length >= maxTokens`, `entryCandidates` is empty.
   *
   * 3. `discoveryOnly` — every remaining `active=1 AND tradable=1` market not
   *    in the first two tiers. No LIMIT — caller polls in rolling batches.
   *
   * Ranking uses only columns present in `markets` (`ledger.sql:10-32`).
   * No join to `market_snapshots`. Liquidity-aware ranking is a follow-up.
   *
   * @param opts.maxTokens - Total WS-tier cap:
   *   `executionCritical + planktonSignature + entryCandidates ≤ maxTokens`
   *   (executionCritical is never dropped even if it exceeds maxTokens alone).
   * @param opts.signatureReserve - Max number of slots reserved for the
   *   plankton-signature tier (computed before the V4 admit/reject split,
   *   spec 2026-07-01 §4.1). Defaults to the repository's own constant.
   * @param opts.signature - Thresholds gating signature-tier membership.
   *   Defaults to the repository's own constant.
   * @param opts.reserveSignature - When true (default, live behavior), signature
   *   markets are removed from the V4 pool and reserved a guaranteed live slot.
   *   When false (shadow mode), signature markets stay in the V4 pool and
   *   `entryCandidates`/`discoveryOnly` come back byte-for-byte identical to a
   *   call without the signature feature — `planktonSignature` is returned as
   *   a projection only, for the coverage metric.
   */
  findTrackedForPricingTiered(opts: {
    maxTokens: number;
    signatureReserve?: number;
    signature?: SignatureThresholds;
    reserveSignature?: boolean;
  }): TrackedForPricing;

  /**
   * Look up the event_market_count stored for a given market slug.
   * Used by the /selection-rules/match API endpoint so the debugger can
   * report the real event context instead of a biased constant.
   * Returns null if no row exists for that slug.
   */
  findEventMarketCountBySlug(slug: string): number | null;

  /**
   * Step 3 (audit doc §D3/§P2): write soft-ranking scores for one or more
   * markets in a single transaction. Owns the four score columns
   * exclusively — the saveBatch upsert path must NOT touch them. Rows
   * whose `tokenId` does not exist in `markets` are silently skipped
   * (UPDATE ... WHERE token_id = ?).
   */
  updateScoresBatch(updates: Iterable<MarketScoreUpdate>): void;

  /**
   * Narrow tick-size correction (Phase 1 of the authoritative-tick fix).
   * Writes ONLY the `tick_size` column for every token in the condition.
   * Intentionally does NOT call save()/saveBatch() to avoid broad row
   * rewrites — only touches tick_size + updated_at.
   * Rows whose `condition_id` does not exist are silently ignored.
   */
  updateTickSize(conditionId: string, tickSize: number): void;
}

// ─── Trading Calendar ─────────────────────────────────────────────────────

export interface TradingCalendarRepository {
  findException(calendarId: string, date: string): TradingCalendarException | null;
  getMetadata(calendarId: string): TradingCalendarMetadata | null;
  listExceptions(calendarId: string): TradingCalendarException[];
}

/**
 * Single soft-ranking score update. NULL is intentionally not allowed:
 * the module emits a row only when it has a fresh score; skipped markets
 * simply receive no entry.
 */
export interface MarketScoreUpdate {
  tokenId: TokenId;
  score: number;
  modelVersion: string;
  scoredAt: string; // ISO timestamp — when the model ran
  featuresCapturedAt: string; // ISO timestamp — input snapshot time
}

// ─── OrderRepository ─────────────────────────────────────────────────────

export interface OrderRepository {
  /** Persist a new order row. */
  save(order: Order): void;

  /** Find an order by its local order ID. */
  findById(id: OrderId): Order | null;

  /** Find an order by the deterministic client order ID. */
  findByClientOrderId(clientOrderId: string): Order | null;

  /** Find an order by the exchange-assigned order ID (fallback for fill matching). */
  findByExchangeOrderId(exchangeOrderId: string): Order | null;

  /** Return all orders whose status is pending or open. */
  findOpen(): Order[];

  /** Return all orders for a specific outcome token. */
  findByTokenId(tokenId: TokenId): Order[];

  /** Return the most recent orders for a specific outcome token, newest first. */
  findRecentByTokenId?(tokenId: TokenId, limit: number): Order[];

  /** Return the earliest recorded order for a specific outcome token. */
  findFirstByTokenId?(tokenId: TokenId): Order | null;

  /** Return recent orders whose signal_reason is in the supplied set, newest first. */
  findRecentBySignalReasons?(
    signalReasons: readonly string[],
    sinceIso: string,
    limit: number,
  ): Order[];

  /** Replace metadata_json for a single order identified by local order_id. */
  updateMetadata?(id: OrderId, metadata: Readonly<Record<string, unknown>>): Order;

  /** Replace metadata only when its current JSON value still matches `expectedMetadata`. */
  updateMetadataIfUnchanged?(
    id: OrderId,
    expectedMetadata: Readonly<Record<string, unknown>> | null,
    metadata: Readonly<Record<string, unknown>>,
  ): Order | null;

  /** Atomically replace metadata_json for multiple local order_id values. */
  updateMetadataBulk?(
    updates: readonly { orderId: OrderId; metadata: Readonly<Record<string, unknown>> }[],
  ): Order[];

  /**
   * Update the status, exchange_order_id, and cancellation reason of an
   * existing order. ADR-025 §D-B: when transitioning to `cancelled`,
   * callers may pass a `telemetry` payload to persist cancel-age
   * lifecycle data on the same row. Telemetry fields are written
   * verbatim — `null` is a meaningful "lookup failed" signal and is
   * preserved as such.
   */
  updateStatus(
    id: OrderId,
    status: OrderStatus,
    exchangeOrderId?: string,
    cancelReason?: string,
    telemetry?: OrderCancelTelemetry,
  ): void;

  /**
   * Replace a definitively-absent pending/rejected live order's exact exchange identity with a
   * newly prepared pending identity. The implementation must reject stale rows,
   * client-identity changes, and any row already linked to a fill.
   */
  replacePendingIdentity?(currentOrderId: OrderId, replacement: Order): void;

  /** CAS-rearm one proven absent, zero-fill cancelled recovery child. */
  replaceCancelledRecoveryIdentity?(
    currentOrderId: OrderId,
    replacement: Order,
    expectedMetadata: Readonly<Record<string, unknown>>,
  ): void;

  /** Sum the notional (size_usdc) of all open buy orders. */
  sumOpenBuyNotional(): number;

  /** Durable maker BUY usage inside one activation window, excluding one retried client identity. */
  getMakerBuyWindowUsage?(
    activatedAtUtc: string,
    expiresAtUtc: string,
    conditionId: string,
    excludeClientOrderId: string,
  ): MakerBuyWindowUsage;

  /** Atomically claim one deterministic predecessor replacement. */
  claimMakerCaptureRepriceIntent?(intent: MakerCaptureRepriceIntent): boolean;
  findRecoverableMakerCaptureRepriceIntents?(): MakerCaptureRepriceIntent[];
  findMakerCaptureRepriceIntentBySignal?(signalId: string): MakerCaptureRepriceIntent | null;
  findMakerCaptureRepriceIntentByChild?(childOrderId: OrderId): MakerCaptureRepriceIntent | null;
  findMakerCaptureRepriceIntentByPredecessor?(
    predecessorOrderId: OrderId,
  ): MakerCaptureRepriceIntent | null;
  markMakerCaptureRepriceReady?(
    intentId: string,
    candidatePrice: number,
    replacementSize: number,
    proof: MakerCaptureBookDecisionProofV1,
  ): boolean;
  markMakerCaptureRepriceSubmitted?(intentId: string, childOrderId: OrderId): boolean;
  markMakerCaptureRepriceSubmitProof?(
    intentId: string,
    childOrderId: OrderId,
    clientOrderId: string,
    proof: MakerCaptureSubmitProofV1,
  ): boolean;
  markMakerCaptureRepriceTerminal?(
    intentId: string,
    status: "completed" | "failed",
    failure?: string | null,
  ): boolean;
  /** Conservative, fully validated accounting for one persisted capture chain. */
  getMakerCaptureChainUsage?(orderId: OrderId): MakerCaptureChainUsage;

  claimBounceAskCaptureIntent?(intent: BounceAskCaptureIntent): boolean;
  findRecoverableBounceAskCaptureIntents?(): BounceAskCaptureIntent[];
  findBounceAskCaptureIntentBySignal?(signalId: string): BounceAskCaptureIntent | null;
  findBounceAskCaptureIntentByChild?(childOrderId: OrderId): BounceAskCaptureIntent | null;
  findBounceAskCaptureIntentByPredecessor?(
    predecessorOrderId: OrderId,
  ): BounceAskCaptureIntent | null;
  hasNonterminalBounceAskCaptureIntentForPosition?(positionId: PositionId): boolean;
  isOrderManagedByNonterminalBounceAskCaptureIntent?(orderId: OrderId): boolean;
  markBounceAskCaptureReady?(
    intentId: string,
    candidatePrice: number,
    replacementSize: number,
    proof: BounceAskCaptureBookDecisionProofV1,
  ): boolean;
  markBounceAskCaptureSubmitted?(intentId: string, childOrderId: OrderId): boolean;
  resetBounceAskCaptureSubmitted?(intentId: string, childOrderId: OrderId): boolean;
  markBounceAskCaptureSubmitProof?(
    intentId: string,
    childOrderId: OrderId,
    clientOrderId: string,
    proof: BounceAskCaptureSubmitProofV1,
  ): boolean;
  markBounceAskCaptureTerminal?(
    intentId: string,
    status: "completed" | "failed" | "dust",
    failure?: string | null,
  ): boolean;
}

export type MakerCaptureRepriceIntentStatus =
  | "cancel_pending"
  | "ready"
  | "submitted"
  | "completed"
  | "failed";

export interface MakerCaptureRepriceIntent {
  intentId: string;
  predecessorOrderId: OrderId;
  lifecycleSignalId: string;
  rootOrderId: OrderId;
  tokenId: TokenId;
  conditionId: ConditionId;
  replacementIndex: number;
  status: MakerCaptureRepriceIntentStatus;
  candidatePrice: number | null;
  replacementSize: number | null;
  childOrderId: OrderId | null;
  createdAt: string;
  updatedAt: string;
  failure: string | null;
  proof: MakerCaptureRepriceProofV1 | null;
}

export type BounceAskCaptureIntentStatus =
  | "cancel_pending"
  | "ready"
  | "submitted"
  | "completed"
  | "failed"
  | "dust";

export interface BounceAskCaptureIntent {
  intentId: string;
  predecessorOrderId: OrderId;
  lifecycleSignalId: string;
  rootOrderId: OrderId;
  positionId: PositionId;
  tokenId: TokenId;
  conditionId: ConditionId;
  replacementIndex: number;
  status: BounceAskCaptureIntentStatus;
  candidatePrice: number | null;
  replacementSize: number | null;
  childOrderId: OrderId | null;
  createdAt: string;
  updatedAt: string;
  failure: string | null;
  proof: BounceAskCaptureRepriceProofV1 | null;
}

export interface BounceAskCaptureRepriceProofV1 {
  readonly version: 1;
  readonly trigger: BounceAskCaptureTriggerProofV1;
  readonly prepared: BounceAskCaptureBookDecisionProofV1 | null;
  readonly submit: BounceAskCaptureSubmitProofV1 | null;
}

export interface BounceAskCaptureTriggerProofV1 {
  readonly eventTimestampMs: number;
  readonly evaluatedAtMs: number;
  readonly policySchemaVersion: number;
  readonly policyControlRevision: number;
  readonly sourceCohortActivatedAtUtc: string;
  readonly originalTargetPrice: number;
  readonly candidatePrice: number;
  readonly externalBestBid: number;
  readonly externalBestAsk: number;
  readonly tickSize: number;
  readonly positionResidualShares: number;
  readonly sourceBuyRootOrderIds: readonly OrderId[];
}

export interface BounceAskCaptureBookDecisionProofV1 extends BounceAskCaptureTriggerProofV1 {
  readonly snapshotTs: number;
  readonly cachedAtMs: number;
  readonly sourcePolledAtMs: number;
  readonly minOrderSize: number;
  readonly replacementSize: number;
}

export interface BounceAskCaptureSubmitProofV1 extends BounceAskCaptureBookDecisionProofV1 {
  readonly childOrderId: string;
  readonly clientOrderId: string;
  readonly authoritativeStateCapturedAtMs: number;
  readonly authoritativeOpenOrderCount: number;
  readonly authoritativeFilledShares: number;
  readonly authoritativeWalletShares: number;
  readonly authoritativeStateHash: string;
}

export interface MakerCaptureRepriceProofV1 {
  readonly version: 1;
  readonly trigger: MakerCaptureTriggerProofV1;
  readonly prepared: MakerCaptureBookDecisionProofV1 | null;
  readonly submit: MakerCaptureSubmitProofV1 | null;
}

export interface MakerCaptureTriggerProofV1 {
  readonly eventTimestampMs: number;
  readonly evaluatedAtMs: number;
  readonly bestBid: number;
  readonly bestAsk: number | null;
  readonly tickSize: number;
  readonly bookSource: MarketBookSource | null;
  readonly policySchemaVersion: number;
  readonly policyControlRevision: number;
  readonly activatedAtUtc: string;
  readonly expiresAtUtc: string;
  readonly originalSuggestedPrice: number;
  readonly entryPriceCeiling: number;
  readonly rootNotionalUsdc: number;
  readonly chainFilledUsdc: number;
  readonly predecessorRemainingShares: number;
}

export interface MakerCaptureBookDecisionProofV1 {
  readonly evaluatedAtMs: number;
  readonly snapshotTs: number;
  readonly cachedAtMs: number;
  readonly sourcePolledAtMs: number;
  readonly sourceKind: "rest";
  readonly bookSource: "clob";
  readonly tickSize: number;
  readonly predecessorPrice: number;
  readonly predecessorRemainingShares: number;
  readonly predecessorLevelBookShares: number | null;
  readonly predecessorSharesSubtracted: number;
  readonly predecessorLevelExternalShares: number | null;
  readonly externalBestBid: number;
  readonly externalBestAsk: number;
  readonly originalSuggestedPrice: number;
  readonly entryPriceCeiling: number;
  readonly rootNotionalUsdc: number;
  readonly chainFilledUsdc: number;
  readonly rootRemainingUsdc: number;
  readonly candidatePrice: number;
  readonly replacementSize: number;
  readonly minOrderSize: number | null;
  readonly policySchemaVersion: number;
  readonly policyControlRevision: number;
  readonly activatedAtUtc: string;
  readonly expiresAtUtc: string;
}

export interface MakerCaptureSubmitProofV1 extends MakerCaptureBookDecisionProofV1 {
  readonly childOrderId: string;
  readonly clientOrderId: string;
}

export function parseMakerCaptureRepriceProofV1(value: unknown): MakerCaptureRepriceProofV1 | null {
  if (!exactRecord(value, ["prepared", "submit", "trigger", "version"]) || value.version !== 1)
    return null;
  const trigger = parseMakerCaptureTriggerProofV1(value.trigger);
  const prepared =
    value.prepared === null ? null : parseMakerCaptureBookProof(value.prepared, false);
  const submit = value.submit === null ? null : parseMakerCaptureBookProof(value.submit, true);
  if (!trigger || (value.prepared !== null && !prepared) || (value.submit !== null && !submit))
    return null;
  return { version: 1, trigger, prepared, submit };
}

export function parseBounceAskCaptureProofV1(
  value: unknown,
): BounceAskCaptureRepriceProofV1 | null {
  if (!exactRecord(value, ["prepared", "submit", "trigger", "version"]) || value.version !== 1)
    return null;
  const trigger = parseBounceAskCaptureTriggerProof(value.trigger);
  const prepared =
    value.prepared === null ? null : parseBounceAskCapturePreparedProof(value.prepared, false);
  const submit =
    value.submit === null ? null : parseBounceAskCapturePreparedProof(value.submit, true);
  if (
    !trigger ||
    (value.prepared !== null && !prepared) ||
    (value.submit !== null && !submit) ||
    (prepared !== null &&
      !sameBounceAskCaptureFields(trigger, prepared, BOUNCE_ASK_STABLE_PROVENANCE_KEYS)) ||
    (submit !== null &&
      (prepared === null ||
        !sameBounceAskCaptureFields(prepared, submit, BOUNCE_ASK_STABLE_PROVENANCE_KEYS)))
  )
    return null;
  return { version: 1, trigger, prepared, submit };
}

function parseBounceAskCaptureTriggerProof(value: unknown): BounceAskCaptureTriggerProofV1 | null {
  if (!exactRecord(value, BOUNCE_ASK_TRIGGER_KEYS)) return null;
  if (
    !allFinite(value, BOUNCE_ASK_TRIGGER_FINITE_KEYS) ||
    !allPositive(value, BOUNCE_ASK_TRIGGER_POSITIVE_KEYS) ||
    !allNonnegative(value, ["positionResidualShares"]) ||
    !safePositiveInteger(value.policySchemaVersion) ||
    !safeNonnegativeInteger(value.policyControlRevision) ||
    !exactIsoTimestamp(value.sourceCohortActivatedAtUtc) ||
    !validOrderIdList(value.sourceBuyRootOrderIds) ||
    Number(value.externalBestBid) >= Number(value.externalBestAsk) ||
    Number(value.candidatePrice) <= Number(value.externalBestBid) ||
    Number(value.candidatePrice) > Number(value.externalBestAsk)
  )
    return null;
  return value as unknown as BounceAskCaptureTriggerProofV1;
}

function parseBounceAskCapturePreparedProof(
  value: unknown,
  submit: false,
): BounceAskCaptureBookDecisionProofV1 | null;
function parseBounceAskCapturePreparedProof(
  value: unknown,
  submit: true,
): BounceAskCaptureSubmitProofV1 | null;
function parseBounceAskCapturePreparedProof(
  value: unknown,
  submit: boolean,
): BounceAskCaptureBookDecisionProofV1 | BounceAskCaptureSubmitProofV1 | null {
  const keys = submit
    ? [...BOUNCE_ASK_PREPARED_KEYS, ...BOUNCE_ASK_SUBMIT_ONLY_KEYS]
    : BOUNCE_ASK_PREPARED_KEYS;
  if (
    !exactRecord(value, keys) ||
    !parseBounceAskCaptureTriggerProof(pickRecord(value, BOUNCE_ASK_TRIGGER_KEYS))
  )
    return null;
  if (
    !allFinite(value, BOUNCE_ASK_PREPARED_FINITE_KEYS) ||
    !allPositive(value, ["minOrderSize", "replacementSize"]) ||
    Number(value.replacementSize) + 1e-7 < Number(value.minOrderSize) ||
    Number(value.replacementSize) > Number(value.positionResidualShares) + 1e-7
  )
    return null;
  if (
    submit &&
    (!nonempty(value.childOrderId) ||
      !nonempty(value.clientOrderId) ||
      !nonempty(value.authoritativeStateHash) ||
      !allFinite(value, ["authoritativeStateCapturedAtMs"]) ||
      !safeNonnegativeInteger(value.authoritativeOpenOrderCount) ||
      !allNonnegative(value, ["authoritativeFilledShares", "authoritativeWalletShares"]))
  )
    return null;
  return value as unknown as BounceAskCaptureBookDecisionProofV1 | BounceAskCaptureSubmitProofV1;
}

function sameBounceAskCaptureFields(left: object, right: object, keys: readonly string[]): boolean {
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  return keys.every((key) => {
    const leftValue = leftRecord[key];
    const rightValue = rightRecord[key];
    return Array.isArray(leftValue) && Array.isArray(rightValue)
      ? leftValue.length === rightValue.length &&
          leftValue.every((item, i) => item === rightValue[i])
      : leftValue === rightValue;
  });
}

function pickRecord(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function validOrderIdList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(nonempty) &&
    new Set(value).size === value.length
  );
}

function parseMakerCaptureBookProof(
  value: unknown,
  submit: false,
): MakerCaptureBookDecisionProofV1 | null;
function parseMakerCaptureBookProof(value: unknown, submit: true): MakerCaptureSubmitProofV1 | null;
function parseMakerCaptureBookProof(
  value: unknown,
  submit: boolean,
): MakerCaptureBookDecisionProofV1 | MakerCaptureSubmitProofV1 | null {
  const keys = submit
    ? [...MAKER_CAPTURE_BOOK_PROOF_KEYS, "childOrderId", "clientOrderId"]
    : MAKER_CAPTURE_BOOK_PROOF_KEYS;
  if (!exactRecord(value, keys)) return null;
  if (
    (submit && (!nonempty(value.childOrderId) || !nonempty(value.clientOrderId))) ||
    value.sourceKind !== "rest" ||
    value.bookSource !== "clob" ||
    !allFinite(value, MAKER_CAPTURE_BOOK_FINITE_KEYS) ||
    !allPositive(value, MAKER_CAPTURE_BOOK_POSITIVE_KEYS) ||
    !allNonnegative(value, MAKER_CAPTURE_BOOK_NONNEGATIVE_KEYS) ||
    !nullableNonnegative(value.predecessorLevelBookShares) ||
    !nullableNonnegative(value.predecessorLevelExternalShares) ||
    !(value.minOrderSize === null || positive(value.minOrderSize)) ||
    !safeNonnegativeInteger(value.policyControlRevision) ||
    !safePositiveInteger(value.policySchemaVersion) ||
    !isoTimestamp(value.activatedAtUtc) ||
    !isoTimestamp(value.expiresAtUtc) ||
    Number(value.chainFilledUsdc) > Number(value.rootNotionalUsdc) + 1e-7 ||
    Math.abs(
      Number(value.rootRemainingUsdc) -
        Math.max(0, Number(value.rootNotionalUsdc) - Number(value.chainFilledUsdc)),
    ) > 1e-7 ||
    Number(value.candidatePrice) + 1e-9 < Number(value.predecessorPrice) + Number(value.tickSize) ||
    Number(value.candidatePrice) >= Number(value.externalBestAsk) - 1e-9 ||
    Number(value.replacementSize) > Number(value.predecessorRemainingShares) + 1e-7 ||
    Number(value.replacementSize) * Number(value.candidatePrice) >
      Number(value.rootRemainingUsdc) + 1e-7
  )
    return null;
  return value as unknown as MakerCaptureBookDecisionProofV1 | MakerCaptureSubmitProofV1;
}

function parseMakerCaptureTriggerProofV1(value: unknown): MakerCaptureTriggerProofV1 | null {
  if (!exactRecord(value, MAKER_CAPTURE_TRIGGER_KEYS)) return null;
  const validSources: readonly (MarketBookSource | null)[] = [
    "clob",
    "gamma",
    "gamma-fallback",
    "simulation",
    "unknown",
    null,
  ];
  if (
    !allFinite(value, PROOF_TRIGGER_FINITE_KEYS) ||
    !allPositive(value, PROOF_TRIGGER_POSITIVE_KEYS) ||
    !(value.bestAsk === null || positive(value.bestAsk)) ||
    !allNonnegative(value, PROOF_TRIGGER_NONNEGATIVE_KEYS) ||
    !safePositiveInteger(value.policySchemaVersion) ||
    !safeNonnegativeInteger(value.policyControlRevision) ||
    !validSources.includes(value.bookSource as MarketBookSource | null) ||
    !isoTimestamp(value.activatedAtUtc) ||
    !isoTimestamp(value.expiresAtUtc)
  )
    return null;
  return value as unknown as MakerCaptureTriggerProofV1;
}

const proofKeys = (value: string) => value.split(" ");
const MAKER_CAPTURE_TRIGGER_KEYS = proofKeys(
  "activatedAtUtc bestAsk bestBid bookSource chainFilledUsdc entryPriceCeiling evaluatedAtMs eventTimestampMs expiresAtUtc originalSuggestedPrice policyControlRevision policySchemaVersion predecessorRemainingShares rootNotionalUsdc tickSize",
);
const MAKER_CAPTURE_BOOK_PROOF_KEYS = proofKeys(
  "activatedAtUtc bookSource cachedAtMs candidatePrice chainFilledUsdc entryPriceCeiling evaluatedAtMs expiresAtUtc externalBestAsk externalBestBid minOrderSize originalSuggestedPrice policyControlRevision policySchemaVersion predecessorLevelBookShares predecessorLevelExternalShares predecessorPrice predecessorRemainingShares predecessorSharesSubtracted replacementSize rootNotionalUsdc rootRemainingUsdc snapshotTs sourceKind sourcePolledAtMs tickSize",
);
const MAKER_CAPTURE_BOOK_FINITE_KEYS = proofKeys(
  "evaluatedAtMs snapshotTs cachedAtMs sourcePolledAtMs",
);
const MAKER_CAPTURE_BOOK_POSITIVE_KEYS = proofKeys(
  "tickSize predecessorPrice externalBestBid externalBestAsk originalSuggestedPrice entryPriceCeiling rootNotionalUsdc candidatePrice replacementSize",
);
const MAKER_CAPTURE_BOOK_NONNEGATIVE_KEYS = proofKeys(
  "predecessorRemainingShares predecessorSharesSubtracted chainFilledUsdc rootRemainingUsdc",
);
const BOUNCE_ASK_TRIGGER_KEYS = proofKeys(
  "candidatePrice evaluatedAtMs eventTimestampMs externalBestAsk externalBestBid originalTargetPrice policyControlRevision policySchemaVersion positionResidualShares sourceBuyRootOrderIds sourceCohortActivatedAtUtc tickSize",
);
const BOUNCE_ASK_STABLE_PROVENANCE_KEYS = proofKeys(
  "eventTimestampMs originalTargetPrice policyControlRevision policySchemaVersion sourceBuyRootOrderIds sourceCohortActivatedAtUtc tickSize",
);
const BOUNCE_ASK_PREPARED_KEYS = [
  ...BOUNCE_ASK_TRIGGER_KEYS,
  ...proofKeys("cachedAtMs minOrderSize replacementSize snapshotTs sourcePolledAtMs"),
];
const BOUNCE_ASK_SUBMIT_ONLY_KEYS = proofKeys(
  "authoritativeFilledShares authoritativeOpenOrderCount authoritativeStateCapturedAtMs authoritativeStateHash authoritativeWalletShares childOrderId clientOrderId",
);
const BOUNCE_ASK_TRIGGER_FINITE_KEYS = proofKeys("evaluatedAtMs eventTimestampMs");
const BOUNCE_ASK_TRIGGER_POSITIVE_KEYS = proofKeys(
  "candidatePrice externalBestAsk externalBestBid originalTargetPrice tickSize",
);
const BOUNCE_ASK_PREPARED_FINITE_KEYS = proofKeys("cachedAtMs snapshotTs sourcePolledAtMs");
const PROOF_TRIGGER_FINITE_KEYS = proofKeys("eventTimestampMs evaluatedAtMs");
const PROOF_TRIGGER_POSITIVE_KEYS = proofKeys(
  "bestBid tickSize originalSuggestedPrice entryPriceCeiling rootNotionalUsdc",
);
const PROOF_TRIGGER_NONNEGATIVE_KEYS = proofKeys("chainFilledUsdc predecessorRemainingShares");

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function nullableNonnegative(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}
function allFinite(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));
}
function allPositive(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => positive(value[key]));
}
function allNonnegative(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => nullableNonnegative(value[key]) && value[key] !== null);
}
function safePositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function safeNonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isoTimestamp(value: unknown): value is string {
  return nonempty(value) && Number.isFinite(Date.parse(value));
}
function exactIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && toCanonicalIso(value) === value;
}

export interface MakerCaptureChainUsage {
  trusted: boolean;
  rootOrderId: OrderId | null;
  rootNotionalUsdc: number;
  chainFilledUsdc: number;
  predecessorRemainingShares: number;
  replacementIndex: number;
  orderIds: readonly OrderId[];
}

export interface MakerBuyWindowUsage {
  committedUsdc: number;
  conditionCommittedUsdc: number;
  distinctAcceptedConditions: number;
  committedConditionIds: readonly string[];
  filledUsdc: number;
}

export interface DecisionSignalLogRepository {
  insert(signal: DecisionSignalLog): void;
}

// ─── FillRepository ──────────────────────────────────────────────────────

export interface FillRepository {
  /** Persist a fill received from the exchange. */
  save(fill: Fill): void;

  /** Return true if a fill with the given ID already exists. */
  exists(fillId: FillId): boolean;

  /** Return all fills associated with a given order. */
  findByOrderId(orderId: OrderId): Fill[];

  /** Return all fills associated with any of the given orders. */
  findByOrderIds?(orderIds: OrderId[]): Fill[];

  /** Return all fills for a specific outcome token. */
  findByTokenId(tokenId: TokenId): Fill[];

  /** Return the most recent fills for a specific outcome token, newest first. */
  findRecentByTokenId?(tokenId: TokenId, limit: number): Fill[];

  /** Return the most recent fills across all tokens. */
  findRecent(limit: number): Fill[];

  /** Return median taker fee rate for a condition over a recent window, or null if insufficient. */
  findRecentTakerFeeRate?(conditionId: ConditionId, windowHours?: number): number | null;

  /** Return fills that have not yet been applied to a position or inventory lot. */
  findUnreconciled(): Fill[];

  /** Atomically claim an unreconciled fill. False means another worker already applied it. */
  claimForReconciliation(fillId: FillId): boolean;

  /** Mark one or more fills as reconciled (applied to position/lot). */
  markReconciled(fillIds: FillId[]): void;

  /** Return the epoch ms of the most recent fill, or null if no fills exist. */
  getLatestTimestamp(): number | null;
}

// ─── PositionRepository ──────────────────────────────────────────────────

export interface PositionRepository {
  /** Insert or update a position. */
  save(position: Position): void;

  /** Find the position for a specific outcome token (at most one open per token). */
  findByTokenId(tokenId: TokenId): Position | null;

  /**
   * Exact-identity lookup. Release A Phase 3: used at the execution boundaries to
   * verify a command's carried positionId still matches a live position.
   */
  findById(positionId: PositionId): Position | null;

  /**
   * Every NON-closed position for a token (open AND dust). Release A Phase 3:
   * exposes the open+dust ambiguity that findByTokenId's `LIMIT 1` hides, so the
   * executor can fail-closed on an ambiguous (count≠1) token before acting.
   */
  findActiveByTokenId(tokenId: TokenId): Position[];

  /** Return all positions whose status is open or partially filled. */
  findOpen(): Position[];

  /** Return all positions whose status is dust. */
  findDust(): Position[];

  /** Return every position row, regardless of status. */
  findAll(): Position[];

  /** Return all open positions with the given entry style (e.g. "spray"). */
  findOpenByEntryStyle(entryStyle: string): Position[];
}

// ─── InventoryLotRepository ──────────────────────────────────────────────

export interface InventoryLotRepository {
  /** Record a new lot created from a fill. */
  save(lot: InventoryLot): void;

  /** Return all lots (open or exhausted) for a given outcome token. */
  findByTokenId(tokenId: TokenId): InventoryLot[];

  /** Return lots that still have remaining_size > 0 for a given position. */
  findOpen(positionId: PositionId): InventoryLot[];

  /**
   * Consume lots in FIFO order to account for a sell of `size` shares.
   * Updates remaining_size on each touched lot and returns the lots consumed.
   */
  consumeFifo(positionId: PositionId, size: number): { lot: InventoryLot; consumed: number }[];

  /** Zero out all remaining lots for a position (market resolution settlement). */
  settleAll(positionId: PositionId): void;
}

// ─── MarketResolutionRepository ──────────────────────────────────────────

export interface MarketResolutionRepository {
  /** Persist a market resolution record. */
  save(resolution: MarketResolution): void;

  /** Find a resolution by condition ID, or null if not yet resolved. */
  findByConditionId(conditionId: string): MarketResolution | null;

  /** Return all recorded resolutions. */
  findAll(): MarketResolution[];

  /** Update resolution, resolved_at, and status for an existing record (e.g., unknown → YES). */
  updateResolution(
    conditionId: string,
    resolution: string,
    resolvedAt: string,
    source: string,
  ): void;

  /** Mark a resolution as fully settled (all positions processed). */
  markSettled(conditionId: string): void;
}

// ─── OperatorCommandRepository ───────────────────────────────────────────

export interface OperatorCommandRepository {
  /** Insert a new pending command. Returns the auto-incremented row id. */
  insert(
    cmd: Omit<OperatorCommand, "id" | "status" | "appliedAt" | "initiatorType" | "initiator"> &
      Partial<Pick<OperatorCommand, "initiatorType" | "initiator">>,
  ): number;

  /** Return all commands with status = "pending". */
  getPending(): OperatorCommand[];

  /** Mark a command as applied or rejected. */
  updateStatus(id: number, status: "applied" | "rejected", appliedAt: string): void;
}

// ─── OperatorActionRepository ────────────────────────────────────────────

export interface OperatorActionRepository {
  /** Append an action record to the audit log. */
  insert(action: Omit<OperatorAction, "actionId">): void;

  /** Return the most recently applied actions, newest first. */
  findRecent(limit: number): OperatorAction[];
}

// ─── MarketSnapshotRepository ───────────────────────────────────────────

export interface MarketSnapshotRepository {
  /** Persist a batch of market snapshots. */
  saveBatch(snapshots: MarketSnapshot[]): void;

  /** Persist snapshots and same-heartbeat position valuations atomically when supported. */
  saveBatchWithPositionValuations?(
    snapshots: MarketSnapshot[],
    valuations: MarketSnapshotPositionValuation[],
  ): void;

  /** Delete snapshots older than the given ISO timestamp. Returns rows deleted. */
  prune(olderThanIso: string, options?: { readonly preserveTokenIds?: readonly TokenId[] }): number;

  /**
   * Return the latest best_bid / best_ask (and the token's tick_size from the
   * markets table) per token from the last 30 minutes.
   * ONE batched query using ROW_NUMBER() with a LEFT JOIN to markets — intended
   * as a BBO fallback for tokens that have been evicted from the in-memory
   * market cache (churned tokens) OR whose live BBO is unusable (null/NaN/∞).
   * Missing tokens (no recent snapshot) are absent from the result map.
   * `tickSize` is null when the markets row is absent (LEFT JOIN miss).
   * Optional: existing mocks that only implement saveBatch/prune do not need to add this.
   */
  findLatestBboByTokens?(
    tokenIds: readonly TokenId[],
  ): Map<string, { bestBid: number | null; bestAsk: number | null; tickSize: number | null }>;
}

export interface MarketSnapshotPositionValuation {
  /**
   * The valuation is addressed by ROW, not by token. Migration 032's unique index is partial
   * (`positions(token_id) WHERE status = 'open'`), so one `open` row legally coexists with any
   * number of `dust` rows on a token — and a token-scoped write would stamp one row's size-derived
   * value onto every other row of that token.
   */
  positionId: PositionId;
  tokenId: TokenId;
  currentValueUsdc: number | null;
  liquidationValueUsdc: number;
  liquidationPrice: number;
  liquidationDepthExhausted: boolean;
  updatedAt: string;
}

// ─── RiskEventRepository ────────────────────────────────────────────────

export interface RiskEventRepository {
  /** Insert a risk event into the audit log. */
  insert(event: { eventType: string; payload: Record<string, unknown> }): void;

  /** Count risk events since the given ISO timestamp. */
  countSince(createdAtIso: string): number;

  /** Return S1 ownership assumptions that have no later release event for the same token. */
  findOrphanS1Ownerships?(): S1OrphanOwnership[];
}

export interface S1OrphanOwnership {
  tokenId: string;
  conditionId: string;
  ladderId: string;
  assumedAtIso: string;
}

// ─── StateTransition ────────────────────────────────────────────────────

export interface StateTransition {
  id: number;
  entityType: string;
  entityId: string;
  profile: ProfileId | null;
  fromState: string;
  toState: string;
  triggerType: string;
  initiator: string | null;
  reason: string;
  scoresSnapshot: string | null;
  createdAt: string;
}

// ─── StateTransitionRepository ──────────────────────────────────────────

export interface StateTransitionRepository {
  insert(transition: Omit<StateTransition, "id" | "createdAt">): void;
  findByEntity(entityType: string, entityId: string): StateTransition[];
  findLastTransitionTo(
    familyId: string,
    toState: string,
    profile?: ProfileId | null,
  ): StateTransition | null;
  findRecent(limit: number): StateTransition[];
}

// ─── ProfileRepository ──────────────────────────────────────────────────

export interface ProfileRepository {
  findAll(): Profile[];
  findById(profileId: ProfileId): Profile | null;
  save(profile: Profile): void;
}

// ─── ProfileSettingsRepository ──────────────────────────────────────────

export interface ProfileSettingsRepository {
  get(profileId: ProfileId): ProfileSettings | null;
  save(settings: ProfileSettings): void;
}

// ─── ProfileSummaryRepository ───────────────────────────────────────────

export interface ProfileSummaryRepository {
  get(profileId: ProfileId): ProfileSummary | null;
  getAll(): ProfileSummary[];
  save(summary: ProfileSummary): void;
}

// ─── RuntimeControlStateRepository ──────────────────────────────────────

export interface RuntimeControlStateRepository {
  get(): RuntimeControlState | null;
  save(state: RuntimeControlState): void;
}

// ─── SwitchRequestRepository ────────────────────────────────────────────

export interface SwitchRequestRepository {
  save(request: SwitchRequest): void;
  findById(switchId: SwitchId): SwitchRequest | null;
  findActive(): SwitchRequest | null;
  updateState(switchId: SwitchId, state: SwitchState, error?: string | null): void;
}

// ─── SettlementLedgerRepository ─────────────────────────────────────────

export interface SettlementLedgerRepository {
  save(settlement: SettlementRecord): void;

  /**
   * Return algo-redeem settlement rows with `settled_at > cutoffIso`.
   * Filters entirely inside `settlement_ledger` on the stable `resolution`
   * column so mutable `market_resolutions.source` updates cannot hide
   * historical algo-redeem rows from the drift detector.
   */
  findAlgoRedeemSettlementsSince(cutoffIso: string): SettlementRecord[];
}

// ─── MergeLedgerRepository ──────────────────────────────────────────────

export interface MergeLedgerRepository {
  /**
   * Write the merge's INTENT before `gateway.mergePositions()` is called. Callers must let this
   * commit on its own (no ambient transaction) — that is what makes the row durable before the
   * on-chain submission ever leaves the process, so a crash a moment later still finds it.
   *
   * Returns whether this caller CLAIMED the condition. `false` means another writer already has a
   * non-terminal merge for it — the claim is atomic in the store, so reading the fence beforehand
   * is an optimisation, never the guarantee. A caller that gets `false` must drop the candidate and
   * touch nothing: the row it collided with belongs to a merge that may already be on chain.
   */
  recordPending(merge: {
    mergeId: string;
    conditionId: string;
    mergedAmount: number;
    recordedAt: string;
    yesTokenId: import("./ids.js").TokenId;
    noTokenId: import("./ids.js").TokenId;
    yesPositionId: import("./ids.js").PositionId;
    noPositionId: import("./ids.js").PositionId;
  }): boolean;

  /**
   * Advance a 'pending' row to 'onchain' immediately after `gateway.mergePositions()` resolves.
   * Throws if no row matched: an UPDATE that quietly changes nothing would leave the caller
   * believing the intent it wrote is being tracked when it is not.
   */
  markOnchain(mergeId: string): void;

  /**
   * Advance an 'onchain' row to 'applied' with the settlement's final numbers. Called inside the
   * same transaction as the position/lot mutations it accompanies, so the two can never diverge.
   * Throws if no row matched — that throw is what rolls those mutations back, rather than
   * committing a merge the ledger has no record of.
   */
  markApplied(
    merge: Pick<
      import("./types.js").MergeRecord,
      "mergeId" | "conditionId" | "mergedAmount" | "spreadPnl" | "mergedAt" | "status"
    >,
  ): void;

  /**
   * Drop an intent row that provably never reached the chain. Deletes ONLY while the row is still
   * 'pending', so it can never erase a merge that already happened; a row that has advanced is left
   * alone and the call is a no-op.
   */
  deletePending(mergeId: string): void;

  /** Rows not yet 'applied' — what a startup reconciliation/alert path reads to find divergence. */
  findNonTerminal(): import("./types.js").MergeRecord[];
}

// ─── PositionDriftRepository ────────────────────────────────────────────

export interface PositionDriftRepository {
  /** Upsert a drift row keyed on settlementId (idempotent across reconciliation ticks). */
  upsert(drift: PositionDrift): void;

  /** Return drifts whose status is "open", newest first. */
  findOpen(): PositionDrift[];

  /** Mark a drift as resolved (balance cleared on-chain). */
  markResolved(settlementId: string, resolvedAtIso: string): void;
}

/**
 * ADR-015 — append-only observation writer. One row per execution-term
 * resolution (or enforce-skip). No update/delete paths by design.
 */
export interface ExecutionPolicyObservationRepository {
  insert(obs: ExecutionPolicyObservation): void;
}

// ─── PreflightReportRepository ──────────────────────────────────────────

export interface PreflightReportRepository {
  save(report: PreflightReport): void;
  findById(reportId: ReportId): PreflightReport | null;
  findBySwitchRequest(switchId: SwitchId): PreflightReport[];
  findLatestByProfile(profile: ProfileId): PreflightReport | null;
}

// ─── ServiceHeartbeatRepository ─────────────────────────────────────────

export interface ServiceHeartbeatRepository {
  upsert(heartbeat: ServiceHeartbeat): void;
  findByService(serviceName: string): ServiceHeartbeat[];
  findAll(): ServiceHeartbeat[];
}

// ─── ConfigImportRepository ─────────────────────────────────────────────

export interface ConfigImportRepository {
  save(importRecord: ConfigImport): void;
  findById(importId: ImportId): ConfigImport | null;
  findLatest(): ConfigImport | null;
}

// ─── AlgoRulesRepository ────────────────────────────────────────────────

export interface AlgoRulesRepository {
  getDecisionRules(): AlgoDecisionRule[];
  getSizeRules(actionType: "BUY" | "SELL"): AlgoSizeRule[];
}

// ─── LegStateRepository ────────────────────────────────────────────────

export interface LegStateRepository {
  get(tokenId: TokenId): LegState | null;
  upsert(state: LegState): void;
  delete(tokenId: TokenId): void;
  getAll(): LegState[];
  /**
   * CHANGE B — atomically `consecutive_sell_residual_rejects += 1` for the
   * given leg, and optionally mark it abandoned in the same DB transaction
   * when the post-increment count crosses `abandon.threshold`.
   */
  incrementSellResidualReject(
    tokenId: TokenId,
    nowIso: string,
    abandon?: { threshold: number; price: number },
  ): { count: number; markedAbandoned: boolean };
  /**
   * CHANGE B — record abandonment by setting (abandoned_at_price,
   * abandoned_at_ts). Idempotent — callers should gate on isAbandoned().
   */
  markAbandoned(tokenId: TokenId, price: number, nowIso: string): void;
  /**
   * CHANGE B — clear abandonment fields and reset
   * consecutive_sell_residual_rejects=0. Used by both the price-recovery
   * path and the manual API reset.
   */
  resetAbandoned(tokenId: TokenId, nowIso: string): void;
  /**
   * CHANGE C — persist the rolling-window state after a successful reprice
   * publish. `eventsJson` is the JSON-encoded array of ISO timestamps that
   * survived the cutoff; `count` and `windowStartIso` are derived and stored
   * for telemetry / risk-event payloads.
   */
  applyRepriceChainEvent(
    tokenId: TokenId,
    eventsJson: string,
    count: number,
    windowStartIso: string,
    nowIso: string,
  ): void;
}

// ─── LegStateTransitionRepository ───────────────────────────────────────

export interface LegStateTransitionRepository {
  insert(transition: Omit<LegStateTransition, "id" | "createdAt">): boolean;
  findByTokenId(tokenId: TokenId, limit?: number): LegStateTransition[];
  findByPositionId(positionId: PositionId, limit?: number): LegStateTransition[];
}

// ─── AlgoTokenModeStateRepository ───────────────────────────────────────

export interface AlgoTokenModeStateRepository {
  get(tokenId: TokenId): AlgoTokenModeState | null;
  upsert(state: AlgoTokenModeState): void;
  delete(tokenId: TokenId): void;
  findAll(): AlgoTokenModeState[];
}

// ─── OrderPriceCooldownRepository ────────────────────────────────────────

export interface OrderPriceCooldownRepository {
  get(tokenId: TokenId, side: OrderSide, priceX10000: number): OrderPriceCooldown | null;
  upsert(cooldown: OrderPriceCooldown): void;
  delete(tokenId: TokenId, side: OrderSide, priceX10000: number): void;
  deleteByTokenId(tokenId: TokenId): number;
  findAll(): OrderPriceCooldown[];
}

// ─── MarketTradeCountProvider ───────────────────────────────────────────

/**
 * ADR-016: market-wide trade-count provider for Post-Entry Continuation Filter.
 *
 * Returns a best-effort count of executed trades per condition_id, capped at
 * `cap`. The cap matches R1's `>= 6` threshold so the provider can early-exit
 * after enough rows are observed and never needs to page further.
 *
 * Contract:
 *  - Returns the actual count when the underlying source confirms it is < cap.
 *  - Returns `cap` when the source confirms there are at least `cap` trades
 *    (further trades are irrelevant to the gate).
 *  - Returns `0` for empty/unknown markets where the source replied successfully.
 *  - Returns `null` on transient failure (network, timeout, parse error). The
 *    caller decides the fallback (currently: revert to per-leg trade count
 *    under ADR-010 D1 as graceful degradation).
 *
 * Implementations must be safe for concurrent use across legs in a single sweep.
 */
export interface MarketTradeCountProvider {
  countTrades(conditionId: ConditionId, cap: number): Promise<number | null>;
  fetchPublicTradeCount24h?(
    conditionId: ConditionId,
    nowMs: number,
  ): Promise<PublicTradeCount24hResult | null>;
  /**
   * Optional batch warmer. The default implementation is `Promise.all` over
   * `countTrades`, but providers can override to coalesce or rate-limit calls.
   * Callers must not assume per-id ordering or completion semantics — only
   * that, when the returned promise resolves, the cache is populated.
   */
  prefetch?(conditionIds: readonly ConditionId[], cap: number): Promise<void>;
}

export interface PublicTradeCount24hResult {
  count: number;
  capReached: boolean;
  fetchedAt: number;
}

// ─── MakerShadowOrderRepository ─────────────────────────────────────────────

/** Stage lifecycle for a maker-entry shadow order. */
export type MakerShadowStage = "pending" | "filled" | "harvested" | "marked" | "expired";

/** How the shadow order was treated as filled. */
export type MakerShadowFillKind = "trade_through" | "touch";

/**
 * A hypothetical post-only maker BUY tracked across ticks.
 * Opened when R23 fires on a flat first-entry in the maker universe;
 * advanced as the book evolves. Zero live effect.
 *
 * Phase 1 adds scale-in ladder support: multiple levels can be opened for the
 * same token as the bid dips. All levels in one entry run share the same
 * `ladderId`; each is individually assigned a `levelIndex`.
 */
export interface MakerShadowOrder {
  /** Deterministic sha256 prefix of `token_id + posted_at` — distinct per R23 attempt. */
  shadowOrderId: string;
  tokenId: TokenId;
  conditionId: string;
  buyPx: number;
  harvestPx: number;
  postedAt: string; // ISO
  fillDeadline: string; // ISO — postedAt + fillWaitMs (pending expiry clock)
  stage: MakerShadowStage;
  fillKind: MakerShadowFillKind | null;
  fillPx: number | null; // bestAsk or bestBid at fill time
  markPx: number | null; // bestBid at mark time
  netMark: number | null; // markPx / buyPx - 1 (or 1.0 for harvested)
  updatedAt: string; // ISO
  /** Groups all levels of one entry run. Level 0: ladderId === shadowOrderId. */
  ladderId: string;
  /** 0-based position within the ladder. */
  levelIndex: number;
  /**
   * ISO timestamp set at the pending→filled transition. Kept separate from
   * updatedAt (which is overwritten on later transitions) so the post-fill
   * hold clock can be anchored to the actual fill time.
   */
  filledAt: string | null;
}

export interface MakerShadowStageUpdate {
  stage: "filled" | "harvested" | "marked" | "expired";
  fillKind?: MakerShadowFillKind | null;
  fillPx?: number | null;
  markPx?: number | null;
  netMark?: number | null;
  /** Set at the pending→filled transition. Required when stage==="filled". */
  filledAt?: string | null;
  updatedAt: string;
}

export interface MakerShadowOrderRepository {
  /** Insert or replace a shadow order row (idempotent on shadowOrderId). */
  upsert(order: MakerShadowOrder): void;

  /** Return all rows with stage in (pending, filled) — the "open" set. */
  findOpen(): MakerShadowOrder[];

  /** Return open rows for a specific token. */
  findOpenByToken(tokenId: TokenId): MakerShadowOrder[];

  /**
   * Return ALL rows for a ladder (open + terminal), sorted by level_index ASC.
   * Used by the tracker on restart to reconstruct full ladder state.
   */
  findLadder(ladderId: string): MakerShadowOrder[];

  /** Advance a row to a later stage, recording fill/mark telemetry. */
  updateStage(shadowOrderId: string, update: MakerShadowStageUpdate): void;

  /**
   * Delete expired rows older than `beforeIso`. Returns count deleted.
   * Intended for periodic TTL cleanup; keeps the table bounded.
   */
  pruneExpired(beforeIso: string): number;
}
