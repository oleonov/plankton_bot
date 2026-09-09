import type {
  ExecutionPolicy,
  Fill,
  FillRepository,
  InventoryLotRepository,
  NormalizedMarket,
  Order,
  OrderBookSnapshot,
  PositionRepository,
  RiskEventRepository,
  Signal,
} from "@krabs/domain";
import {
  BOUNCE_EXIT_TARGET_RULE_ID,
  EXIT_LOSS_FLOOR_COST_TOLERANCE,
  R23_DIP_TRIGGER_RULE_ID,
} from "@krabs/domain";
import { resolveMakerMicroLiveFillDeadlineMs } from "./buy-order-lifecycle.js";
import { floorToTick, normalizeTickSize, validateExecutablePrice } from "./executable-price.js";

export const QUOTE_MOTION_EVENT_TYPE = "quote_motion_shadow_sample";
export const QUOTE_MOTION_HEARTBEAT_MS = 5 * 60_000;

export interface QuoteMotionOriginV1 {
  readonly version: 1;
  readonly kind: "r23_capture" | "bounce_exit_target";
  readonly cohortId: string;
  readonly originalSuggestedPrice: number;
  readonly originalTargetPrice: number | null;
  readonly entryPriceCeiling: number | null;
  readonly policySchemaVersion: number;
  readonly policyControlRevision: number | null;
  readonly permanentR23ActivationId?: string | null;
  readonly permanentR23ActivatedAtUtc?: string | null;
  readonly initialBook: {
    readonly depthStatus: "full" | "unavailable";
    readonly bestBid: number | null;
    readonly bestAsk: number | null;
    readonly tickSize: number;
    readonly snapshotTs: number | null;
    readonly source: string;
  };
}

export interface QuoteMotionBookObservation {
  readonly book: OrderBookSnapshot;
  readonly cachedAtMs: number;
  readonly snapshotTs: number;
  readonly tickSize: number;
  readonly source: string;
}

export interface QuoteMotionState {
  readonly fingerprint: string;
  readonly emittedAtMs: number;
}

export interface QuoteMotionShadowDeps {
  readonly orderRepo: { findOpen(): Order[] };
  readonly fillRepo: Pick<FillRepository, "findByOrderId" | "findByOrderIds">;
  readonly positionRepo: Pick<PositionRepository, "findById">;
  readonly inventoryLotRepo: Pick<InventoryLotRepository, "findOpen">;
  readonly riskEventRepo: Pick<RiskEventRepository, "insert">;
  readonly getFreshBooks: (
    tokenIds: readonly string[],
    nowMs: number,
  ) => Promise<ReadonlyMap<string, QuoteMotionBookObservation | null>>;
  readonly maxBookAgeMs: number;
  readonly onWriteError?: (error: unknown, order: Order) => void;
}

export interface BuildQuoteMotionOriginInput {
  readonly signal: Signal;
  readonly policy: ExecutionPolicy;
  readonly policyControlRevision: number | null;
  readonly market: NormalizedMarket;
  readonly book: OrderBookSnapshot | null;
  readonly source: string;
  readonly kind: QuoteMotionOriginV1["kind"];
  readonly cohortId: string;
  readonly originalTargetPrice?: number | null;
  readonly permanentR23ActivationId?: string | null;
  readonly permanentR23ActivatedAtUtc?: string | null;
}

type QuoteMotionClassification =
  | "buy-up-opportunity"
  | "buy-hold"
  | "sell-below-target"
  | "sell-at-target"
  | "sell-above-target"
  | "would-cross"
  | "lifecycle-invalid"
  | "deadline-expired"
  | "policy-revision-unavailable"
  | "book-missing"
  | "stale-book"
  | "malformed-book"
  | "self-book-ambiguous";

interface LotFacts {
  readonly status: "available" | "unavailable" | "inconsistent";
  readonly count: number | null;
  readonly remainingSize: number | null;
  readonly remainingCostUsdc: number | null;
  readonly maxEntryPrice: number | null;
  readonly avgEntryPrice: number | null;
}

