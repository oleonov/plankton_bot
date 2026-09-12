import { createHash } from "node:crypto";
import type {
  BounceAskCaptureLineageV1,
  BounceAskCapturePolicy,
  BounceAskCaptureRepriceSignalV1,
  Fill,
  FillRepository,
  InventoryLotRepository,
  Order,
  OrderBookSnapshot,
  OrderId,
  OrderRepository,
  Position,
  PositionRepository,
} from "@krabs/domain";
import { BOUNCE_EXIT_TARGET_RULE_ID, exchangeComparisonOrder } from "@krabs/domain";
import { floorToTick, validateExecutablePrice } from "./executable-price.js";
import { parseMakerCaptureLineage } from "./maker-capture-reprice.js";
import { parseQuoteMotionOrigin } from "./quote-motion-shadow.js";

const EPSILON = 1e-9;

export function buildBounceAskCaptureIdentity(
  rootOrderId: OrderId,
  predecessorOrderId: OrderId,
  replacementIndex: number,
) {
  const digest = createHash("sha256")
    .update(`${String(rootOrderId)}|${String(predecessorOrderId)}|${replacementIndex}`)
    .digest("hex");
  return {
    intentId: `bacri_${digest.slice(0, 24)}`,
    lifecycleSignalId: `bounce-ask-capture:${replacementIndex}:${digest.slice(0, 24)}`,
    cancelCommandId: `bacrc_${digest.slice(0, 24)}`,
  };
}

export function parseBounceAskCaptureSignal(
  value: unknown,
): BounceAskCaptureRepriceSignalV1 | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (
    !hasExactKeys(
      value,
      "intentId predecessorOrderId replacementIndex rootOrderId version".split(" "),
    ) ||
    !nonempty(value.intentId) ||
    !nonempty(value.rootOrderId) ||
    !nonempty(value.predecessorOrderId) ||
    !Number.isSafeInteger(value.replacementIndex) ||
    Number(value.replacementIndex) < 1 ||
    Number(value.replacementIndex) > 5
  ) {
    return null;
  }
  return value as unknown as BounceAskCaptureRepriceSignalV1;
}

export function parseBounceAskCaptureLineage(order: Order): BounceAskCaptureLineageV1 | null {
  const value = order.metadata?.bounceAskCaptureLineageV1;
  if (!isRecord(value) || value.version !== 1) return null;
  if (
    !hasExactKeys(value, [
      ..."originalTargetPrice positionId predecessorOrderId replacementIndex rootOrderId sourceBuyRootOrderIds sourceCohortActivatedAtUtc version".split(
        " ",
      ),
      ...(value.permanentR23ActivationId === undefined
        ? []
        : ["permanentR23ActivationId", "permanentR23ActivatedAtUtc"]),
    ]) ||
    !nonempty(value.rootOrderId) ||
    !(value.predecessorOrderId === null || nonempty(value.predecessorOrderId)) ||
    !nonempty(value.positionId) ||
    !nonempty(value.sourceCohortActivatedAtUtc) ||
    !positive(value.originalTargetPrice) ||
    !Number.isSafeInteger(value.replacementIndex) ||
    Number(value.replacementIndex) < 0 ||
    Number(value.replacementIndex) > 5 ||
    !Array.isArray(value.sourceBuyRootOrderIds) ||
    value.sourceBuyRootOrderIds.length === 0 ||
    !value.sourceBuyRootOrderIds.every(nonempty)
  ) {
    return null;
  }
  if (
    value.permanentR23ActivationId !== undefined &&
    !(
      (value.permanentR23ActivationId === null && value.permanentR23ActivatedAtUtc === null) ||
      (nonempty(value.permanentR23ActivationId) && nonempty(value.permanentR23ActivatedAtUtc))
    )
  )
    return null;
  return value as unknown as BounceAskCaptureLineageV1;
}

export function isOrdinaryBounceAskRoot(order: Order): boolean {
  const rung = order.metadata?.bounceRung;
  return (
    (order.status === "open" || order.status === "partially-filled") &&
    order.side === "sell" &&
    order.postOnly === true &&
    order.entryStyle === "maker" &&
    order.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID &&
    order.positionId != null &&
    isRecord(rung) &&
    rung.isCleanupRung !== true &&
    order.metadata?.exitRecoveryChildV1 === undefined &&
    order.metadata?.exitRecoveryFenceV1 === undefined &&
    order.metadata?.startupExitRecoveryBlockV1 === undefined &&
    parseQuoteMotionOrigin(order)?.kind === "bounce_exit_target"
  );
}

export function resolveProvenBounceAskOrigin(
  order: Order,
  source: BounceAskOriginSource,
  deps: BounceAskOriginDeps,
) {
  if (!order.positionId) return null;
  return resolveProvenBounceAskPositionOrigin(order.positionId, order.tokenId, source, deps);
}

type BounceAskOriginDeps = {
  readonly orderRepo: Pick<OrderRepository, "findById" | "getMakerCaptureChainUsage">;
  readonly fillRepo: Pick<FillRepository, "findByTokenId">;
  readonly positionRepo: Pick<PositionRepository, "findById">;
  readonly inventoryLotRepo: Pick<InventoryLotRepository, "findOpen">;
};

