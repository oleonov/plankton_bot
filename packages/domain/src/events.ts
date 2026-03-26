/**
 * Domain events — discriminated union on the `type` field.
 *
 * Rules:
 *  - Every event is a plain readonly object with a string-literal `type` discriminator.
 *  - No class instances, no methods, no runtime behaviour.
 *  - All timestamps are Unix milliseconds (number) unless labelled as ISO string.
 */

import type { TokenId, FamilyId, OrderId, FillId, ClientOrderId, CommandId } from "./ids.js";
import type {
  OrderSide,
  OrderType,
  OperatorActionType,
  ExchangeErrorCode,
  RuntimePhase,
} from "./enums.js";
import type {
  Signal,
  Position,
  FamilyState,
  NormalizedMarket,
  ReconciliationResult,
} from "./types.js";

// ─── Market Data ──────────────────────────────────────────────────────────

export interface MarketSnapshotReceived {
  readonly type: "MarketSnapshotReceived";
  readonly markets: readonly NormalizedMarket[];
  readonly timestamp: number;
}

export interface NormalizedMarketUpdated {
  readonly type: "NormalizedMarketUpdated";
  readonly markets: readonly NormalizedMarket[];
  readonly timestamp: number;
}

// ─── Strategy / Signal ────────────────────────────────────────────────────

export interface SignalProduced {
  readonly type: "SignalProduced";
  readonly signal: Signal;
}

export interface SignalApproved {
  readonly type: "SignalApproved";
  readonly signal: Signal;
  readonly approvedAt: number;
}

export interface SignalRejected {
  readonly type: "SignalRejected";
  readonly signal: Signal;
  readonly reason: string;
  readonly rejectedAt: number;
}

export interface ScanTickCompleted {
  readonly type: "ScanTickCompleted";
  readonly candidatesConsidered: number;
  readonly blockedByResolutionBuffer: number;
  readonly blockedByWeekend: number;
  readonly blockedByWindow: number;
  readonly signalsProduced: number;
  readonly entrySignals: number;
  readonly exitSignals: number;
  readonly timestamp: number;
}

// ─── Order Lifecycle ──────────────────────────────────────────────────────

export interface OrderPlaced {
  readonly type: "OrderPlaced";
  readonly commandId: CommandId;
  readonly clientOrderId: ClientOrderId;
  readonly orderId: OrderId;
  readonly tokenId: TokenId;
  readonly side: OrderSide;
  readonly price: number;
  readonly size: number;
  readonly orderType: OrderType;
  readonly familyId: FamilyId;
  readonly timestamp: number;
}

export interface OrderFilled {
  readonly type: "OrderFilled";
  readonly commandId: CommandId;
  readonly clientOrderId: ClientOrderId;
  readonly orderId: OrderId;
  readonly tokenId: TokenId;
  readonly side: OrderSide;
  readonly price: number;
  readonly size: number;
  readonly familyId: FamilyId;
  readonly timestamp: number;
}

export interface OrderCancelled {
  readonly type: "OrderCancelled";
  readonly commandId: CommandId;
  readonly orderId: OrderId;
  readonly reason: string;
  readonly familyId: FamilyId;
  readonly timestamp: number;
}

export interface OrderRejected {
  readonly type: "OrderRejected";
  readonly commandId: CommandId;
  readonly clientOrderId: ClientOrderId;
  readonly reason: string;
  readonly errorCode: ExchangeErrorCode;
  readonly familyId: FamilyId;
  readonly timestamp: number;
}

// ─── Fill ─────────────────────────────────────────────────────────────────

export interface FillReceived {
  readonly type: "FillReceived";
  readonly fillId: FillId;
  readonly orderId: OrderId;
  readonly clientOrderId: ClientOrderId;
  readonly tokenId: TokenId;
  readonly side: OrderSide;
  readonly price: number;
  /** Share quantity. */
  readonly size: number;
  /** USDC notional (= size × price). */
  readonly sizeUsdc: number;
  readonly fee: number;
  readonly familyId: FamilyId;
  readonly timestamp: number;
}

// ─── Inventory / Risk ─────────────────────────────────────────────────────

export interface PositionUpdated {
  readonly type: "PositionUpdated";
  readonly position: Position;
}

export interface FamilyExposureChanged {
  readonly type: "FamilyExposureChanged";
  readonly familyId: FamilyId;
  readonly totalExposureUsdc: number;
  readonly openPositionCount: number;
  /** Full family runtime state snapshot at the time of the change. */
  readonly familyState: FamilyState;
  readonly timestamp: number;
}

// ─── Reconciliation ───────────────────────────────────────────────────────

export interface ReconciliationDriftDetected {
  readonly type: "ReconciliationDriftDetected";
  readonly details: string;
  readonly severity: "warn" | "critical";
  readonly timestamp: number;
}

export interface ReconciliationComplete {
  readonly type: "ReconciliationComplete";
  readonly result: ReconciliationResult;
}

// ─── Supervisor / Lifecycle ───────────────────────────────────────────────

export interface RuntimePhaseChanged {
  readonly type: "RuntimePhaseChanged";
  readonly phase: RuntimePhase;
  readonly timestamp: number;
}

// ─── Operator ─────────────────────────────────────────────────────────────

export interface OperatorCommandApplied {
  readonly type: "OperatorCommandApplied";
  /** Corresponds to operator_commands.id in the DB. */
  readonly commandDbId: number;
  readonly action: OperatorActionType;
  readonly targetFamilyId: FamilyId | null;
  readonly reason: string | null;
  readonly appliedAt: number;
}

// ─── Discriminated Union ──────────────────────────────────────────────────

export type DomainEvent =
  | MarketSnapshotReceived
  | NormalizedMarketUpdated
  | SignalProduced
  | SignalApproved
  | SignalRejected
  | ScanTickCompleted
  | OrderPlaced
  | OrderFilled
  | OrderCancelled
  | OrderRejected
  | FillReceived
  | PositionUpdated
  | FamilyExposureChanged
  | ReconciliationDriftDetected
  | ReconciliationComplete
  | RuntimePhaseChanged
  | OperatorCommandApplied;