interface QuoteMotionSample {
  readonly classification: QuoteMotionClassification;
  readonly externalBestBid: number | null;
  readonly externalBestAsk: number | null;
  readonly candidatePrice: number | null;
  readonly priceGiveUp: number | null;
  readonly tickSize: number | null;
  readonly lifecycleDeadlineMs: number | null;
  readonly lotFacts: LotFacts | null;
}

interface ExternalBook {
  readonly status: "ok" | "book-missing" | "malformed-book" | "self-book-ambiguous";
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
}

export function buildQuoteMotionOrigin(input: BuildQuoteMotionOriginInput): QuoteMotionOriginV1 {
  return {
    version: 1,
    kind: input.kind,
    cohortId: input.cohortId,
    originalSuggestedPrice: input.signal.suggestedPrice,
    originalTargetPrice: input.originalTargetPrice ?? null,
    entryPriceCeiling: input.kind === "r23_capture" ? input.policy.entryPriceCeiling : null,
    policySchemaVersion: input.policy.version,
    policyControlRevision: input.policyControlRevision,
    permanentR23ActivationId: input.permanentR23ActivationId ?? null,
    permanentR23ActivatedAtUtc: input.permanentR23ActivatedAtUtc ?? null,
    initialBook: {
      depthStatus: input.book ? "full" : "unavailable",
      bestBid: finiteOrNull(input.market.bestBid),
      bestAsk: finiteOrNull(input.market.bestAsk),
      tickSize: normalizeTickSize(input.market.tickSize),
      snapshotTs: finiteOrNull(input.book?.timestamp ?? input.market.snapshotTs),
      source: input.source,
    },
  };
}

type QuoteMotionOriginOrder = Pick<
  Order,
  "metadata" | "side" | "entryStyle" | "postOnly" | "decisionRuleId" | "signalReason"
>;

export function parseQuoteMotionOrigin(order: QuoteMotionOriginOrder): QuoteMotionOriginV1 | null {
  const raw = order.metadata?.quoteMotionV1;
  if (!isRecord(raw) || raw.version !== 1) return null;
  if (raw.kind !== "r23_capture" && raw.kind !== "bounce_exit_target") return null;
  if (!nonEmptyString(raw.cohortId) || !positiveNumber(raw.originalSuggestedPrice)) return null;
  if (!nullablePositive(raw.originalTargetPrice) || !nullablePositive(raw.entryPriceCeiling)) {
    return null;
  }
  if (!Number.isSafeInteger(raw.policySchemaVersion) || Number(raw.policySchemaVersion) <= 0) {
    return null;
  }
  if (!nullableNonNegativeInteger(raw.policyControlRevision)) return null;
  const permanentId = raw.permanentR23ActivationId ?? null;
  const permanentAt = raw.permanentR23ActivatedAtUtc ?? null;
  const permanentAtMs = Date.parse(typeof permanentAt === "string" ? permanentAt : "");
  if (
    !(
      (permanentId === null && permanentAt === null) ||
      (nonEmptyString(permanentId) &&
        typeof permanentAt === "string" &&
        Number.isFinite(permanentAtMs) &&
        new Date(permanentAtMs).toISOString() === permanentAt)
    )
  )
    return null;
  const initialBook = raw.initialBook;
  if (!isRecord(initialBook)) return null;
  if (initialBook.depthStatus !== "full" && initialBook.depthStatus !== "unavailable") return null;
  if (
    !nullablePositive(initialBook.bestBid) ||
    !nullablePositive(initialBook.bestAsk) ||
    !positiveNumber(initialBook.tickSize) ||
    !nullableFinite(initialBook.snapshotTs) ||
    !nonEmptyString(initialBook.source)
  ) {
    return null;
  }
  const origin = {
    ...raw,
    permanentR23ActivationId: permanentId,
    permanentR23ActivatedAtUtc: permanentAt,
  } as unknown as QuoteMotionOriginV1;
  return matchesOriginOrder(order, origin) ? origin : null;
}

