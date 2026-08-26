import type {
  ClientOrderId,
  ConditionId,
  FillRepository,
  InventoryLotRepository,
  Order,
  OrderRepository,
  Position,
  PositionId,
  PositionRepository,
  TokenId,
} from "@krabs/domain";
import { GATE_ENTRY_RULE_ID } from "@krabs/domain";
import { classifySellCapacitySource } from "../../wallet-buy-budget.js";

const OPEN_ORDER_STATUSES = new Set(["pending", "open", "partially-filled"]);
type ReservationFillLookup = Pick<FillRepository, "findByOrderId" | "findByOrderIds">;

export interface PendingReservation {
  /** Always supplied by Execution; optional only for backward-compatible test/adapter callers. */
  clientOrderId?: ClientOrderId;
  /** Always supplied by Execution; missing external values are counted conservatively as unknown. */
  conditionId?: ConditionId;
  positionId?: PositionId | null;
  tokenId: TokenId;
  side: "buy" | "sell";
  size: number;
  price: number;
  decisionRuleId?: string | null | undefined;
  signalReason?: string | null | undefined;
  metadata?: Readonly<Record<string, unknown>> | null | undefined;
  entryStyle?: "probe" | "maker" | null | undefined;
}

export interface ReservationSnapshot {
  reservedBuyUsdc: number;
  openBuyOrderCount: number;
  /** Open+in-flight BUY orders whose decisionRuleId is GATE_ENTRY (for the GATE sub-cap). */
  openGateBuyOrderCount: number;
  openSellOrderCount: number;
  openProfileLadderSellOrderCount: number;
  openNonProfileLadderSellOrderCount: number;
  openOrdersTotal: number;
  openBuyOrdersByToken: Map<string, number>;
  openSellOrdersByToken: Map<string, number>;
  reservedSellByToken: Map<string, number>;
}

export interface ExitRecoveryFenceV1 {
  readonly version: 1;
  readonly action: "recover_missing_bounce_exit";
  readonly operatorCommandId: number;
  readonly predecessorOrderId: string;
  readonly tokenId: string;
  readonly conditionId: string;
  readonly positionId: string;
  readonly decisionRuleId: string;
  readonly bounceRungJson: string;
  readonly createdAt: string;
  readonly preOpenSnapshotHash: string;
  readonly preFillSnapshotHash: string;
  readonly preFillWatermark: string;
  readonly residualShares: number;
  readonly childClientOrderId: string;
  readonly phase: "prepared" | "fenced" | "child_pending" | "complete";
  readonly fenceCompletedAt?: string;
  readonly postFenceOpenSnapshotHash?: string;
  readonly postFenceFillSnapshotHash?: string;
  readonly postFenceFillWatermark?: string;
  readonly completedAt?: string;
  readonly childOrderId?: string;
}

export interface StartupExitRecoveryBlockV1 {
  readonly version: 1;
  readonly action: "recover_missing_bounce_exit";
  readonly predecessorOrderId: string;
  readonly predecessorClientOrderId: string;
  readonly predecessorExchangeOrderId: string;
  readonly tokenId: string;
  readonly conditionId: string;
  readonly positionId: string;
  readonly decisionRuleId: string;
  readonly orderType: string;
  readonly price: number;
  readonly predecessorShares: number;
  readonly positionShares: number;
  readonly bounceRungJson: string;
  readonly detectedAt: string;
}

export function parseStartupExitRecoveryBlockV1(order: Order): StartupExitRecoveryBlockV1 | null {
  const value = order.metadata?.startupExitRecoveryBlockV1;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = value as Record<string, unknown>;
  if (
    block.version !== 1 ||
    block.action !== "recover_missing_bounce_exit" ||
    block.predecessorOrderId !== String(order.orderId) ||
    block.predecessorClientOrderId !== String(order.clientOrderId) ||
    block.predecessorExchangeOrderId !== order.exchangeOrderId ||
    block.tokenId !== String(order.tokenId) ||
    block.conditionId !== String(order.conditionId) ||
    block.positionId !== String(order.positionId) ||
    block.decisionRuleId !== order.decisionRuleId ||
    block.orderType !== order.orderType ||
    block.price !== order.price ||
    block.predecessorShares !== order.size ||
    block.bounceRungJson !== canonicalRecoveryMetadata(order.metadata?.bounceRung) ||
    !Number.isFinite(block.positionShares) ||
    (block.positionShares as number) <= 0 ||
    !isCanonicalInstant(block.detectedAt)
  ) {
    return null;
  }
  return block as unknown as StartupExitRecoveryBlockV1;
}

