import type {
  EventBus,
  ExchangeOrder,
  FillRepository,
  Order,
  OrderCancelTelemetry,
  OrderRepository,
} from "@krabs/domain";
import {
  createCommandId,
  ExchangeErrorCode,
  RESOLVED_LOSER_LOCAL_CANCEL_REASON,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import { classifyCancelAgeBucket } from "../../executable-price.js";
import { computeAgeMs } from "./cancel-telemetry.js";

export const DEFAULT_FILL_COMPLETION_TOLERANCE = 0.005;
const EXCHANGE_FILL_EPSILON = 1e-9;
const lanes = new Map<string, Promise<void>>();
const cancelIntents = new Map<string, string>();

export type TerminalVerdict =
  | { readonly status: "filled" }
  | { readonly status: "cancelled"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "open" | "partially-filled" | "unresolved" };

export function grossFillShares(fill: {
  readonly side: "buy" | "sell";
  readonly size: number;
  readonly price: number;
  readonly sizeUsdc?: number;
  readonly liquidityRole?: string;
}): number {
  if (
    fill.side === "buy" &&
    fill.liquidityRole === "taker" &&
    typeof fill.sizeUsdc === "number" &&
    fill.sizeUsdc > 0 &&
    fill.price > 0
  ) {
    return fill.sizeUsdc / fill.price;
  }
  return fill.size;
}

export function persistedGrossShares(
  fillRepo: Pick<FillRepository, "findByOrderId">,
  order: Order,
): number {
  return fillRepo
    .findByOrderId(order.orderId)
    .reduce((sum, fill) => sum + grossFillShares(fill), 0);
}

export function hasLocalFullCoverage(
  order: Order,
  grossShares: number,
  completionTolerance = DEFAULT_FILL_COMPLETION_TOLERANCE,
): boolean {
  return (
    grossShares > 0 &&
    order.size - grossShares <= Math.max(order.size * completionTolerance, EXCHANGE_FILL_EPSILON)
  );
}

export function hasExactMatchedCoverage(
  exchange: Pick<ExchangeOrder, "sizeFilled">,
  grossShares: number,
): boolean {
  return grossShares + EXCHANGE_FILL_EPSILON >= exchange.sizeFilled;
}

export function resolveOrderStatusVerdict(
  order: Order,
  exchange: Pick<ExchangeOrder, "status" | "sizeFilled"> | null,
  grossShares: number,
  completionTolerance = DEFAULT_FILL_COMPLETION_TOLERANCE,
): TerminalVerdict {
  // Exact working evidence dominates the local completion heuristic: a
  // near-complete fill set cannot terminalize an order still live on exchange.
  if (exchange?.status === "OPEN") {
    return { status: grossShares > 0 ? "partially-filled" : "open" };
  }
  if (exchange?.status === "PARTIALLY_FILLED") return { status: "partially-filled" };
  if (hasLocalFullCoverage(order, grossShares, completionTolerance)) return { status: "filled" };
  if (!exchange) return { status: grossShares > 0 ? "partially-filled" : "unresolved" };
  if (exchange.status === "FILLED" && hasExactMatchedCoverage(exchange, grossShares)) {
    return { status: "filled" };
  }
  if (
    (exchange.status === "CANCELLED" || exchange.status === "EXPIRED") &&
    hasExactMatchedCoverage(exchange, grossShares)
  ) {
    return {
      status: "cancelled",
      reason: exchange.status === "EXPIRED" ? "exchange-exact-expired" : "exchange-exact-cancelled",
    };
  }
  if (exchange.status === "REJECTED" && exchange.sizeFilled === 0 && grossShares === 0) {
    return { status: "rejected", reason: "exchange-exact-invalid" };
  }
  return { status: "unresolved" };
}

export function registerCancelIntent(orderId: string, reason: string): void {
  cancelIntents.set(orderId, reason);
}

export function clearCancelIntent(orderId: string): void {
  cancelIntents.delete(orderId);
}

export async function inOrderLifecycleLane<T>(
  orderId: string,
  action: () => Promise<T>,
): Promise<T> {
  const prior = lanes.get(orderId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => current);
  lanes.set(orderId, tail);
  await prior;
  try {
    return await action();
  } finally {
    release();
    if (lanes.get(orderId) === tail) lanes.delete(orderId);
  }
}

type ApplyOrderVerdictArgs = {
  orderRepo: OrderRepository;
  fillRepo: Pick<FillRepository, "findByOrderId">;
  bus?: EventBus;
  log: Logger;
  orderId: Order["orderId"];
  exchange: Pick<ExchangeOrder, "status" | "sizeFilled"> | null;
  publish?: boolean;
  timestamp?: number;
  cancelTelemetry?: OrderCancelTelemetry;
  fillCompletionTolerance?: number | undefined;
  isCurrent?: (() => boolean) | undefined;
  onVerdictApplied?: ((verdict: TerminalVerdict) => void) | undefined;
};

export async function applyOrderVerdict(args: ApplyOrderVerdictArgs): Promise<TerminalVerdict> {
  return inOrderLifecycleLane(String(args.orderId), () => applyOrderVerdictInLane(args));
}

/** Caller owns the order lifecycle lane. */
export async function applyOrderVerdictInLane(
  args: ApplyOrderVerdictArgs,
): Promise<TerminalVerdict> {
  const order = args.orderRepo.findById(args.orderId);
  if (!order) return { status: "unresolved" };
  if (args.isCurrent && !args.isCurrent()) return { status: "unresolved" };
  const applied = (verdict: TerminalVerdict): TerminalVerdict => {
    // Publication can invalidate the owner. Commit proof after events, while
    // still holding the lane; working verdicts revoke it without yielding.
    if (!args.isCurrent || args.isCurrent()) args.onVerdictApplied?.(verdict);
    return verdict;
  };
  const gross = persistedGrossShares(args.fillRepo, order);
  const completionTolerance = args.fillCompletionTolerance ?? DEFAULT_FILL_COMPLETION_TOLERANCE;
  const verdict = resolveOrderStatusVerdict(order, args.exchange, gross, completionTolerance);
  const exchangeWorking =
    args.exchange?.status === "OPEN" || args.exchange?.status === "PARTIALLY_FILLED";
  if (exchangeWorking) {
    if (verdict.status !== "open" && verdict.status !== "partially-filled") {
      return applied({ status: "unresolved" });
    }
    if (order.status === "filled" || order.status === "cancelled" || order.status === "rejected") {
      return applied({ status: "unresolved" });
    }
    if (order.status !== verdict.status) args.orderRepo.updateStatus(order.orderId, verdict.status);
    return applied(verdict);
  }
  if (order.status === "filled" || order.status === "cancelled" || order.status === "rejected") {
    if (hasLocalFullCoverage(order, gross, completionTolerance)) {
      if (order.status !== "filled") args.orderRepo.updateStatus(order.orderId, "filled");
      return applied({ status: "filled" });
    }
    // A durable local terminal row is not proof that an exchange-live order stopped
    // working. Preserve the durable row, but report the exact verdict so a transition
    // fence cannot be released by local state alone.
    if (verdict.status === "open" || verdict.status === "partially-filled") {
      return applied({ status: "unresolved" });
    }
    if (verdict.status === "unresolved") return applied(verdict);
    return applied(verdict);
  }
  if (
    verdict.status === "open" ||
    verdict.status === "partially-filled" ||
    verdict.status === "unresolved"
  ) {
    if (verdict.status !== "unresolved" && order.status !== verdict.status)
      args.orderRepo.updateStatus(order.orderId, verdict.status);
    return applied(verdict);
  }
  if (
    verdict.status === "filled" ||
    verdict.status === "cancelled" ||
    verdict.status === "rejected"
  )
    await persistTerminalVerdictInLane(args, order, verdict, gross);
  return applied(verdict);
}

/** Persist before the first await; caller owns the order lifecycle lane. */
export async function persistTerminalVerdictInLane(
  args: ApplyOrderVerdictArgs,
  order: Order,
  verdict: Extract<TerminalVerdict, { status: "filled" | "cancelled" | "rejected" }>,
  gross: number,
): Promise<void> {
  const cancellationTimestamp =
    verdict.status === "cancelled" ? (args.timestamp ?? Date.now()) : undefined;
  const fallbackAge =
    cancellationTimestamp !== undefined && args.cancelTelemetry === undefined
      ? computeAgeMs(order.createdAt, cancellationTimestamp)
      : null;
  const reason =
    verdict.status === "cancelled"
      ? verdict.reason === RESOLVED_LOSER_LOCAL_CANCEL_REASON
        ? verdict.reason
        : (cancelIntents.get(String(order.orderId)) ?? verdict.reason)
      : verdict.status === "rejected"
        ? verdict.reason
        : undefined;
  const cancelTelemetry =
    verdict.status === "cancelled"
      ? {
          ...(args.cancelTelemetry ?? {
            cancelAgeMs: fallbackAge,
            cancelAgeBucket: classifyCancelAgeBucket(fallbackAge),
            marketHorizon: null,
          }),
          fillProgressShares: gross,
        }
      : args.cancelTelemetry;
  if (reason === undefined && cancelTelemetry === undefined) {
    args.orderRepo.updateStatus(order.orderId, verdict.status);
  } else if (cancelTelemetry === undefined) {
    args.orderRepo.updateStatus(order.orderId, verdict.status, undefined, reason);
  } else {
    args.orderRepo.updateStatus(order.orderId, verdict.status, undefined, reason, cancelTelemetry);
  }
  clearCancelIntent(String(order.orderId));
  if (args.publish && args.bus) {
    const timestamp = cancellationTimestamp ?? args.timestamp ?? Date.now();
    const commandId = createCommandId(`exact-terminal-${String(order.orderId)}-${timestamp}`);
    if (verdict.status === "cancelled") {
      await args.bus.publish("OrderCancelled", {
        commandId,
        orderId: order.orderId,
        tokenId: order.tokenId,
        conditionId: order.conditionId,
        reason: reason ?? verdict.reason,
        signalReason: order.signalReason ?? null,
        timestamp,
      });
    } else if (verdict.status === "rejected") {
      await args.bus.publish("OrderRejected", {
        commandId,
        clientOrderId: order.clientOrderId,
        tokenId: order.tokenId,
        conditionId: order.conditionId,
        reason: verdict.reason,
        errorCode: ExchangeErrorCode.Unknown,
        signalReason: order.signalReason ?? null,
        side: order.side,
        signalId: order.signalId ?? null,
        decisionRuleId: order.decisionRuleId ?? null,
        signalTimestamp: order.signalTimestamp ?? null,
        exchangeErrorMessage: verdict.reason,
        exchangeErrorDetails: null,
        timestamp,
      });
    }
  }
}