export async function runQuoteMotionShadowPass(
  deps: QuoteMotionShadowDeps,
  states: Map<string, QuoteMotionState>,
  nowMs: number,
  lifecycle: { current(): boolean; now(): number } = { current: () => true, now: () => nowMs },
): Promise<{ eligible: number; emitted: number; skipped?: number }> {
  let restingOrders = deps.orderRepo.findOpen().filter(isConfirmedRestingOrder);
  let eligible = restingOrders
    .map((order) => ({ order, origin: parseQuoteMotionOrigin(order) }))
    .filter((item): item is { order: Order; origin: QuoteMotionOriginV1 } => item.origin !== null);
  pruneStates(states, new Set(eligible.map(({ order }) => String(order.orderId))));
  if (eligible.length === 0) return { eligible: 0, emitted: 0 };

  const books = await loadBooks(deps, eligible, nowMs);
  if (!lifecycle.current())
    return { eligible: eligible.length, emitted: 0, skipped: eligible.length };
  nowMs = lifecycle.now();
  const originalCount = eligible.length;
  const acquired = new Set(eligible.map(({ order }) => String(order.orderId)));
  restingOrders = deps.orderRepo.findOpen().filter(isConfirmedRestingOrder);
  eligible = restingOrders
    .filter((order) => acquired.has(String(order.orderId)))
    .map((order) => ({ order, origin: parseQuoteMotionOrigin(order) }))
    .filter((item): item is { order: Order; origin: QuoteMotionOriginV1 } => item.origin !== null);
  const fillsByOrder = loadFills(deps.fillRepo, restingOrders);
  let emitted = 0;
  for (const item of eligible) {
    const sample = evaluateOrder(
      item.order,
      item.origin,
      restingOrders,
      fillsByOrder,
      books,
      deps,
      nowMs,
    );
    const fingerprint = JSON.stringify(sample);
    const key = String(item.order.orderId);
    const prior = states.get(key);
    if (
      prior?.fingerprint === fingerprint &&
      nowMs - prior.emittedAtMs < QUOTE_MOTION_HEARTBEAT_MS
    ) {
      continue;
    }
    try {
      deps.riskEventRepo.insert({
        eventType: QUOTE_MOTION_EVENT_TYPE,
        payload: buildEventPayload(
          item.order,
          item.origin,
          sample,
          books.get(String(item.order.tokenId)),
          nowMs,
        ),
      });
      states.set(key, { fingerprint, emittedAtMs: nowMs });
      emitted++;
    } catch (error) {
      deps.onWriteError?.(error, item.order);
    }
  }
  return {
    eligible: eligible.length,
    emitted,
    ...(originalCount !== eligible.length ? { skipped: originalCount - eligible.length } : {}),
  };
}