export function parseExitRecoveryFenceV1(order: Order): ExitRecoveryFenceV1 | null {
  const value = order.metadata?.exitRecoveryFenceV1;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fence = value as Record<string, unknown>;
  const phase = fence.phase;
  if (
    fence.version !== 1 ||
    fence.action !== "recover_missing_bounce_exit" ||
    !Number.isInteger(fence.operatorCommandId) ||
    (fence.operatorCommandId as number) <= 0 ||
    fence.predecessorOrderId !== String(order.orderId) ||
    fence.tokenId !== String(order.tokenId) ||
    fence.conditionId !== String(order.conditionId) ||
    fence.positionId !== String(order.positionId) ||
    fence.decisionRuleId !== order.decisionRuleId ||
    fence.bounceRungJson !== canonicalRecoveryMetadata(order.metadata?.bounceRung) ||
    !isCanonicalInstant(fence.createdAt) ||
    !isSha256(fence.preOpenSnapshotHash) ||
    !isSha256(fence.preFillSnapshotHash) ||
    typeof fence.preFillWatermark !== "string" ||
    !Number.isFinite(fence.residualShares) ||
    (fence.residualShares as number) <= 0 ||
    typeof fence.childClientOrderId !== "string" ||
    fence.childClientOrderId.length === 0 ||
    (phase !== "prepared" &&
      phase !== "fenced" &&
      phase !== "child_pending" &&
      phase !== "complete")
  ) {
    return null;
  }
  if (phase !== "prepared") {
    if (
      !isCanonicalInstant(fence.fenceCompletedAt) ||
      !isSha256(fence.postFenceOpenSnapshotHash) ||
      !isSha256(fence.postFenceFillSnapshotHash) ||
      typeof fence.postFenceFillWatermark !== "string"
    ) {
      return null;
    }
  }
  if (
    phase === "complete" &&
    (!isCanonicalInstant(fence.completedAt) ||
      typeof fence.childOrderId !== "string" ||
      fence.childOrderId.length === 0)
  ) {
    return null;
  }
  return fence as unknown as ExitRecoveryFenceV1;
}

export function isRecoveryChildLocalIdentity(
  predecessor: Order,
  child: Order,
  fence: ExitRecoveryFenceV1,
  requireWorking: boolean,
): boolean {
  const marker = child.metadata?.exitRecoveryChildV1 as Record<string, unknown> | undefined;
  const working =
    child.status === "pending" || child.status === "open" || child.status === "partially-filled";
  return (
    (!requireWorking || working) &&
    marker?.version === 1 &&
    marker.predecessorOrderId === String(predecessor.orderId) &&
    marker.childClientOrderId === fence.childClientOrderId &&
    marker.coverage === "full_active_residual" &&
    marker.predecessorShares === predecessor.size &&
    marker.residualShares === fence.residualShares &&
    child.metadata?.startupExitRecoveryBlockV1 === undefined &&
    String(child.clientOrderId) === fence.childClientOrderId &&
    String(child.tokenId) === fence.tokenId &&
    String(child.conditionId) === fence.conditionId &&
    String(child.positionId) === fence.positionId &&
    child.side === "sell" &&
    child.postOnly === true &&
    child.orderType === predecessor.orderType &&
    child.price === predecessor.price &&
    Math.abs(child.size - fence.residualShares) <= 1e-9 &&
    child.decisionRuleId === fence.decisionRuleId &&
    canonicalRecoveryMetadata(child.metadata?.bounceRung) === fence.bounceRungJson &&
    Boolean(child.exchangeOrderId)
  );
}

export interface RecoveryTtlCoverageDeps {
  readonly positionRepo: Pick<PositionRepository, "findActiveByTokenId">;
  readonly inventoryLotRepo: Pick<InventoryLotRepository, "findOpen">;
  readonly fillRepo: Pick<FillRepository, "findByOrderId" | "findUnreconciled">;
  readonly exchangeStateStore: {
    getWalletPositionSize(tokenId: TokenId | string): number | null;
  };
}

