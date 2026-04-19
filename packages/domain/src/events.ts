/**
 * Domain events — discriminated union on the `type` field.
 *
 * Rules:
 *  - Every event is a plain readonly object with a string-literal `type` discriminator.
 *  - No class instances, no methods, no runtime behaviour.
 *  - All timestamps are Unix milliseconds (number) unless labelled as ISO string.
 */

import type { TokenId, ConditionId, OrderId, FillId, ClientOrderId, CommandId } from "./ids.js";
import type {
  OrderSide,
  OrderType,
  LiquidityRole,
  OperatorActionType,
  ExchangeErrorCode,
  RuntimePhase,
} from "./enums.js";
import type { Signal, Position, NormalizedMarket, ReconciliationResult } from "./types.js";

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

export interface HotQuoteUpdated {
  readonly type: "HotQuoteUpdated";
  readonly tokenIds: readonly TokenId[];
  readonly refreshedAt: number;
}

export interface MarketResolvedHint {
  readonly type: "MarketResolvedHint";
  readonly conditionId: string;
  readonly marketId: string | null;
  readonly slug: string | null;
  readonly tokenIds: readonly TokenId[];
  readonly winningTokenId: TokenId | null;
  readonly timestamp: number;
}

export interface NewMarketDiscoveredHint {
  readonly type: "NewMarketDiscoveredHint";
  readonly conditionId: string;
  readonly marketId: string | null;
  readonly slug: string;
  readonly question: string | null;
  readonly active: boolean;
  readonly tokenIds: readonly TokenId[];
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

export interface SignalConversionSkipped {
  readonly type: "SignalConversionSkipped";
  readonly signal: Signal;
  readonly stage: "market-cache-miss" | "marketability" | "execution-terms" | "hard-liveness";
  readonly reasons: readonly string[];
  readonly diagnostics: Readonly<Record<string, unknown>>;
  readonly skippedAt: number;
}

export interface CooldownBypassApplied {
  readonly type: "CooldownBypassApplied";
  readonly tokenId: TokenId;
  readonly reason: "price-moved" | "spread-narrowed" | "trade-recency-improved";
  readonly previousCooldownUntil: number;
  readonly appliedAt: number;
}

export interface HotLaneActionApplied {
  readonly type: "HotLaneActionApplied";
  readonly tokenId: TokenId;
  readonly orderId: OrderId;
  readonly signalReason: string | null;
  readonly action:
    | "entry-reprice-cancel"
    | "entry-ttl-cancel"
    | "entry-suppress-cancel"
    | "exit-reprice-cancel"
    | "exit-ttl-cancel";
  readonly timestamp: number;
}

export interface HotLaneStateChanged {
  readonly type: "HotLaneStateChanged";
  readonly tokenId: TokenId;
  readonly previousState:
    | "quote-active"
    | "needs-reprice"
    | "cooling"
    | "suppressed"
    | "reactivated"
    | null;
  readonly nextState: "quote-active" | "needs-reprice" | "cooling" | "suppressed" | "reactivated";
  readonly reason:
    | "order-placed"
    | "entry-reprice-cancel"
    | "entry-ttl-cancel"
    | "entry-suppress-cancel"
    | "exit-reprice-cancel"
    | "exit-ttl-cancel"
    | "suppression-expired";
  readonly timestamp: number;
}

export interface ScanTickCompleted {
  readonly type: "ScanTickCompleted";
  readonly candidatesConsidered: number;
  readonly blockedByResolutionBuffer: number;
  readonly blockedByWindow: number;
  readonly gammaFallbackDustSignalsProduced: number;
  readonly scanPrimeSkippedByPolicy: number;
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
  readonly conditionId: ConditionId;
  readonly side: OrderSide;
  readonly price: number;
  readonly size: number;
  readonly orderType: OrderType;
  readonly signalReason: string | null;
  readonly timestamp: number;
}

export interface OrderFilled {
  readonly type: "OrderFilled";
  readonly commandId: CommandId;
  readonly clientOrderId: ClientOrderId;
  readonly orderId: OrderId;
  readonly tokenId: TokenId;
  readonly conditionId: ConditionId;
  readonly side: OrderSide;
  readonly price: number;
  readonly size: number;
  readonly timestamp: number;
}

export interface OrderCancelled {
  readonly type: "OrderCancelled";
  readonly commandId: CommandId;
  readonly orderId: OrderId;
  readonly tokenId: TokenId;
  readonly conditionId: ConditionId;
  readonly reason: string;
  readonly signalReason: string | null;
  readonly timestamp: number;
}

export interface OrderRejected {
  readonly type: "OrderRejected";
  readonly commandId: CommandId;
  readonly clientOrderId: ClientOrderId;
  readonly tokenId: TokenId;
  readonly conditionId: ConditionId;
  readonly reason: string;
  readonly errorCode: ExchangeErrorCode;
  readonly signalReason: string | null;
  readonly timestamp: number;
}

// ─── Fill ─────────────────────────────────────────────────────────────────

export interface FillReceived {
  readonly type: "FillReceived";
  readonly fillId: FillId;
  readonly orderId: OrderId;
  readonly clientOrderId: ClientOrderId;
  readonly tokenId: TokenId;
  readonly conditionId: ConditionId;
  readonly side: OrderSide;
  readonly price: number;
  /** Share quantity. */
  readonly size: number;
  /** USDC notional (= size × price). */
  readonly sizeUsdc: number;
  readonly liquidityRole: LiquidityRole;
  readonly fee: number;
  readonly feeRateBps: number;
  readonly signalReason: string | null;
  readonly timestamp: number;
}

// ─── Inventory / Risk ─────────────────────────────────────────────────────

export interface PositionUpdated {
  readonly type: "PositionUpdated";
  readonly position: Position;
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
  readonly targetId: string | null;
  readonly reason: string | null;
  readonly initiatorType: "operator" | "system";
  readonly initiator: string | null;
  readonly appliedAt: number;
}

// ─── Discriminated Union ──────────────────────────────────────────────────

export type DomainEvent =
  | MarketSnapshotReceived
  | NormalizedMarketUpdated
  | HotQuoteUpdated
  | MarketResolvedHint
  | NewMarketDiscoveredHint
  | SignalProduced
  | SignalApproved
  | SignalRejected
  | SignalConversionSkipped
  | CooldownBypassApplied
  | HotLaneActionApplied
  | HotLaneStateChanged
  | ScanTickCompleted
  | OrderPlaced
  | OrderFilled
  | OrderCancelled
  | OrderRejected
  | FillReceived
  | PositionUpdated
  | ReconciliationDriftDetected
  | ReconciliationComplete
  | RuntimePhaseChanged
  | OperatorCommandApplied;