function evaluateOrder(
  order: Order,
  origin: QuoteMotionOriginV1,
  openOrders: readonly Order[],
  fillsByOrder: ReadonlyMap<string, readonly Fill[]>,
  books: ReadonlyMap<string, QuoteMotionBookObservation | null>,
  deps: QuoteMotionShadowDeps,
  nowMs: number,
): QuoteMotionSample {
  const lifecycleDeadlineMs =
    origin.kind === "r23_capture" ? resolveMakerMicroLiveFillDeadlineMs(order) : null;
  const lotFacts = origin.kind === "bounce_exit_target" ? resolveLotFacts(order, deps) : null;
  if (origin.kind === "r23_capture" && lifecycleDeadlineMs === null) {
    return emptySample("lifecycle-invalid", lifecycleDeadlineMs, lotFacts);
  }
  if (lifecycleDeadlineMs !== null && nowMs >= lifecycleDeadlineMs) {
    return emptySample("deadline-expired", lifecycleDeadlineMs, lotFacts);
  }
  if (origin.kind === "r23_capture" && origin.policyControlRevision === null) {
    return emptySample("policy-revision-unavailable", lifecycleDeadlineMs, lotFacts);
  }
  const observation = books.get(String(order.tokenId)) ?? null;
  if (!observation) return emptySample("book-missing", lifecycleDeadlineMs, lotFacts);
  if (!freshObservation(observation, nowMs, deps.maxBookAgeMs)) {
    return emptySample("stale-book", lifecycleDeadlineMs, lotFacts);
  }
  if (
    !Number.isFinite(observation.tickSize) ||
    observation.tickSize <= 0 ||
    observation.tickSize >= 1
  ) {
    return emptySample("malformed-book", lifecycleDeadlineMs, lotFacts);
  }
  const tick = observation.tickSize;
  const external = subtractOwnOrders(
    observation.book,
    openOrders.filter((candidate) => String(candidate.tokenId) === String(order.tokenId)),
    fillsByOrder,
    tick,
  );
  if (external.status !== "ok") return emptySample(external.status, lifecycleDeadlineMs, lotFacts);
  if (external.bestBid === null || external.bestAsk === null) {
    return emptySample("book-missing", lifecycleDeadlineMs, lotFacts);
  }
  if (origin.kind === "r23_capture") {
    const cap = Math.min(
      origin.originalSuggestedPrice,
      origin.entryPriceCeiling!,
      external.bestAsk - tick,
    );
    const candidate = floorToTick(Math.min(external.bestBid + tick, cap), tick);
    if (candidate <= order.price + tick * 1e-6) {
      return sample("buy-hold", external, null, null, tick, lifecycleDeadlineMs, null);
    }
    const classification = candidate >= external.bestAsk ? "would-cross" : "buy-up-opportunity";
    return sample(classification, external, candidate, null, tick, lifecycleDeadlineMs, null);
  }
  const candidate = floorToTick(external.bestAsk - tick, tick);
  const target = origin.originalTargetPrice!;
  const classification =
    candidate <= external.bestBid
      ? "would-cross"
      : candidate < target - tick * 1e-6
        ? "sell-below-target"
        : candidate > target + tick * 1e-6
          ? "sell-above-target"
          : "sell-at-target";
  return sample(classification, external, candidate, target - candidate, tick, null, lotFacts);
}

function isConfirmedRestingOrder(order: Order): boolean {
  return order.status === "open" || order.status === "partially-filled";
}

function subtractOwnOrders(
  book: OrderBookSnapshot,
  openOrders: readonly Order[],
  fillsByOrder: ReadonlyMap<string, readonly Fill[]>,
  tick: number,
): ExternalBook {
  const bids = levelMap(book.bids, tick);
  const asks = levelMap(book.asks, tick);
  if (!bids || !asks) return { status: "malformed-book", bestBid: null, bestAsk: null };
  const local = localResiduals(openOrders, fillsByOrder, tick);
  const bidStatus = subtractResiduals(bids, local.buy);
  const askStatus = subtractResiduals(asks, local.sell);
  if (bidStatus === "ambiguous" || askStatus === "ambiguous") {
    return { status: "self-book-ambiguous", bestBid: null, bestAsk: null };
  }
  const bestBidTick = Math.max(...bids.keys());
  const bestAskTick = Math.min(...asks.keys());
  if (!Number.isFinite(bestBidTick) || !Number.isFinite(bestAskTick)) {
    const status =
      bidStatus === "emptied" || askStatus === "emptied" ? "self-book-ambiguous" : "book-missing";
    return { status, bestBid: null, bestAsk: null };
  }
  return { status: "ok", bestBid: bestBidTick * tick, bestAsk: bestAskTick * tick };
}

function levelMap(
  levels: readonly { price: number; size: number }[],
  tick: number,
): Map<number, number> | null {
  const out = new Map<number, number>();
  for (const level of levels) {
    if (!positiveNumber(level.size) || !validateExecutablePrice(level.price, tick).ok) return null;
    const key = Math.round(level.price / tick);
    out.set(key, (out.get(key) ?? 0) + level.size);
  }
  return out;
}

