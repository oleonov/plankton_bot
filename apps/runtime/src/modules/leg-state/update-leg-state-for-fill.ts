import { deriveState } from "@krabs/domain";
import type {
  ClientOrderId,
  ConditionId,
  FillId,
  LegPhase,
  LegState,
  LegStateRepository,
  LegStateTransitionAction,
  LegStateTransitionRepository,
  OrderId,
  PositionId,
  TokenId,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";

export interface LegStateFillInput {
  tokenId: TokenId;
  side: "buy" | "sell";
  price: number;
  filledAt: string;
  fillId?: FillId | null;
  orderId?: OrderId | null;
  clientOrderId?: ClientOrderId | null;
  conditionId?: ConditionId | null;
  positionId?: PositionId | null;
  size?: number | null;
  sizeUsdc?: number | null;
}

export interface LegStateTransitionAuditOptions {
  transitionRepo?: LegStateTransitionRepository | undefined;
  reason?: string;
}

/**
 * Pure increment of a leg_state row from a single fill. Shared between the
 * live tracker (LegStateTrackerModule.handleFill) and the startup replay
 * path (rebuildLegStatesFromLedger inside runStartupPositionAdoption), so
 * that both produce byte-identical leg_states regardless of whether fills
 * arrive as live events or are replayed from the ledger at boot.
 *
 * Caller owns the `now` timestamp to keep the function deterministic under
 * test. A SELL fill with no pre-existing leg_state is a protocol violation
 * (can't sell what was never bought) — it is logged at WARN and skipped,
 * matching the live tracker's pre-existing behavior.
 */
export function updateLegStateForFill(
  repo: LegStateRepository,
  fill: LegStateFillInput,
  log: Logger,
  now: string,
  audit: LegStateTransitionAuditOptions = {},
): void {
  const existing = repo.get(fill.tokenId);
  const next = nextLegStateForFill(existing, fill, now);

  if (!next) {
    log.warn(
      { tokenId: String(fill.tokenId) },
      "SELL fill received with no open leg state — skipping",
    );
    return;
  }

  repo.upsert(next);
  recordLegStateTransition({
    transitionRepo: audit.transitionRepo,
    tokenId: fill.tokenId,
    positionId: fill.positionId ?? null,
    fillId: fill.fillId ?? null,
    orderId: fill.orderId ?? null,
    clientOrderId: fill.clientOrderId ?? null,
    conditionId: fill.conditionId ?? null,
    fromState: existing,
    toState: next,
    action: fill.side === "buy" ? "BUY" : "SELL",
    price: fill.price,
    size: fill.size ?? null,
    sizeUsdc: fill.sizeUsdc ?? null,
    reason: audit.reason ?? "fill_received",
    occurredAt: fill.filledAt,
    log,
  });
}

export function nextLegStateForFill(
  existing: LegState | null,
  fill: LegStateFillInput,
  now: string,
): LegState | null {
  // ADR-027 §D-C — accumulate buy/sell sizes + buy notional at the same
  // chokepoint that maintains buy_count / sell_count, so backfill on next
  // bot restart happens automatically via the ledger-replay path. fill.size
  // is null on legacy events that pre-date the size-on-fill plumbing; treat
  // those as zero-contribution to keep the cumulative columns monotonic.
  // BUY notional uses sizeUsdc (cash delivered) to mirror inventory-handler's
  // `unitCost = sizeUsdc / size`, so the LIFETIME VWAP
  // (cumulative_buy_notional / cumulative_buy_size) tracks the same arithmetic
  // as the first-SELL avg_entry_price. After partial sells, the inventory
  // engine recomputes positions.avg_entry_price via FIFO from remaining lots —
  // the lifetime VWAP no longer matches, and exit_pnl_pct sources the rolling
  // basis from positions.avg_entry_price directly (these columns stay as
  // audit telemetry / fallback). Fall back to price * size only when sizeUsdc
  // is missing (legacy fills).
  const fillSize = Number.isFinite(fill.size) ? (fill.size as number) : 0;
  const fillBuyNotional = Number.isFinite(fill.sizeUsdc)
    ? (fill.sizeUsdc as number)
    : fill.price * fillSize;
  if (fill.side === "buy") {
    if (!existing) {
      return {
        tokenId: fill.tokenId,
        buyCount: 1,
        sellCount: 0,
        lastAction: "BUY",
        firstTradePrice: fill.price,
        firstTradeAt: fill.filledAt,
        lastTradeAt: fill.filledAt,
        updatedAt: now,
        cumulativeBuySize: fillSize,
        cumulativeBuyNotional: fillBuyNotional,
        cumulativeSellSize: 0,
        consecutiveSellResidualRejects: 0,
        abandonedAtPrice: null,
        abandonedAtTs: null,
      };
    }
    // CHANGE B — a new BUY fill resets the dust counter and clears any
    // existing abandonment (R67 spec 11.5: 61.85% recovery is via new BUY).
    return {
      ...existing,
      buyCount: existing.buyCount + 1,
      lastAction: "BUY",
      lastTradeAt: fill.filledAt,
      updatedAt: now,
      cumulativeBuySize: (existing.cumulativeBuySize ?? 0) + fillSize,
      cumulativeBuyNotional: (existing.cumulativeBuyNotional ?? 0) + fillBuyNotional,
      consecutiveSellResidualRejects: 0,
      abandonedAtPrice: null,
      abandonedAtTs: null,
    };
  }

  if (!existing) return null;

  return {
    ...existing,
    sellCount: existing.sellCount + 1,
    lastAction: "SELL",
    lastTradeAt: fill.filledAt,
    updatedAt: now,
    cumulativeSellSize: (existing.cumulativeSellSize ?? 0) + fillSize,
  };
}

export function recordLegStateClearTransition(args: {
  transitionRepo?: LegStateTransitionRepository | undefined;
  tokenId: TokenId;
  existing: LegState | null;
  positionId?: PositionId | null;
  action: Extract<LegStateTransitionAction, "CLEAR" | "SETTLE">;
  reason: string;
  occurredAt: string;
  log: Logger;
}): void {
  if (!args.existing) return;

  recordLegStateTransition({
    transitionRepo: args.transitionRepo,
    tokenId: args.tokenId,
    positionId: args.positionId ?? null,
    fillId: null,
    orderId: null,
    clientOrderId: null,
    conditionId: null,
    fromState: args.existing,
    toState: null,
    action: args.action,
    price: null,
    size: null,
    sizeUsdc: null,
    reason: args.reason,
    occurredAt: args.occurredAt,
    log: args.log,
  });
}

export function deriveLegPhase(state: LegState | null): LegPhase {
  const algoState = deriveState(state);
  return algoState === "OTHER" ? "S0" : algoState;
}

function legCounts(state: LegState | null): { buyCount: number; sellCount: number } {
  return {
    buyCount: state?.buyCount ?? 0,
    sellCount: state?.sellCount ?? 0,
  };
}

function recordLegStateTransition(args: {
  transitionRepo?: LegStateTransitionRepository | undefined;
  tokenId: TokenId;
  positionId: PositionId | null;
  fillId: FillId | null;
  orderId: OrderId | null;
  clientOrderId: ClientOrderId | null;
  conditionId: ConditionId | null;
  fromState: LegState | null;
  toState: LegState | null;
  action: LegStateTransitionAction;
  price: number | null;
  size: number | null;
  sizeUsdc: number | null;
  reason: string;
  occurredAt: string;
  log: Logger;
}): void {
  if (!args.transitionRepo) return;

  const fromPhase = deriveLegPhase(args.fromState);
  const toPhase = deriveLegPhase(args.toState);
  const fromCounts = legCounts(args.fromState);
  const toCounts = legCounts(args.toState);

  try {
    const inserted = args.transitionRepo.insert({
      tokenId: args.tokenId,
      positionId: args.positionId,
      fillId: args.fillId,
      orderId: args.orderId,
      clientOrderId: args.clientOrderId,
      conditionId: args.conditionId,
      fromPhase,
      toPhase,
      action: args.action,
      price: args.price,
      size: args.size,
      sizeUsdc: args.sizeUsdc,
      fromBuyCount: fromCounts.buyCount,
      fromSellCount: fromCounts.sellCount,
      toBuyCount: toCounts.buyCount,
      toSellCount: toCounts.sellCount,
      reason: args.reason,
      occurredAt: args.occurredAt,
    });
    if (!inserted) return;
    args.log.info(
      {
        tokenId: String(args.tokenId),
        positionId: args.positionId ? String(args.positionId) : null,
        fillId: args.fillId ? String(args.fillId) : null,
        fromPhase,
        toPhase,
        action: args.action,
        reason: args.reason,
      },
      "leg phase transition recorded",
    );
  } catch (err) {
    args.log.warn(
      { err, tokenId: String(args.tokenId), action: args.action, reason: args.reason },
      "failed to record leg phase transition",
    );
  }
}
