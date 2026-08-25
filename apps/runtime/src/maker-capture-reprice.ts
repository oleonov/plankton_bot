import { createHash } from "node:crypto";
import type {
  MakerCaptureLineageV1,
  MakerCaptureRepriceIntent,
  MakerCaptureRepriceSignalV1,
  MakerCaptureBookDecisionProofV1,
  ExchangeOrder,
  Order,
  OrderBookSnapshot,
  OrderId,
} from "@krabs/domain";
import { createOrderId } from "@krabs/domain";
import { floorToTick, validateExecutablePrice } from "./executable-price.js";
import type { CandidateBookCacheEntry } from "./modules/strategy/candidate-book-cache.js";

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
  nowMs: number,
): Promise<CandidateBookCacheEntry | null> {
  if (!cache) return null;
  const entries = await cache.prime([tokenId]);
  const entry = entries.get(tokenId) ?? null;
  if (!entry || entry.sourceKind !== "rest" || entry.tokenId !== tokenId) return null;
  if (
    !freshTimestamp(entry.cachedAtMs, nowMs) ||
    !freshTimestamp(entry.sourcePolledAtMs, nowMs) ||
    !freshTimestamp(entry.snapshotTs, nowMs) ||
    String(entry.book.tokenId) !== tokenId
  ) {
    return null;
  }
  return entry;
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