function localResiduals(
  orders: readonly Order[],
  fillsByOrder: ReadonlyMap<string, readonly Fill[]>,
  tick: number,
): { buy: Map<number, number>; sell: Map<number, number> } {
  const result = { buy: new Map<number, number>(), sell: new Map<number, number>() };
  for (const order of orders) {
    const filled = (fillsByOrder.get(String(order.orderId)) ?? []).reduce(
      (sum, fill) => sum + fill.size,
      0,
    );
    const residual = Math.max(0, order.size - filled);
    if (residual <= 1e-9) continue;
    const map = order.side === "buy" ? result.buy : result.sell;
    const key = Math.round(order.price / tick);
    map.set(key, (map.get(key) ?? 0) + residual);
  }
  return result;
}

function subtractResiduals(
  levels: Map<number, number>,
  residuals: ReadonlyMap<number, number>,
): "ok" | "emptied" | "ambiguous" {
  let emptied = false;
  for (const [key, residual] of residuals) {
    const visible = levels.get(key);
    if (visible === undefined) continue;
    if (residual > visible + 1e-7) return "ambiguous";
    const remaining = visible - residual;
    if (remaining <= 1e-7) {
      levels.delete(key);
      emptied = true;
    } else {
      levels.set(key, remaining);
    }
  }
  return emptied ? "emptied" : "ok";
}

function resolveLotFacts(order: Order, deps: QuoteMotionShadowDeps): LotFacts {
  if (!order.positionId) return unavailableLots();
  const position = deps.positionRepo.findById(order.positionId);
  if (!position || String(position.tokenId) !== String(order.tokenId)) return unavailableLots();
  const lots = deps.inventoryLotRepo.findOpen(order.positionId);
  if (lots.length === 0) return unavailableLots();
  let remainingSize = 0;
  let remainingCostUsdc = 0;
  let maxEntryPrice = 0;
  for (const lot of lots) {
    if (
      String(lot.positionId) !== String(order.positionId) ||
      !positiveNumber(lot.remainingSize) ||
      !positiveNumber(lot.entryPrice)
    ) {
      return inconsistentLots();
    }
    remainingSize += lot.remainingSize;
    remainingCostUsdc += lot.remainingSize * lot.entryPrice;
    maxEntryPrice = Math.max(maxEntryPrice, lot.entryPrice);
  }
  if (
    !withinTolerance(remainingSize, position.size) ||
    !withinTolerance(remainingCostUsdc, position.costBasisUsdc)
  ) {
    return inconsistentLots();
  }
  return {
    status: "available",
    count: lots.length,
    remainingSize,
    remainingCostUsdc,
    maxEntryPrice,
    avgEntryPrice: position.avgEntryPrice,
  };
}

function loadFills(
  repo: QuoteMotionShadowDeps["fillRepo"],
  orders: readonly Order[],
): Map<string, readonly Fill[]> {
  const ids = orders.map((order) => order.orderId);
  const fills = repo.findByOrderIds?.(ids) ?? ids.flatMap((id) => repo.findByOrderId(id));
  const result = new Map<string, Fill[]>();
  for (const fill of fills) {
    const key = String(fill.orderId);
    const rows = result.get(key) ?? [];
    rows.push(fill);
    result.set(key, rows);
  }
  return result;
}

async function loadBooks(
  deps: QuoteMotionShadowDeps,
  eligible: readonly { order: Order }[],
  nowMs: number,
): Promise<Map<string, QuoteMotionBookObservation | null>> {
  const tokens = [...new Set(eligible.map(({ order }) => String(order.tokenId)))];
  try {
    const books = await deps.getFreshBooks(tokens, nowMs);
    return new Map(tokens.map((tokenId) => [tokenId, books.get(tokenId) ?? null]));
  } catch {
    return new Map(tokens.map((tokenId) => [tokenId, null]));
  }
}