export function resolveProvenBounceAskPositionOrigin(
  ...args: Parameters<typeof evaluateBounceAskPositionOrigin>
) {
  const result = evaluateBounceAskPositionOrigin(...args);
  return result.ok ? result : null;
}

export function evaluateBounceAskPositionOrigin(
  positionId: Position["positionId"],
  tokenId: Order["tokenId"],
  source: BounceAskOriginSource,
  deps: BounceAskOriginDeps,
) {
  const position = deps.positionRepo.findById(positionId);
  if (!position || position.status === "closed" || String(position.tokenId) !== String(tokenId)) {
    return { ok: false, reason: "invalid-position" } as const;
  }
  const lots = deps.inventoryLotRepo.findOpen(position.positionId);
  const fills = deps.fillRepo.findByTokenId(position.tokenId);
  if (lots.length === 0 || !residualMatchesPosition(position, lots))
    return { ok: false, reason: "invalid-lots" } as const;
  const fillsById = new Map(fills.map((fill) => [String(fill.fillId), fill]));
  const roots = new Map<string, OrderId>();
  for (const lot of lots) {
    const fill = fillsById.get(String(lot.fillId));
    const root = fill ? resolveValidatedBuyRoot(fill, deps.orderRepo) : null;
    const origin = root ? parseQuoteMotionOrigin(root) : null;
    const permanent = typeof source === "string" ? null : source.permanentR23ActivationId;
    const permanentAt = typeof source === "string" ? null : source.permanentR23ActivatedAtUtc;
    const cohort = typeof source === "string" ? source : source.sourceCohortActivatedAtUtc;
    if (
      !fill ||
      fill.side !== "buy" ||
      String(fill.tokenId) !== String(position.tokenId) ||
      !root ||
      origin?.kind !== "r23_capture"
    )
      return { ok: false, reason: "invalid-buy-root" } as const;
    if (
      permanent
        ? origin.permanentR23ActivationId !== permanent ||
          origin.permanentR23ActivatedAtUtc !== permanentAt
        : origin.cohortId !== cohort || origin.permanentR23ActivationId != null
    )
      return { ok: false, reason: "invalid-cohort" } as const;
    roots.set(String(root.orderId), root.orderId);
  }
  return {
    ok: true as const,
    position,
    sourceBuyRootOrderIds: [...roots.values()].sort((a, b) => String(a).localeCompare(String(b))),
  };
}

export function resolveBounceAskPolicyOrigin(
  positionId: Position["positionId"],
  tokenId: Order["tokenId"],
  policy: BounceAskCapturePolicy,
  deps: BounceAskOriginDeps,
) {
  const activationId = policy.permanentR23ActivationId ?? null;
  const activatedAt = policy.permanentR23ActivatedAtUtc ?? null;
  if (activationId && activatedAt) {
    const source = {
      sourceCohortActivatedAtUtc: activatedAt,
      permanentR23ActivationId: activationId,
      permanentR23ActivatedAtUtc: activatedAt,
    };
    const proven = resolveProvenBounceAskPositionOrigin(positionId, tokenId, source, deps);
    if (proven) return { ...proven, ...source };
  }
  const proven = resolveProvenBounceAskPositionOrigin(
    positionId,
    tokenId,
    policy.sourceCohortActivatedAtUtc,
    deps,
  );
  return proven
    ? {
        ...proven,
        sourceCohortActivatedAtUtc: policy.sourceCohortActivatedAtUtc,
        permanentR23ActivationId: null,
        permanentR23ActivatedAtUtc: null,
      }
    : null;
}

type BounceAskOriginSource =
  | string
  | {
      readonly sourceCohortActivatedAtUtc: string;
      readonly permanentR23ActivationId?: string | null;
      readonly permanentR23ActivatedAtUtc?: string | null;
    };

export function computeBounceAskCaptureInitialPrice(input: {
  readonly book: OrderBookSnapshot;
  readonly tickSize: number;
  readonly ownSellOrders: readonly Order[];
  readonly fillsByOrder: ReadonlyMap<string, readonly Fill[]>;
  readonly originalTargetPrice: number;
}) {
  return computeBounceAskCaptureCandidate(input);
}

