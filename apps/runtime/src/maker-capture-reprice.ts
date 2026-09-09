import { createHash } from "node:crypto";
import type {
  MakerCaptureLineageV1,
  MakerCaptureRepriceIntent,
  MakerCaptureRepriceSignalV1,
  MakerCaptureBookDecisionProofV1,
  ExchangeOrder,
  ExecutionPolicy,
  Order,
  OrderBookSnapshot,
  OrderId,
  OrderRepository,
  PlaceOrderCommand,
} from "@krabs/domain";
import {
  createOrderId,
  isPermanentR23OrderAuthorized,
  parseMakerCaptureRepriceProofV1,
} from "@krabs/domain";
import { buildClientOrderId } from "@krabs/domain/node";
import { resolveMakerMicroLiveFillDeadlineMs } from "./buy-order-lifecycle.js";
import { floorToTick, validateExecutablePrice } from "./executable-price.js";
import type { CandidateBookCacheEntry } from "./modules/strategy/candidate-book-cache.js";
import { parseQuoteMotionOrigin } from "./quote-motion-shadow.js";

export const MAKER_CAPTURE_BOOK_MAX_AGE_MS = 3_000;
const EPSILON = 1e-9;
const EXACT_SIZE_EPSILON = 1e-7;

export interface MakerCaptureBookCache {
  prime(tokenIds: readonly string[]): Promise<Map<string, CandidateBookCacheEntry>>;
}

export interface MakerCaptureRepriceIdentity {
  readonly intentId: string;
  readonly lifecycleSignalId: string;
  readonly cancelCommandId: string;
}

type PermanentR23OrderRepo = Pick<OrderRepository, "findById" | "findByTokenId"> &
  Pick<
    OrderRepository,
    | "findRecoverableMakerCaptureRepriceIntents"
    | "findMakerCaptureRepriceIntentByPredecessor"
    | "findMakerCaptureRepriceIntentBySignal"
    | "getMakerCaptureChainUsage"
  >;

interface CapacityCandidate {
  readonly clientOrderId?: Order["clientOrderId"] | undefined;
  readonly conditionId?: Order["conditionId"] | undefined;
  readonly tokenId: Order["tokenId"];
  readonly side: "buy" | "sell";
  readonly size: number;
  readonly price: number;
  readonly decisionRuleId?: string | null | undefined;
  readonly signalReason?: string | null | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | null | undefined;
  readonly entryStyle?: "probe" | "maker" | null | undefined;
}

interface PermanentRootContext {
  readonly root: Order;
  readonly deadlineMs: number;
  readonly residualNotionalUsdc: number;
}

export interface PermanentR23LineageBlocker {
  readonly rootOrderId: OrderId;
  readonly tokenId: Order["tokenId"];
  readonly conditionId: Order["conditionId"];
  readonly deadlineMs: number;
  readonly residualNotionalUsdc: number;
}

export interface PermanentR23CapacityCarrier extends CapacityCandidate {
  readonly kind: "virtual-cancelled-gap";
  readonly rootOrderId: OrderId;
  readonly notionalUsdc: number;
  readonly clientOrderId: Order["clientOrderId"];
  readonly conditionId: Order["conditionId"];
}

export type MakerCaptureExactCancellation =
  | { readonly kind: "proven" }
  | { readonly kind: "retryable"; readonly reason: "unavailable" | "still-working" }
  | {
      readonly kind: "conflict";
      readonly reason: "identity-or-parity-drift" | "terminal-status-conflict";
    };

export type MakerCaptureCandidate =
  | {
      readonly ok: true;
      readonly price: number;
      readonly bestBid: number;
      readonly bestAsk: number;
      readonly predecessorLevelBookShares: number | null;
      readonly predecessorSharesSubtracted: number;
      readonly predecessorLevelExternalShares: number | null;
    }
  | { readonly ok: false; readonly reason: string };

