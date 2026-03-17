/**
 * EventBus interface, RuntimeModule lifecycle interface, and RiskGate interface.
 *
 * The EventBus is the sole inter-module communication backbone. No module holds
 * direct references to another module's internals — all cross-module communication
 * goes through publish/subscribe or injected interfaces (RiskGate, etc.).
 *
 * Rules:
 *  - publish() and all handlers are async (Promise-based). No sync dispatch.
 *  - subscribe() returns an unsubscribe function; call it during stop() to prevent leaks.
 *  - RuntimeModule is the lifecycle contract every module must implement.
 *  - The supervisor calls start() / stop() in the documented phase order.
 *  - RiskGate is resolved inline by the risk-inventory module on SignalProduced.
 */

import type { TokenId, FamilyId, OrderId, FillId, ClientOrderId, CommandId, PositionId } from "./ids.js";
import type { OrderSide, OrderType, OperatorActionType, ExchangeErrorCode, RuntimePhase } from "./enums.js";
import type { Signal, Position, FamilyState, NormalizedMarket, ReconciliationResult, RiskDecision } from "./types.js";
import type { PlaceOrderCommand, CancelOrderCommand } from "./commands.js";

// ─── RuntimeEventMap ──────────────────────────────────────────────────────

/**
 * Complete map of event name -> payload type.
 * EventBus.publish and EventBus.subscribe are constrained to these pairs,
 * giving compile-time safety on both the publish side and the handler side.
 */
export interface RuntimeEventMap {
  PlaceOrderRequested: {
    readonly command: PlaceOrderCommand;
    readonly timestamp: number;
  };

  CancelOrderRequested: {
    readonly command: CancelOrderCommand;
    readonly timestamp: number;
  };

  MarketSnapshotReceived: {
    readonly markets: readonly NormalizedMarket[];
    readonly timestamp: number;
  };

  NormalizedMarketUpdated: {
    readonly markets: readonly NormalizedMarket[];
    readonly timestamp: number;
  };

  SignalProduced: {
    readonly signal: Signal;
  };

  SignalApproved: {
    readonly signal: Signal;
    readonly approvedAt: number;
  };

  SignalRejected: {
    readonly signal: Signal;
    readonly reason: string;
    readonly rejectedAt: number;
  };

  OrderPlaced: {
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
  };

  OrderFilled: {
    readonly commandId: CommandId;
    readonly clientOrderId: ClientOrderId;
    readonly orderId: OrderId;
    readonly tokenId: TokenId;
    readonly side: OrderSide;
    readonly price: number;
    readonly size: number;
    readonly familyId: FamilyId;
    readonly timestamp: number;
  };

  OrderCancelled: {
    readonly commandId: CommandId;
    readonly orderId: OrderId;
    readonly reason: string;
    readonly familyId: FamilyId;
    readonly timestamp: number;
  };

  OrderRejected: {
    readonly commandId: CommandId;
    readonly clientOrderId: ClientOrderId;
    readonly reason: string;
    readonly errorCode: ExchangeErrorCode;
    readonly familyId: FamilyId;
    readonly timestamp: number;
  };

  FillReceived: {
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
  };

  PositionUpdated: {
    readonly position: Position;
  };

  FamilyExposureChanged: {
    readonly familyId: FamilyId;
    readonly totalExposureUsdc: number;
    readonly openPositionCount: number;
    readonly familyState: FamilyState;
    readonly timestamp: number;
  };

  ReconciliationDriftDetected: {
    readonly details: string;
    readonly severity: "warn" | "critical";
    readonly timestamp: number;
  };

  ReconciliationComplete: {
    readonly result: ReconciliationResult;
  };

  RuntimePhaseChanged: {
    readonly phase: RuntimePhase;
    readonly timestamp: number;
  };

  OperatorCommandApplied: {
    readonly commandDbId: number;
    readonly action: OperatorActionType;
    readonly targetFamilyId: FamilyId | null;
    readonly reason: string | null;
    readonly appliedAt: number;
  };

  MarketDataPollProgress: {
    readonly active: boolean;
    readonly page: number;
    readonly botRunId: string;
  };

  MarketResolved: {
    readonly conditionId: string;
    readonly tokenIds: readonly TokenId[];
    readonly resolution: "YES" | "NO" | "unknown";
    readonly resolvedAt: string;
    readonly source: string;
    readonly timestamp: number;
  };

  PositionSettled: {
    readonly positionId: PositionId;
    readonly tokenId: TokenId;
    readonly familyId: FamilyId;
    readonly resolution: "YES" | "NO" | "unknown";
    readonly settlementPrice: number;
    readonly realizedPnl: number;
    readonly size: number;
    readonly avgEntryPrice: number;
    readonly timestamp: number;
  };
}

// ─── EventBus interface ───────────────────────────────────────────────────

export interface EventBus {
  /** Publish an event to all registered subscribers for that event type. */
  publish<K extends keyof RuntimeEventMap>(
    event: K,
    payload: RuntimeEventMap[K],
  ): Promise<void>;

  /** Register an async handler for an event type. Returns an unsubscribe function. */
  subscribe<K extends keyof RuntimeEventMap>(
    event: K,
    handler: (payload: RuntimeEventMap[K]) => Promise<void>,
  ): () => void;

  /** Wait until all in-flight handlers have resolved. */
  drain(timeoutMs?: number): Promise<void>;
}

// ─── RuntimeModule interface ──────────────────────────────────────────────

/**
 * Lifecycle contract that every runtime module must implement.
 * The supervisor calls start() / stop() in the documented phase order.
 */
export interface RuntimeModule {
  /** Initialise internal state, register event bus subscriptions, and start timers. */
  start(): Promise<void>;

  /** Unsubscribe all event handlers, stop timers, and release resources. Idempotent. */
  stop(): Promise<void>;

  /** Return a point-in-time health snapshot. */
  healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }>;
}

// ─── RiskGate interface ───────────────────────────────────────────────────

/**
 * Inline eligibility gate called by the risk-inventory module when a
 * SignalProduced event arrives. Returns a full RiskDecision (from types.ts)
 * so that audit logging, the API, and the risk module all share one contract.
 *
 * On approved=true  → risk-inventory publishes SignalApproved.
 * On approved=false → risk-inventory publishes SignalRejected.
 */
export interface RiskGate {
  evaluate(signal: Signal): Promise<RiskDecision>;
}