export function isRecoveryChildCleanerProtected(
  child: Order,
  orderRepo: Pick<OrderRepository, "findById">,
  deps: RecoveryTtlCoverageDeps,
): boolean {
  const marker = child.metadata?.exitRecoveryChildV1 as Record<string, unknown> | undefined;
  if (marker?.version !== 1 || typeof marker.predecessorOrderId !== "string") return false;
  const predecessor = orderRepo.findById(marker.predecessorOrderId as Order["orderId"]);
  if (!predecessor) return false;
  const fence = parseExitRecoveryFenceV1(predecessor);
  if (
    fence?.phase !== "complete" ||
    fence.childOrderId !== String(child.orderId) ||
    !isRecoveryChildLocalIdentity(predecessor, child, fence, true)
  ) {
    return false;
  }
  const positions = deps.positionRepo.findActiveByTokenId(child.tokenId);
  const position = positions[0];
  if (
    positions.length !== 1 ||
    String(position?.positionId) !== fence.positionId ||
    String(position?.conditionId) !== fence.conditionId
  ) {
    return false;
  }
  const fifoShares = deps.inventoryLotRepo
    .findOpen(position!.positionId)
    .reduce((sum, lot) => sum + lot.remainingSize, 0);
  const childFills = deps.fillRepo.findByOrderId(child.orderId);
  const unreconciledIds = new Set(
    deps.fillRepo.findUnreconciled().map((fill) => String(fill.fillId)),
  );
  if (
    childFills.some(
      (fill) =>
        !Number.isFinite(fill.size) || fill.size <= 0 || unreconciledIds.has(String(fill.fillId)),
    )
  ) {
    return false;
  }
  const filledShares = childFills.reduce((sum, fill) => sum + fill.size, 0);
  if (
    (child.status === "open" && filledShares > 1e-9) ||
    (child.status === "partially-filled" && filledShares <= 1e-9) ||
    (child.status !== "open" && child.status !== "partially-filled")
  ) {
    return false;
  }
  const remainingShares = fence.residualShares - filledShares;
  const walletShares = deps.exchangeStateStore.getWalletPositionSize(child.tokenId);
  return (
    remainingShares > 1e-9 &&
    walletShares !== null &&
    Math.abs(position!.size - remainingShares) <= 1e-9 &&
    Math.abs(fifoShares - remainingShares) <= 1e-9 &&
    Math.abs(walletShares - remainingShares) <= 1e-9
  );
}