export function buildMakerCaptureRepriceIdentity(
  rootOrderId: OrderId,
  predecessorOrderId: OrderId,
  replacementIndex: number,
): MakerCaptureRepriceIdentity {
  const digest = createHash("sha256")
    .update(`${String(rootOrderId)}|${String(predecessorOrderId)}|${replacementIndex}`)
    .digest("hex");
  return {
    intentId: `mcri_${digest.slice(0, 24)}`,
    lifecycleSignalId: `maker-capture-reprice:${replacementIndex}:${digest.slice(0, 24)}`,
    cancelCommandId: `mcrc_${digest.slice(0, 24)}`,
  };
}

export function parseMakerCaptureRepriceSignal(value: unknown): MakerCaptureRepriceSignalV1 | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (
    !hasExactKeys(value, [
      "intentId",
      "predecessorOrderId",
      "replacementIndex",
      "rootOrderId",
      "version",
    ])
  ) {
    return null;
  }
  if (
    !nonEmptyString(value.intentId) ||
    !nonEmptyString(value.rootOrderId) ||
    !nonEmptyString(value.predecessorOrderId) ||
    !Number.isSafeInteger(value.replacementIndex) ||
    Number(value.replacementIndex) < 1 ||
    Number(value.replacementIndex) > 5
  ) {
    return null;
  }
  return value as unknown as MakerCaptureRepriceSignalV1;
}

export function parseMakerCaptureLineage(order: Order): MakerCaptureLineageV1 | null {
  const value = order.metadata?.makerCaptureLineageV1;
  if (!isRecord(value) || value.version !== 1) return null;
  if (
    !hasExactKeys(value, [
      "predecessorOrderId",
      "replacementIndex",
      "rootNotionalUsdc",
      "rootOrderId",
      "version",
    ]) ||
    !nonEmptyString(value.rootOrderId) ||
    !(value.predecessorOrderId === null || nonEmptyString(value.predecessorOrderId)) ||
    !Number.isSafeInteger(value.replacementIndex) ||
    Number(value.replacementIndex) < 0 ||
    Number(value.replacementIndex) > 5 ||
    !positiveNumber(value.rootNotionalUsdc)
  ) {
    return null;
  }
  return value as unknown as MakerCaptureLineageV1;
}

export function matchesMakerCaptureIntent(
  signalId: string,
  metadata: MakerCaptureRepriceSignalV1,
  intent: MakerCaptureRepriceIntent,
): boolean {
  const identity = buildMakerCaptureRepriceIdentity(
    intent.rootOrderId,
    intent.predecessorOrderId,
    intent.replacementIndex,
  );
  return (
    metadata.intentId === intent.intentId &&
    signalId === intent.lifecycleSignalId &&
    identity.intentId === intent.intentId &&
    identity.lifecycleSignalId === signalId &&
    String(metadata.rootOrderId) === String(intent.rootOrderId) &&
    String(metadata.predecessorOrderId) === String(intent.predecessorOrderId) &&
    metadata.replacementIndex === intent.replacementIndex
  );
}

export async function primeFreshMakerCaptureBook(
  cache: MakerCaptureBookCache | undefined,
  tokenId: string,
  now: number | (() => number),
): Promise<CandidateBookCacheEntry | null> {
  if (!cache) return null;
  const entries = await cache.prime([tokenId]);
  const entry = entries.get(tokenId) ?? null;
  if (!entry || entry.sourceKind !== "rest" || entry.tokenId !== tokenId) return null;
  return isFreshMakerCaptureEntry(entry, typeof now === "function" ? now() : now) ? entry : null;
}

export function isFreshMakerCaptureEntry(entry: CandidateBookCacheEntry, nowMs: number): boolean {
  if (
    !freshTimestamp(entry.cachedAtMs, nowMs) ||
    !freshTimestamp(entry.sourcePolledAtMs, nowMs) ||
    !freshTimestamp(entry.snapshotTs, nowMs) ||
    String(entry.book.tokenId) !== entry.tokenId
  ) {
    return false;
  }
  return true;
}

