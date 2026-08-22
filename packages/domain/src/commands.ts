/**
 * Domain commands — discriminated union on the `type` field.
 *
 * Commands represent intent directed at the execution engine or supervisor.
 * Every command that touches the exchange carries a unique `commandId` (uuid v4)
 * for idempotency and a deterministic `clientOrderId` (sha256-derived, built with
 * buildClientOrderId from ids.ts) for exchange-level deduplication.
 *
 * Rules:
 *  - Pure data; no runtime behaviour.
 *  - Every command that touches the exchange carries both commandId and clientOrderId.
 *  - PlaceOrderCommand includes tickSize and negRisk (F2 decision) so the execution
 *    engine never needs to look them up separately from the market catalog.
 *  - sequenceInTick is carried forward from the Signal (F3 decision) for audit trails.
 */

import type { TokenId, ConditionId, OrderId, ClientOrderId, CommandId, PositionId } from "./ids.js";
import type { OrderSide, OrderType } from "./enums.js";

// ─── Exchange Order Commands ───────────────────────────────────────────────

export interface PlaceOrderCommand {
  readonly type: "PlaceOrderCommand";
  /** uuid v4 — unique per placement attempt; used for idempotency in the command log. */
  readonly commandId: CommandId;
  /** Deterministic sha256 hash of signal identity including sequenceInTick. */
  readonly clientOrderId: ClientOrderId;
  readonly source: "strategy" | "operator" | "reconciliation";
  readonly tokenId: TokenId;
  readonly conditionId: ConditionId;
  readonly side: OrderSide;
  /** Share quantity. */
  readonly size: number;
  /** Limit price in [0, 1] range for binary markets. */
  readonly price: number;
  /** When true, the order must rest on the book and never cross as taker. */
  readonly postOnly?: boolean;
  readonly orderType: OrderType;
  /** Minimum price increment for this token — required by Polymarket CLOB order signing. */
  readonly tickSize: number;
  /** Neg-risk flag for this token — required by Polymarket CLOB order signing. */
  readonly negRisk: boolean;
  /**
   * 0-based index within this strategy tick for the same token+side triple.
   * Carried forward from Signal.sequenceInTick (F3 resolution).
   */
  readonly sequenceInTick: number;
  /** Original signal reason (e.g. "probe-entry", "confirm-scale") for audit trails. */
  readonly signalReason: string | null;
  readonly signalId?: string | null;
  readonly decisionRuleId?: string | null;
  readonly signalTimestamp?: string | null;
  /** Unix seconds, used only when orderType is "GTD". */
  readonly expiration?: number;
  /** Maker-entry provenance. Set to "maker" for Phase 5 micro-live post-only BUYs; null/undefined otherwise. */
  readonly entryStyle?: "probe" | "maker" | null;
  /**
   * Release A Phase 3: EXACT originating position identity, taken from the planner
   * snapshot / the producing engine's Position (NEVER re-looked-up by token). Present
   * on every strategy SELL and on a scale-in/add BUY bound to an existing position;
   * absent on an initial-entry BUY that opens a new cycle. The executor rejects any
   * command whose positionId ≠ the token's single active position (stale cross-cycle).
   */
  readonly positionId?: PositionId | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * ADR-025 §D-C — cancel-reason taxonomy. Each literal corresponds to
 * a production code path that publishes `CancelOrderCommand`, with one
 * exception: `phantom_missing_on_exchange` is written by the
 * reconciler's phantom-recovery branch
 * (`order-reconciler.ts`) directly into `orders.cancel_reason`
 * without publishing a command, because the order is already gone on
 * the exchange and there is nothing to cancel via the bus. The
 * literal lives in this union so all consumers of cancel reasons see
 * it as a typed value rather than an opaque string.
 */
export type CancelOrderReason =
  | "market_resolved"
  | "stale_entry_ttl"
  | "outbid_repriced"
  | "stale_entry_enddate"
  | "stale_exit_ttl"
  | "downpriced_reprice"
  | "buy_duplicate_replacement"
  | "sell_replace_reprice"
  | "sell_replace_retry"
  | "sell_timeout_escalation"
  | "s1_handoff_to_qd"
  | "operator"
  | "maker_fast_cancel"
  | "maker_capture_reprice"
  | "phantom_missing_on_exchange"
  | "exit_loss_floor";

export interface CancelOrderCommand {
  readonly type: "CancelOrderCommand";
  readonly commandId: CommandId;
  /** Exchange-assigned order ID. */
  readonly orderId: OrderId;
  readonly reason: CancelOrderReason;
}

// ─── Global Operator Commands ─────────────────────────────────────────────

export interface PauseCommand {
  readonly type: "PauseCommand";
  readonly commandId: CommandId;
  readonly reason: string;
}

export interface ResumeCommand {
  readonly type: "ResumeCommand";
  readonly commandId: CommandId;
  readonly reason: string;
}

// ─── Discriminated Union ──────────────────────────────────────────────────

export type DomainCommand = PlaceOrderCommand | CancelOrderCommand | PauseCommand | ResumeCommand;