function buildEventPayload(
  order: Order,
  origin: QuoteMotionOriginV1,
  result: QuoteMotionSample,
  observation: QuoteMotionBookObservation | null | undefined,
  nowMs: number,
): Record<string, unknown> {
  return {
    version: 1,
    sampledAt: new Date(nowMs).toISOString(),
    orderId: String(order.orderId),
    tokenId: String(order.tokenId),
    conditionId: String(order.conditionId),
    cohortId: origin.cohortId,
    kind: origin.kind,
    side: order.side,
    currentPrice: order.price,
    classification: result.classification,
    externalBestBid: result.externalBestBid,
    externalBestAsk: result.externalBestAsk,
    candidatePrice: result.candidatePrice,
    priceGiveUp: result.priceGiveUp,
    tickSize: result.tickSize,
    lifecycleDeadline:
      result.lifecycleDeadlineMs === null
        ? null
        : new Date(result.lifecycleDeadlineMs).toISOString(),
    bookSnapshotAt:
      observation?.snapshotTs == null ? null : new Date(observation.snapshotTs).toISOString(),
    bookSource: observation?.source ?? null,
    origin,
    lotFacts: result.lotFacts,
  };
}

function freshObservation(
  observation: QuoteMotionBookObservation,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  return (
    Number.isFinite(observation.cachedAtMs) &&
    Number.isFinite(observation.snapshotTs) &&
    observation.cachedAtMs <= nowMs + 1_000 &&
    observation.snapshotTs <= nowMs + 1_000 &&
    nowMs - observation.cachedAtMs <= maxAgeMs &&
    nowMs - observation.snapshotTs <= maxAgeMs
  );
}

function sample(
  classification: QuoteMotionClassification,
  external: ExternalBook,
  candidatePrice: number | null,
  priceGiveUp: number | null,
  tickSize: number,
  lifecycleDeadlineMs: number | null,
  lotFacts: LotFacts | null,
): QuoteMotionSample {
  return {
    classification,
    externalBestBid: external.bestBid,
    externalBestAsk: external.bestAsk,
    candidatePrice,
    priceGiveUp,
    tickSize,
    lifecycleDeadlineMs,
    lotFacts,
  };
}

function emptySample(
  classification: QuoteMotionClassification,
  lifecycleDeadlineMs: number | null,
  lotFacts: LotFacts | null,
): QuoteMotionSample {
  return {
    classification,
    externalBestBid: null,
    externalBestAsk: null,
    candidatePrice: null,
    priceGiveUp: null,
    tickSize: null,
    lifecycleDeadlineMs,
    lotFacts,
  };
}

function pruneStates(states: Map<string, QuoteMotionState>, active: ReadonlySet<string>): void {
  for (const key of states.keys()) if (!active.has(key)) states.delete(key);
}

function matchesOriginOrder(order: QuoteMotionOriginOrder, origin: QuoteMotionOriginV1): boolean {
  if (origin.kind === "r23_capture") {
    return (
      order.side === "buy" &&
      order.entryStyle === "maker" &&
      order.postOnly === true &&
      order.decisionRuleId === R23_DIP_TRIGGER_RULE_ID &&
      order.signalReason === "probe-entry" &&
      origin.entryPriceCeiling !== null &&
      origin.originalTargetPrice === null
    );
  }
  return (
    order.side === "sell" &&
    order.entryStyle === "maker" &&
    order.postOnly === true &&
    order.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID &&
    origin.originalTargetPrice !== null &&
    origin.entryPriceCeiling === null
  );
}

function withinTolerance(actual: number, expected: number): boolean {
  return expected > 0 && Math.abs(actual - expected) / expected <= EXIT_LOSS_FLOOR_COST_TOLERANCE;
}

function unavailableLots(): LotFacts {
  return {
    status: "unavailable",
    count: null,
    remainingSize: null,
    remainingCostUsdc: null,
    maxEntryPrice: null,
    avgEntryPrice: null,
  };
}

function inconsistentLots(): LotFacts {
  return { ...unavailableLots(), status: "inconsistent" };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nullablePositive(value: unknown): boolean {
  return value === null || positiveNumber(value);
}

function nullableFinite(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function nullableNonNegativeInteger(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