export function isMakerCaptureBookAfterCancellation(
  observation: Pick<CandidateBookCacheEntry, "snapshotTs" | "sourcePolledAtMs">,
  cancelledAtMs: number,
): boolean {
  return (
    Number.isFinite(cancelledAtMs) &&
    observation.snapshotTs >= cancelledAtMs &&
    observation.sourcePolledAtMs >= cancelledAtMs
  );
}

export function isMakerCaptureCancellationReason(reason: string | null | undefined): boolean {
  return reason === "maker_capture_reprice" || reason === "exchange-exact-cancelled";
}

export function isMakerCaptureExactCancellation(
  predecessor: Pick<
    Order,
    "cancelReason" | "exchangeOrderId" | "price" | "side" | "size" | "status" | "tokenId"
  >,
  predecessorRemainingShares: number,
  exact: ExchangeOrder | null,
): boolean {
  if (
    !predecessor.exchangeOrderId ||
    predecessor.status !== "cancelled" ||
    !isMakerCaptureCancellationReason(predecessor.cancelReason) ||
    predecessor.side !== "buy" ||
    !exact ||
    exact.status !== "CANCELLED" ||
    exact.orderId !== predecessor.exchangeOrderId ||
    String(exact.tokenId) !== String(predecessor.tokenId) ||
    exact.side !== predecessor.side
  ) {
    return false;
  }
  const expectedFilledShares = predecessor.size - predecessorRemainingShares;
  return (
    Number.isFinite(expectedFilledShares) &&
    expectedFilledShares >= -EPSILON &&
    Math.abs(exact.price - predecessor.price) <= EPSILON &&
    Math.abs(exact.sizeTotal - predecessor.size) <= EXACT_SIZE_EPSILON &&
    Math.abs(exact.sizeFilled - expectedFilledShares) <= EXACT_SIZE_EPSILON &&
    Math.abs(exact.sizeRemaining - predecessorRemainingShares) <= EXACT_SIZE_EPSILON
  );
}

export function classifyMakerCaptureExactCancellation(
  predecessor: Pick<
    Order,
    | "cancelReason"
    | "clientOrderId"
    | "exchangeOrderId"
    | "price"
    | "side"
    | "size"
    | "status"
    | "tokenId"
  >,
  predecessorRemainingShares: number,
  exact: ExchangeOrder | null,
): MakerCaptureExactCancellation {
  if (!exact) return { kind: "retryable", reason: "unavailable" };
  if (!makerCaptureExactParity(predecessor, predecessorRemainingShares, exact)) {
    return { kind: "conflict", reason: "identity-or-parity-drift" };
  }
  if (exact.status === "CANCELLED") return { kind: "proven" };
  if (exact.status === "OPEN" || exact.status === "PARTIALLY_FILLED") {
    return { kind: "retryable", reason: "still-working" };
  }
  return { kind: "conflict", reason: "terminal-status-conflict" };
}

export function resolveMakerCaptureCancellationAnchorMs(
  order: Pick<Order, "cancelAgeMs" | "createdAt">,
): number | null {
  const createdAtMs = Date.parse(order.createdAt);
  const cancelAgeMs = order.cancelAgeMs;
  if (
    !Number.isFinite(createdAtMs) ||
    new Date(createdAtMs).toISOString() !== order.createdAt ||
    typeof cancelAgeMs !== "number" ||
    !Number.isSafeInteger(cancelAgeMs) ||
    cancelAgeMs < 0
  ) {
    return null;
  }
  const anchorMs = createdAtMs + cancelAgeMs;
  return Number.isSafeInteger(anchorMs) ? anchorMs : null;
}