export function canonicalRecoveryMetadata(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRecoveryMetadata).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalRecoveryMetadata(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isExitRecoveryFencedPredecessor(order: Order): boolean {
  const phase = parseExitRecoveryFenceV1(order)?.phase;
  return phase === "fenced" || phase === "child_pending" || phase === "complete";
}

export function buildReservationSnapshot(
  openOrders: Order[],
  fillRepo: ReservationFillLookup,
  pendingReservations: Iterable<PendingReservation> = [],
): ReservationSnapshot {
  const snapshot: ReservationSnapshot = {
    reservedBuyUsdc: 0,
    openBuyOrderCount: 0,
    openGateBuyOrderCount: 0,
    openSellOrderCount: 0,
    openProfileLadderSellOrderCount: 0,
    openNonProfileLadderSellOrderCount: 0,
    openOrdersTotal: 0,
    openBuyOrdersByToken: new Map(),
    openSellOrdersByToken: new Map(),
    reservedSellByToken: new Map(),
  };
  const activeOpenOrders = openOrders.filter(
    (order) => OPEN_ORDER_STATUSES.has(order.status) && !isExitRecoveryFencedPredecessor(order),
  );
  const filledSizeByOrderId = getFilledSizeByOrderId(activeOpenOrders, fillRepo);

  for (const order of activeOpenOrders) {
    addReservation(snapshot, {
      clientOrderId: order.clientOrderId,
      conditionId: order.conditionId,
      tokenId: order.tokenId,
      side: order.side,
      size: getRemainingOrderSize(order, filledSizeByOrderId),
      price: order.price,
      decisionRuleId: order.decisionRuleId,
      signalReason: order.signalReason,
      metadata: order.metadata,
    });
  }

  for (const pending of pendingReservations) {
    addReservation(snapshot, pending);
  }

  return snapshot;
}

function isSha256(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isCanonicalInstant(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function getReservedSellSize(snapshot: ReservationSnapshot, tokenId: TokenId): number {
  return snapshot.reservedSellByToken.get(String(tokenId)) ?? 0;
}

export function getOpenOrderCountForToken(
  snapshot: ReservationSnapshot,
  tokenId: TokenId,
  side: "buy" | "sell",
): number {
  const map = side === "buy" ? snapshot.openBuyOrdersByToken : snapshot.openSellOrdersByToken;
  return map.get(String(tokenId)) ?? 0;
}

function getFilledSizeByOrderId(
  orders: Order[],
  fillRepo: ReservationFillLookup,
): Map<string, number> {
  if (orders.length === 0) return new Map();

  const fills =
    fillRepo.findByOrderIds?.(orders.map((order) => order.orderId)) ??
    orders.flatMap((order) => fillRepo.findByOrderId(order.orderId));
  const filledSizeByOrderId = new Map<string, number>();
  for (const fill of fills) {
    const key = String(fill.orderId);
    filledSizeByOrderId.set(key, (filledSizeByOrderId.get(key) ?? 0) + fill.size);
  }
  return filledSizeByOrderId;
}

function getRemainingOrderSize(order: Order, filledSizeByOrderId: Map<string, number>): number {
  const filled = filledSizeByOrderId.get(String(order.orderId)) ?? 0;
  return Math.max(0, order.size - filled);
}

function addReservation(snapshot: ReservationSnapshot, reservation: PendingReservation): void {
  if (reservation.size <= 0 || reservation.price <= 0) return;
  snapshot.openOrdersTotal += 1;
  if (reservation.side === "buy") {
    snapshot.reservedBuyUsdc += reservation.size * reservation.price;
    snapshot.openBuyOrderCount += 1;
    if (reservation.decisionRuleId === GATE_ENTRY_RULE_ID) {
      snapshot.openGateBuyOrderCount += 1;
    }
    increment(snapshot.openBuyOrdersByToken, reservation.tokenId);
    return;
  }
  snapshot.openSellOrderCount += 1;
  const source = classifySellCapacitySource(reservation);
  if (source === "profile_ladder") {
    snapshot.openProfileLadderSellOrderCount += 1;
  } else {
    snapshot.openNonProfileLadderSellOrderCount += 1;
  }
  increment(snapshot.openSellOrdersByToken, reservation.tokenId);
  const key = String(reservation.tokenId);
  snapshot.reservedSellByToken.set(
    key,
    (snapshot.reservedSellByToken.get(key) ?? 0) + reservation.size,
  );
}

function increment(map: Map<string, number>, tokenId: TokenId): void {
  const key = String(tokenId);
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Compute the total open-order USDC exposure from maker BUY orders (remaining size × price).
 * Used by the micro-live cap enforcement in the execution module.
 */
export function computeMakerOpenOrderUsdc(
  openOrders: Order[],
  fillRepo: ReservationFillLookup,
): number {
  const makerBuyOrders = openOrders.filter(
    (o) => o.entryStyle === "maker" && o.side === "buy" && OPEN_ORDER_STATUSES.has(o.status),
  );
  if (makerBuyOrders.length === 0) return 0;
  const filledSizeByOrderId = getFilledSizeByOrderId(makerBuyOrders, fillRepo);
  return makerBuyOrders.reduce((sum, o) => {
    const remaining = getRemainingOrderSize(o, filledSizeByOrderId);
    return sum + remaining * o.price;
  }, 0);
}

/**
 * Compute the total USDC cost basis from open maker positions.
 * Used alongside computeMakerOpenOrderUsdc for the microMaxOpenUsdc cap.
 */
export function computeMakerOpenPositionUsdc(
  openPositions: Pick<Position, "entryStyle" | "costBasisUsdc">[],
): number {
  return openPositions
    .filter((p) => p.entryStyle === "maker")
    .reduce((sum, p) => sum + p.costBasisUsdc, 0);
}

export function computeMakerPersistedOpenUsdc(
  openOrders: Order[],
  fillRepo: ReservationFillLookup,
  positionRepo?: Pick<PositionRepository, "findDust" | "findOpenByEntryStyle">,
): number {
  const positions = positionRepo
    ? [
        ...positionRepo.findOpenByEntryStyle("maker"),
        ...positionRepo.findDust().filter((position) => position.entryStyle === "maker"),
      ]
    : [];
  return computeMakerOpenOrderUsdc(openOrders, fillRepo) + computeMakerOpenPositionUsdc(positions);
}

/**
 * Compute the total USDC notional of pending (in-flight, not yet persisted)
 * maker BUY reservations. Used alongside computeMakerOpenOrderUsdc for the
 * microMaxOpenUsdc cap to prevent concurrent queued maker BUYs from breaching
 * the cap before their orders are written to the DB.
 */
export function computeMakerPendingReservationUsdc(
  pendingReservations: Iterable<PendingReservation>,
): number {
  let total = 0;
  for (const r of pendingReservations) {
    if (r.side === "buy" && r.entryStyle === "maker" && r.size > 0 && r.price > 0) {
      total += r.size * r.price;
    }
  }
  return total;
}
