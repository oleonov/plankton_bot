import type { FamilyRuleBundle, NormalizedMarket, Order, OrderBookSnapshot } from "@plankton/domain";
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
}

export interface HotLaneReplayResult {
  readonly actions: PlannedHotLaneAction[];
  readonly cancels: number;
  readonly reprices: number;
  readonly suppressions: number;
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
  let lastMaintenanceAtMs: number | null = null;
  let quickCancelCount = 0;
  const orderSide = opts.order.signalReason === "repricing-exit" ? "sell" : "buy";
  let queueBaseline = captureQueueDepthBaseline(
    orderSide,
    opts.frames[0]?.book ?? null,
    opts.order.price,
  );

  for (const frame of opts.frames) {
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
      }
      queueBaseline = captureQueueDepthBaseline(orderSide, frame.book ?? null, opts.order.price);
    }
  }

  return {
    actions,
    cancels: actions.filter((action) => action.type === "cancel").length,
    reprices: actions.filter((action) => action.reason?.includes("reprice") === true).length,
    suppressions: actions.filter((action) => action.reason === "entry-suppress-cancel").length,
  };
}