export function findPermanentR23LineageBlocker(input: {
  readonly tokenId: Order["tokenId"];
  readonly policy: ExecutionPolicy;
  readonly orderRepo: PermanentR23OrderRepo;
  readonly nowMs: number;
}): PermanentR23LineageBlocker | null {
  const orders = input.orderRepo.findByTokenId(input.tokenId);
  for (const root of orders) {
    const context = currentPermanentRootContext(root, input.policy, input.orderRepo, input.nowMs);
    if (!context || !hasActivePermanentLineage(context.root, orders)) continue;
    return {
      rootOrderId: root.orderId,
      tokenId: root.tokenId,
      conditionId: root.conditionId,
      deadlineMs: context.deadlineMs,
      residualNotionalUsdc: context.residualNotionalUsdc,
    };
  }
  return null;
}

export function resolvePermanentR23CapacityCarriers(input: {
  readonly policy: ExecutionPolicy;
  readonly orderRepo: PermanentR23OrderRepo;
  readonly pendingReservations: readonly CapacityCandidate[];
  readonly ownCandidate?: PlaceOrderCommand;
  readonly nowMs: number;
}): PermanentR23CapacityCarrier[] {
  const intents = input.orderRepo.findRecoverableMakerCaptureRepriceIntents?.() ?? [];
  const carriers = new Map<string, PermanentR23CapacityCarrier>();
  for (const intent of intents) {
    const context = permanentIntentContext(intent, input.policy, input.orderRepo, input.nowMs);
    if (!context || context.residualNotionalUsdc <= EPSILON) continue;
    if (hasAcceptedCarrierSuccessor(intent, input.orderRepo, input.pendingReservations)) continue;
    if (input.ownCandidate && candidateMatchesPermanentIntent(input.ownCandidate, intent)) continue;
    const predecessor = input.orderRepo.findById(intent.predecessorOrderId);
    if (!predecessor || !isCancelledCapturePredecessor(predecessor)) continue;
    carriers.set(String(context.root.orderId), buildPermanentCarrier(context));
  }
  return [...carriers.values()];
}

export function isPermanentR23CapacityCandidateDurablyPersisted(input: {
  readonly candidate: CapacityCandidate;
  readonly policy: ExecutionPolicy;
  readonly orderRepo: PermanentR23OrderRepo;
  readonly nowMs: number;
}): boolean {
  const intent = permanentCapacityCandidateIntent(input);
  const child = intent?.childOrderId ? input.orderRepo.findById(intent.childOrderId) : null;
  return Boolean(
    intent && child && isWorkingOrder(child) && orderMatchesPermanentIntent(child, intent),
  );
}

export function isPermanentR23CapacityCandidateOwned(input: {
  readonly candidate: CapacityCandidate;
  readonly policy: ExecutionPolicy;
  readonly orderRepo: PermanentR23OrderRepo;
  readonly nowMs: number;
}): boolean {
  return permanentCapacityCandidateIntent(input) !== null;
}