export function computeBounceAskCaptureCandidate(input: {
  readonly book: OrderBookSnapshot;
  readonly tickSize: number;
  readonly ownSellOrders: readonly Order[];
  readonly fillsByOrder: ReadonlyMap<string, readonly Fill[]>;
  readonly predecessorPrice?: number;
  readonly originalTargetPrice: number;
}) {
  const { tickSize } = input;
  if (!(tickSize > 0 && tickSize < 1)) return { ok: false, reason: "malformed-tick" } as const;
  const bids = aggregate(input.book.bids, tickSize);
  const asks = aggregate(input.book.asks, tickSize);
  if (!bids || !asks) return { ok: false, reason: "malformed-book" } as const;
  const ownResiduals = aggregateSellResiduals(input.ownSellOrders, input.fillsByOrder, tickSize);
  for (const [key, residual] of ownResiduals) {
    const visible = asks.get(key);
    if (visible === undefined) continue;
    if (residual > visible + 1e-7) return { ok: false, reason: "self-book-ambiguous" } as const;
    const external = visible - residual;
    if (external <= 1e-7) asks.delete(key);
    else asks.set(key, external);
  }
  const bidTick = Math.max(...bids.keys());
  const askTick = Math.min(...asks.keys());
  if (!Number.isFinite(bidTick) || !Number.isFinite(askTick)) {
    return { ok: false, reason: "book-missing" } as const;
  }
  const externalBestBid = bidTick * tickSize;
  const externalBestAsk = askTick * tickSize;
  const candidate = floorToTick(externalBestAsk - tickSize, tickSize);
  const predecessorPrice = input.predecessorPrice;
  if (
    !validateExecutablePrice(candidate, tickSize).ok ||
    candidate + EPSILON < input.originalTargetPrice ||
    (predecessorPrice === undefined
      ? candidate <= input.originalTargetPrice + EPSILON
      : candidate > predecessorPrice - tickSize + EPSILON ||
        candidate >= predecessorPrice - EPSILON) ||
    candidate <= externalBestBid + EPSILON ||
    candidate >= externalBestAsk - EPSILON
  ) {
    return { ok: false, reason: "no-valid-move" } as const;
  }
  return { ok: true, price: candidate, externalBestBid, externalBestAsk } as const;
}

function aggregateSellResiduals(
  orders: readonly Order[],
  fillsByOrder: ReadonlyMap<string, readonly Fill[]>,
  tickSize: number,
): Map<number, number> {
  const residuals = new Map<number, number>();
  for (const order of orders) {
    if (order.side !== "sell" || (order.status !== "open" && order.status !== "partially-filled")) {
      continue;
    }
    const filled = (fillsByOrder.get(String(order.orderId)) ?? []).reduce(
      (sum, fill) => sum + fill.size,
      0,
    );
    const residual = Math.max(0, exchangeComparisonOrder(order).size - filled);
    if (residual <= EPSILON) continue;
    const key = Math.round(order.price / tickSize);
    residuals.set(key, (residuals.get(key) ?? 0) + residual);
  }
  return residuals;
}

export function loadBounceAskFills(
  repo: Pick<FillRepository, "findByOrderId" | "findByOrderIds">,
  orders: readonly Order[],
): Map<string, readonly Fill[]> {
  const fills =
    repo.findByOrderIds?.(orders.map((order) => order.orderId)) ??
    orders.flatMap((order) => repo.findByOrderId(order.orderId));
  const result = new Map<string, Fill[]>();
  for (const fill of fills) {
    const key = String(fill.orderId);
    result.set(key, [...(result.get(key) ?? []), fill]);
  }
  return result;
}

export function sameBounceAskRoots(left: readonly unknown[], right: readonly unknown[]): boolean {
  return JSON.stringify(left.map(String)) === JSON.stringify(right.map(String));
}

export function sameBounceAskOrigin(
  current: BounceAskCaptureLineageV1,
  root: BounceAskCaptureLineageV1,
): boolean {
  return (
    String(current.positionId) === String(root.positionId) &&
    current.originalTargetPrice === root.originalTargetPrice &&
    current.permanentR23ActivationId === root.permanentR23ActivationId &&
    current.permanentR23ActivatedAtUtc === root.permanentR23ActivatedAtUtc &&
    sameBounceAskRoots(current.sourceBuyRootOrderIds, root.sourceBuyRootOrderIds)
  );
}

function resolveValidatedBuyRoot(
  fill: Fill,
  repo: Pick<OrderRepository, "findById" | "getMakerCaptureChainUsage">,
): Order | null {
  const order = repo.findById(fill.orderId);
  if (!order || order.side !== "buy") return null;
  const lineage = parseMakerCaptureLineage(order);
  const usage = repo.getMakerCaptureChainUsage?.(order.orderId);
  if (!lineage || !usage?.trusted || !usage.rootOrderId) return null;
  if (String(usage.rootOrderId) !== String(lineage.rootOrderId)) return null;
  return repo.findById(usage.rootOrderId);
}

function residualMatchesPosition(
  position: Position,
  lots: readonly { positionId: unknown; tokenId: unknown; remainingSize: number }[],
): boolean {
  let size = 0;
  for (const lot of lots) {
    if (
      String(lot.positionId) !== String(position.positionId) ||
      String(lot.tokenId) !== String(position.tokenId) ||
      !positive(lot.remainingSize)
    ) {
      return false;
    }
    size += lot.remainingSize;
  }
  return Math.abs(size - position.size) <= 1e-7;
}

function aggregate(
  levels: readonly { price: number; size: number }[],
  tick: number,
): Map<number, number> | null {
  const result = new Map<number, number>();
  for (const level of levels) {
    if (!positive(level.size) || !validateExecutablePrice(level.price, tick).ok) return null;
    const key = Math.round(level.price / tick);
    result.set(key, (result.get(key) ?? 0) + level.size);
  }
  return result;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
