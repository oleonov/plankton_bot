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
 *  - Family-scoped operator commands carry familyId.
 *  - PlaceOrderCommand includes tickSize and negRisk (F2 decision) so the execution
 *    engine never needs to look them up separately from the market catalog.
 *  - sequenceInTick is carried forward from the Signal (F3 decision) for audit trails.
 */

import type { TokenId, FamilyId, OrderId, ClientOrderId, CommandId } from "./ids.js";
import type { OrderSide, OrderType, OperatorActionType } from "./enums.js";

// ─── Exchange Order Commands ───────────────────────────────────────────────

export interface PlaceOrderCommand {
  readonly type: "PlaceOrderCommand";
  /** uuid v4 — unique per placement attempt; used for idempotency in the command log. */
  readonly commandId: CommandId;
  /** Deterministic sha256 hash of signal identity including sequenceInTick. */
  readonly clientOrderId: ClientOrderId;
  readonly source: "strategy" | "operator" | "reconciliation";
  readonly tokenId: TokenId;
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
  readonly familyId: FamilyId;
  /**
   * 0-based index within this strategy tick for the same family+token+side triple.
   * Carried forward from Signal.sequenceInTick (F3 resolution).
   */
  readonly sequenceInTick: number;
  /** Original signal reason (e.g. "probe-entry", "confirm-scale") for audit trails. */
  readonly signalReason: string | null;
  /** Unix seconds, used only when orderType is "GTD". */
  readonly expiration?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CancelOrderCommand {
  readonly type: "CancelOrderCommand";
  readonly commandId: CommandId;
  /** Exchange-assigned order ID. */
  readonly orderId: OrderId;
  readonly reason:
    | "strategy_exit"
    | "risk_breach"
    | "operator"
    | "shutdown"
    | "reconciliation"
    | "market_resolved"
    | "stale_entry_ttl"
    | "stale_entry_enddate"
    | "stale_exit_ttl"
    | "sell_replace_reprice"
    | "sell_replace_retry";
  readonly familyId: FamilyId;
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

// ─── Family-Scoped Operator Commands ─────────────────────────────────────

export interface FamilyReduceOnlyCommand {
  readonly type: "FamilyReduceOnlyCommand";
  readonly commandId: CommandId;
  readonly familyId: FamilyId;
  readonly reason: string;
  readonly action: Extract<OperatorActionType, "family_reduce_only">;
}

export interface FamilyQuarantineCommand {
  readonly type: "FamilyQuarantineCommand";
  readonly commandId: CommandId;
  readonly familyId: FamilyId;
  readonly reason: string;
  readonly action: Extract<OperatorActionType, "family_quarantine">;
}

export interface FamilyActivateCommand {
  readonly type: "FamilyActivateCommand";
  readonly commandId: CommandId;
  readonly familyId: FamilyId;
  readonly reason: string;
  readonly action: Extract<OperatorActionType, "family_activate">;
}

// ─── Discriminated Union ──────────────────────────────────────────────────

export type DomainCommand =
  | PlaceOrderCommand
  | CancelOrderCommand
  | PauseCommand
  | ResumeCommand
  | FamilyReduceOnlyCommand
  | FamilyQuarantineCommand
  | FamilyActivateCommand;