export function computeMakerCaptureCandidate(input: {
  readonly book: OrderBookSnapshot;
  readonly tickSize: number;
  readonly predecessorPrice: number;
  readonly predecessorVisibleShares: number;
  readonly originalSuggestedPrice: number;
  readonly entryPriceCeiling: number;
}): MakerCaptureCandidate {
  const { book, tickSize } = input;
  if (!validTick(tickSize) || !Array.isArray(book.bids) || !Array.isArray(book.asks)) {
    return { ok: false, reason: "malformed-book" };
  }
  const bids = aggregateLevels(book.bids, tickSize);
  const asks = aggregateLevels(book.asks, tickSize);
  if (!bids || !asks) return { ok: false, reason: "malformed-book" };
  const predecessorTick = Math.round(input.predecessorPrice / tickSize);
  const visible = bids.get(predecessorTick);
  let predecessorSharesSubtracted = 0;
  let predecessorLevelExternalShares = visible ?? null;
  if (visible !== undefined && input.predecessorVisibleShares > EPSILON) {
    if (input.predecessorVisibleShares > visible + 1e-7) {
      return { ok: false, reason: "self-book-ambiguous" };
    }
    const residual = visible - input.predecessorVisibleShares;
    predecessorSharesSubtracted = input.predecessorVisibleShares;
    predecessorLevelExternalShares = Math.max(0, residual);
    if (residual <= 1e-7) bids.delete(predecessorTick);
    else bids.set(predecessorTick, residual);
  }
  const bestBidTick = Math.max(...bids.keys());
  const bestAskTick = Math.min(...asks.keys());
  if (!Number.isFinite(bestBidTick) || !Number.isFinite(bestAskTick)) {
    return { ok: false, reason: "book-missing" };
  }
  const bestBid = bestBidTick * tickSize;
  const bestAsk = bestAskTick * tickSize;
  const candidate = floorToTick(
    Math.min(
      bestBid + tickSize,
      bestAsk - tickSize,
      input.originalSuggestedPrice,
      input.entryPriceCeiling,
    ),
    tickSize,
  );
  if (
    !validateExecutablePrice(candidate, tickSize).ok ||
    candidate + EPSILON < input.predecessorPrice + tickSize ||
    candidate >= bestAsk - EPSILON
  ) {
    return { ok: false, reason: "no-valid-move" };
  }
  return {
    ok: true,
    price: candidate,
    bestBid,
    bestAsk,
    predecessorLevelBookShares: visible ?? null,
    predecessorSharesSubtracted,
    predecessorLevelExternalShares,
  };
}

export function buildMakerCaptureBookDecisionProof(input: {
  readonly evaluatedAtMs: number;
  readonly entry: CandidateBookCacheEntry;
  readonly tickSize: number;
  readonly predecessorPrice: number;
  readonly predecessorRemainingShares: number;
  readonly rootNotionalUsdc: number;
  readonly chainFilledUsdc: number;
  readonly originalSuggestedPrice: number;
  readonly entryPriceCeiling: number;
  readonly candidate: Extract<MakerCaptureCandidate, { ok: true }>;
  readonly replacementSize: number;
  readonly minOrderSize: number | null;
  readonly policySchemaVersion: number;
  readonly policyControlRevision: number;
  readonly activatedAtUtc: string;
  readonly expiresAtUtc: string;
}): MakerCaptureBookDecisionProofV1 {
  return {
    evaluatedAtMs: input.evaluatedAtMs,
    snapshotTs: input.entry.snapshotTs,
    cachedAtMs: input.entry.cachedAtMs,
    sourcePolledAtMs: input.entry.sourcePolledAtMs,
    sourceKind: "rest",
    bookSource: input.entry.bookSource,
    tickSize: input.tickSize,
    predecessorPrice: input.predecessorPrice,
    predecessorRemainingShares: input.predecessorRemainingShares,
    predecessorLevelBookShares: input.candidate.predecessorLevelBookShares,
    predecessorSharesSubtracted: input.candidate.predecessorSharesSubtracted,
    predecessorLevelExternalShares: input.candidate.predecessorLevelExternalShares,
    externalBestBid: input.candidate.bestBid,
    externalBestAsk: input.candidate.bestAsk,
    originalSuggestedPrice: input.originalSuggestedPrice,
    entryPriceCeiling: input.entryPriceCeiling,
    rootNotionalUsdc: input.rootNotionalUsdc,
    chainFilledUsdc: input.chainFilledUsdc,
    rootRemainingUsdc: Math.max(0, input.rootNotionalUsdc - input.chainFilledUsdc),
    candidatePrice: input.candidate.price,
    replacementSize: input.replacementSize,
    minOrderSize: input.minOrderSize,
    policySchemaVersion: input.policySchemaVersion,
    policyControlRevision: input.policyControlRevision,
    activatedAtUtc: input.activatedAtUtc,
    expiresAtUtc: input.expiresAtUtc,
  };
}

export function rootMakerCaptureLineage(
  orderId: OrderId,
  rootNotionalUsdc: number,
): MakerCaptureLineageV1 {
  return {
    version: 1,
    rootOrderId: createOrderId(String(orderId)),
    predecessorOrderId: null,
    replacementIndex: 0,
    rootNotionalUsdc,
  };
}

