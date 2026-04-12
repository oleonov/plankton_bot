import type {
  FamilyRuleBundle,
  NormalizedMarket,
  Order,
  OrderBookSnapshot,
} from "@plankton/domain";
import {
  captureQueueDepthBaseline,
  DEFAULT_HOT_LANE_POLICY,
  planHotLaneOrderAction,
  type HotLanePolicy,
  type PlannedHotLaneAction,
} from "./hot-lane-policy.js";

export interface HotLaneReplayFrame {
  readonly nowMs: number;
  readonly market: NormalizedMarket | null;
  readonly book?: OrderBookSnapshot | null;
  readonly fillOccurred?: boolean;
}

export interface HotLaneReplayResult {
  readonly actions: PlannedHotLaneAction[];
  readonly cancels: number;
  readonly reprices: number;
  readonly suppressions: number;
  readonly orderCount: number;
  readonly fills: number;
  readonly fillRate: number;
  readonly avgFillLatencyMs: number | null;
  readonly avgRecycleLatencyMs: number | null;
  readonly tailOpenOrdersAtEnd: number;
  readonly tailUnfilledFrames: number;
}

export function runHotLaneReplay(opts: {
  readonly order: Pick<Order, "signalReason" | "price" | "sizeUsdc" | "createdAt">;
  readonly bundle: FamilyRuleBundle;
  readonly frames: readonly HotLaneReplayFrame[];
  readonly policy?: Partial<HotLanePolicy>;
}): HotLaneReplayResult {
  const policy = { ...DEFAULT_HOT_LANE_POLICY, ...opts.policy };
  const actions: PlannedHotLaneAction[] = [];
  let order = { ...opts.order };
  let orderPlacedAtMs = Date.parse(opts.order.createdAt);
  let lastMaintenanceAtMs: number | null = null;
  let quickCancelCount = 0;
  let orderCount = 1;
  let fills = 0;
  let tailUnfilledFrames = 0;
  const fillLatenciesMs: number[] = [];
  const orderSide = opts.order.signalReason === "repricing-exit" ? "sell" : "buy";
  let orderActive = true;
  let queueBaseline = captureQueueDepthBaseline(
    orderSide,
    opts.frames[0]?.book ?? null,
    opts.order.price,
  );

  for (const frame of opts.frames) {
    if (!orderActive) break;
    if (frame.fillOccurred) {
      fills += 1;
      fillLatenciesMs.push(Math.max(0, frame.nowMs - orderPlacedAtMs));
      orderActive = false;
      continue;
    }

    const action = planHotLaneOrderAction({
      order,
      market: frame.market,
      book: frame.book ?? null,
      bundle: opts.bundle,
      nowMs: frame.nowMs,
      lastMaintenanceAtMs,
      quickCancelCount,
      queueBaseline,
      policy,
    });
    actions.push(action);
    tailUnfilledFrames += 1;
    if (action.type === "cancel") {
      lastMaintenanceAtMs = frame.nowMs;
      if (action.reason === "entry-reprice-cancel" || action.reason === "entry-ttl-cancel") {
        quickCancelCount += 1;
      } else if (action.reason === "entry-suppress-cancel") {
        quickCancelCount = 0;
      }
      if (action.desiredPrice != null) {
        order = {
          ...order,
          price: action.desiredPrice,
          createdAt: new Date(frame.nowMs).toISOString(),
        };
        orderPlacedAtMs = frame.nowMs;
        orderCount += 1;
      }
      queueBaseline = captureQueueDepthBaseline(orderSide, frame.book ?? null, order.price);
    }
  }

  const avgFillLatencyMs =
    fillLatenciesMs.length === 0
      ? null
      : fillLatenciesMs.reduce((sum, value) => sum + value, 0) / fillLatenciesMs.length;

  return {
    actions,
    cancels: actions.filter((action) => action.type === "cancel").length,
    reprices: actions.filter((action) => action.reason?.includes("reprice") === true).length,
    suppressions: actions.filter((action) => action.reason === "entry-suppress-cancel").length,
    orderCount,
    fills,
    fillRate: orderCount === 0 ? 0 : fills / orderCount,
    avgFillLatencyMs,
    avgRecycleLatencyMs: avgFillLatencyMs,
    tailOpenOrdersAtEnd: orderActive ? 1 : 0,
    tailUnfilledFrames,
  };
}