function makerCaptureExactParity(
  predecessor: Pick<
    Order,
    | "cancelReason"
    | "clientOrderId"
    | "exchangeOrderId"
    | "price"
    | "side"
    | "size"
    | "status"
    | "tokenId"
  >,
  predecessorRemainingShares: number,
  exact: ExchangeOrder,
): boolean {
  const expectedFilledShares = predecessor.size - predecessorRemainingShares;
  return (
    Boolean(predecessor.exchangeOrderId) &&
    predecessor.status === "cancelled" &&
    isMakerCaptureCancellationReason(predecessor.cancelReason) &&
    predecessor.side === "buy" &&
    exact.orderId === predecessor.exchangeOrderId &&
    exact.clientOrderId !== null &&
    String(exact.clientOrderId) === String(predecessor.clientOrderId) &&
    String(exact.tokenId) === String(predecessor.tokenId) &&
    exact.side === predecessor.side &&
    Number.isFinite(expectedFilledShares) &&
    expectedFilledShares >= -EPSILON &&
    Math.abs(exact.price - predecessor.price) <= EPSILON &&
    Math.abs(exact.sizeTotal - predecessor.size) <= EXACT_SIZE_EPSILON &&
    Math.abs(exact.sizeFilled - expectedFilledShares) <= EXACT_SIZE_EPSILON &&
    Math.abs(exact.sizeRemaining - predecessorRemainingShares) <= EXACT_SIZE_EPSILON
  );
}

function currentPermanentRootContext(
  root: Order,
  policy: ExecutionPolicy,
  orderRepo: PermanentR23OrderRepo,
  nowMs: number,
): PermanentRootContext | null {
  const origin = parseQuoteMotionOrigin(root);
  const lineage = parseMakerCaptureLineage(root);
  const usage = orderRepo.getMakerCaptureChainUsage?.(root.orderId);
  const lifecycle = root.metadata?.makerMicroLiveLifecycle as Record<string, unknown> | undefined;
  const deadlineMs = resolveMakerMicroLiveFillDeadlineMs(root);
  const activationId = policy.makerEntry.permanentR23ActivationId;
  const activatedAtUtc = policy.makerEntry.permanentR23ActivatedAtUtc;
  if (
    !isPermanentR23OrderAuthorized(policy.makerEntry, {
      conditionId: root.conditionId,
      source: "strategy",
      side: root.side,
      entryStyle: root.entryStyle,
      postOnly: root.postOnly,
      decisionRuleId: root.decisionRuleId,
      signalReason: root.signalReason,
      signalTimestamp: root.signalTimestamp,
    }) ||
    !origin ||
    !lineage ||
    !usage?.trusted ||
    !activationId ||
    !activatedAtUtc ||
    origin.kind !== "r23_capture" ||
    origin.policySchemaVersion !== policy.version ||
    origin.cohortId !== activatedAtUtc ||
    origin.permanentR23ActivationId !== activationId ||
    origin.permanentR23ActivatedAtUtc !== activatedAtUtc ||
    lifecycle?.kind !== "permanent_r23" ||
    lifecycle.activationId !== activationId ||
    lifecycle.activatedAtUtc !== activatedAtUtc ||
    lineage.replacementIndex !== 0 ||
    lineage.predecessorOrderId !== null ||
    String(lineage.rootOrderId) !== String(root.orderId) ||
    Math.abs(lineage.rootNotionalUsdc - root.sizeUsdc) > EPSILON ||
    String(usage.rootOrderId) !== String(root.orderId) ||
    usage.replacementIndex !== 0 ||
    Math.abs(usage.rootNotionalUsdc - lineage.rootNotionalUsdc) > EPSILON ||
    deadlineMs === null ||
    nowMs >= deadlineMs
  ) {
    return null;
  }
  return {
    root,
    deadlineMs,
    residualNotionalUsdc: Math.max(0, usage.rootNotionalUsdc - usage.chainFilledUsdc),
  };
}

function hasActivePermanentLineage(root: Order, tokenOrders: readonly Order[]): boolean {
  return tokenOrders.some((order) => {
    const lineage = parseMakerCaptureLineage(order);
    if (!lineage || String(lineage.rootOrderId) !== String(root.orderId)) return false;
    return isWorkingOrder(order) || isCancelledCapturePredecessor(order);
  });
}

function permanentIntentContext(
  intent: MakerCaptureRepriceIntent,
  policy: ExecutionPolicy,
  orderRepo: PermanentR23OrderRepo,
  nowMs: number,
  allowCompleted = false,
): PermanentRootContext | null {
  if (
    (!isNonterminalCaptureIntent(intent) && !(allowCompleted && intent.status === "completed")) ||
    !captureIntentIdentityValid(intent)
  )
    return null;
  const root = orderRepo.findById(intent.rootOrderId);
  const predecessor = orderRepo.findById(intent.predecessorOrderId);
  const context = root ? currentPermanentRootContext(root, policy, orderRepo, nowMs) : null;
  const lineage = predecessor ? parseMakerCaptureLineage(predecessor) : null;
  if (
    !context ||
    !predecessor ||
    !lineage ||
    String(predecessor.tokenId) !== String(intent.tokenId) ||
    String(predecessor.conditionId) !== String(intent.conditionId) ||
    String(lineage.rootOrderId) !== String(root!.orderId) ||
    lineage.replacementIndex + 1 !== intent.replacementIndex
  ) {
    return null;
  }
  return context;
}

function permanentCapacityCandidateIntent(input: {
  readonly candidate: CapacityCandidate;
  readonly policy: ExecutionPolicy;
  readonly orderRepo: PermanentR23OrderRepo;
  readonly nowMs: number;
}): MakerCaptureRepriceIntent | null {
  const metadata = parseMakerCaptureRepriceSignal(input.candidate.metadata?.makerCaptureRepriceV1);
  if (!metadata) return null;
  const identity = buildMakerCaptureRepriceIdentity(
    metadata.rootOrderId,
    metadata.predecessorOrderId,
    metadata.replacementIndex,
  );
  const intent = input.orderRepo.findMakerCaptureRepriceIntentBySignal?.(
    identity.lifecycleSignalId,
  );
  if (
    !intent ||
    !permanentIntentContext(intent, input.policy, input.orderRepo, input.nowMs, true) ||
    !candidateMatchesPermanentIntent(input.candidate, intent)
  ) {
    return null;
  }
  return intent;
}

function captureIntentIdentityValid(intent: MakerCaptureRepriceIntent): boolean {
  const identity = buildMakerCaptureRepriceIdentity(
    intent.rootOrderId,
    intent.predecessorOrderId,
    intent.replacementIndex,
  );
  const proof = parseMakerCaptureRepriceProofV1(intent.proof);
  return (
    identity.intentId === intent.intentId &&
    identity.lifecycleSignalId === intent.lifecycleSignalId &&
    proof !== null &&
    ((intent.status === "cancel_pending" && proof.prepared === null && proof.submit === null) ||
      (intent.status === "ready" && proof.prepared !== null && proof.submit === null) ||
      (intent.status === "submitted" && proof.prepared !== null) ||
      (intent.status === "completed" &&
        intent.childOrderId !== null &&
        proof.prepared !== null &&
        proof.submit?.childOrderId === String(intent.childOrderId) &&
        proof.submit.clientOrderId ===
          String(
            buildClientOrderId({
              signalId: intent.lifecycleSignalId,
              tokenId: intent.tokenId,
              side: "buy",
            }),
          )))
  );
}

function hasAcceptedCarrierSuccessor(
  intent: MakerCaptureRepriceIntent,
  orderRepo: PermanentR23OrderRepo,
  pendingReservations: readonly CapacityCandidate[],
): boolean {
  const predecessor = orderRepo.findById(intent.predecessorOrderId);
  if (predecessor && isWorkingOrder(predecessor)) return true;
  const child = intent.childOrderId ? orderRepo.findById(intent.childOrderId) : null;
  if (child && isWorkingOrder(child) && orderMatchesPermanentIntent(child, intent)) return true;
  return pendingReservations.some((reservation) =>
    candidateMatchesPermanentIntent(reservation, intent),
  );
}

function candidateMatchesPermanentIntent(
  candidate: CapacityCandidate,
  intent: MakerCaptureRepriceIntent,
): boolean {
  const metadata = parseMakerCaptureRepriceSignal(candidate.metadata?.makerCaptureRepriceV1);
  const expectedClientOrderId = buildClientOrderId({
    signalId: intent.lifecycleSignalId,
    tokenId: intent.tokenId,
    side: "buy",
  });
  return (
    metadata !== null &&
    matchesMakerCaptureIntent(intent.lifecycleSignalId, metadata, intent) &&
    String(candidate.clientOrderId) === String(expectedClientOrderId) &&
    String(candidate.tokenId) === String(intent.tokenId) &&
    String(candidate.conditionId) === String(intent.conditionId) &&
    candidate.side === "buy" &&
    candidate.entryStyle === "maker" &&
    candidate.decisionRuleId === "R23_DIP_TRIGGER" &&
    candidate.signalReason === "probe-entry" &&
    intent.candidatePrice !== null &&
    intent.replacementSize !== null &&
    Math.abs(candidate.price - intent.candidatePrice) <= EPSILON &&
    Math.abs(candidate.size - intent.replacementSize) <= EXACT_SIZE_EPSILON
  );
}

function orderMatchesPermanentIntent(order: Order, intent: MakerCaptureRepriceIntent): boolean {
  return (
    candidateMatchesPermanentIntent(order, intent) &&
    String(order.signalId) === intent.lifecycleSignalId
  );
}

function buildPermanentCarrier(context: PermanentRootContext): PermanentR23CapacityCarrier {
  return {
    kind: "virtual-cancelled-gap",
    rootOrderId: context.root.orderId,
    clientOrderId:
      `permanent-r23-carrier:${String(context.root.orderId)}` as Order["clientOrderId"],
    conditionId: context.root.conditionId,
    tokenId: context.root.tokenId,
    side: "buy",
    size: context.residualNotionalUsdc / context.root.price,
    price: context.root.price,
    decisionRuleId: "R23_DIP_TRIGGER",
    signalReason: "probe-entry",
    entryStyle: "maker",
    notionalUsdc: context.residualNotionalUsdc,
  };
}

function isNonterminalCaptureIntent(intent: MakerCaptureRepriceIntent): boolean {
  return (
    intent.status === "cancel_pending" || intent.status === "ready" || intent.status === "submitted"
  );
}

function isWorkingOrder(order: Order): boolean {
  return (
    order.status === "pending" || order.status === "open" || order.status === "partially-filled"
  );
}

function isCancelledCapturePredecessor(order: Order): boolean {
  return order.status === "cancelled" && isMakerCaptureCancellationReason(order.cancelReason);
}

function aggregateLevels(
  levels: readonly { price: number; size: number }[],
  tickSize: number,
): Map<number, number> | null {
  const result = new Map<number, number>();
  for (const level of levels) {
    if (!positiveNumber(level.size) || !validateExecutablePrice(level.price, tickSize).ok)
      return null;
    const key = Math.round(level.price / tickSize);
    result.set(key, (result.get(key) ?? 0) + level.size);
  }
  return result;
}

function freshTimestamp(value: number, nowMs: number): boolean {
  return (
    Number.isFinite(value) &&
    value <= nowMs + 1_000 &&
    nowMs - value <= MAKER_CAPTURE_BOOK_MAX_AGE_MS
  );
}

function validTick(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 1;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
