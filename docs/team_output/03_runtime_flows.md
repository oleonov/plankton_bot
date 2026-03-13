# 03 Runtime Flows, Execution Contracts, and Reconciliation Design

Date: 2026-03-13
Author: Runtime / Exchange Engineer

---

## 1. Runtime Module Layout

```text
apps/runtime/src/
  main.ts                         # entry point, wires supervisor
  supervisor/
    supervisor.ts                 # startup/shutdown orchestration
    health.ts                     # liveness + readiness state
  market-data/
    market-data-source.ts         # REST/WS polling, raw feed ingestion
    market-data-publisher.ts      # publishes MarketSnapshot events
  normalization/
    market-normalizer.ts          # raw -> NormalizedMarket
    family-classifier.ts          # assigns family_key, regime, horizon
  strategy/
    scanner.ts                    # iterates normalized markets, emits signals
    signal-filter.ts              # dedup + staleness guard
  risk-inventory/
    risk-gate.ts                  # entry eligibility, exposure checks
    inventory-tracker.ts          # live position/family state
    tail-health.ts                # tail-adjusted family health score
  execution/
    execution-engine.ts           # accepts commands, deduplicates, dispatches
    client-order-id.ts            # deterministic ID generation
    command-log.ts                # idempotency log (command_id -> status)
  reconciliation/
    reconciler.ts                 # diff local vs exchange, emit drift events
    startup-reconciler.ts         # full snapshot recon on boot
  shared/
    rate-limiter.ts               # token-bucket rate limiter
    types.ts                      # module-local type re-exports
```

Packages consumed by these modules:

| Package | Purpose |
|---|---|
| `@plankton/domain` | Shared value objects, enums, entity types |
| `@plankton/event-bus` | Typed in-process bus with async handlers |
| `@plankton/db` | Repository interfaces + SQLite v1 implementations |
| `@plankton/exchange` | ExchangeGateway interface + Live/Sim implementations |

---

## 2. Event Flow Diagram

```text
  market-data-source
        |
        | MarketSnapshotReceived
        v
  normalization
        |
        | NormalizedMarketUpdated
        v
  strategy/scanner ---------> risk-inventory/risk-gate
        |                            |
        | SignalProduced             | (sync call: checkEligibility)
        v                            |
  risk-inventory/risk-gate <---------+
        |
        | [eligible]  SignalApproved
        | [rejected]  SignalRejected
        v
  execution/execution-engine
        |
        +--- PlaceOrderCommand ----> ExchangeGateway
        +--- CancelOrderCommand ---> ExchangeGateway
        |
        | OrderAccepted / OrderRejected / OrderCancelled / FillReceived
        v
  risk-inventory/inventory-tracker
        |
        | PositionUpdated / FamilyExposureChanged
        v
  persistence (via @plankton/db repositories)

  reconciliation (periodic + startup)
        |
        | ReconciliationDriftDetected / ReconciliationComplete
        v
  risk-inventory + execution (state corrections)

  supervisor
        |
        | RuntimePhaseChanged (Booting -> Reconciling -> Ready -> ShuttingDown -> Stopped)
        v
  all modules (lifecycle awareness)
```

### Complete Event Catalog

| Event | Producer | Consumers |
|---|---|---|
| `MarketSnapshotReceived` | market-data | normalization |
| `NormalizedMarketUpdated` | normalization | strategy |
| `SignalProduced` | strategy | risk-inventory |
| `SignalApproved` | risk-inventory | execution |
| `SignalRejected` | risk-inventory | persistence (logging) |
| `PlaceOrderRequested` | execution (internal) | exchange gateway (via direct call) |
| `OrderAccepted` | execution | risk-inventory, persistence |
| `OrderRejected` | execution | risk-inventory, persistence |
| `OrderCancelled` | execution | risk-inventory, persistence |
| `FillReceived` | execution | risk-inventory, persistence |
| `PositionUpdated` | risk-inventory | persistence |
| `FamilyExposureChanged` | risk-inventory | strategy (for re-eval) |
| `ReconciliationDriftDetected` | reconciliation | risk-inventory, execution |
| `ReconciliationComplete` | reconciliation | supervisor |
| `RuntimePhaseChanged` | supervisor | all modules |

---

## 3. Command Pipeline

How a signal becomes an order, step by step:

```text
Step 1: Scanner tick
  - scanner iterates NormalizedMarket snapshots
  - applies family rules (probe vs scaled, allowlist, session window)
  - if candidate found, emits SignalProduced

Step 2: Risk gate
  - risk-gate handler receives SignalProduced
  - checks:
    a. family state != quarantine or reduce-only (for entries)
    b. family exposure < max allowed
    c. tail-adjusted health passes threshold
    d. dust cap not reached
    e. no session restriction active
  - if all pass: emits SignalApproved with enriched context
  - if any fail: emits SignalRejected with reason

Step 3: Execution engine
  - receives SignalApproved
  - generates deterministic client_order_id from signal identity
  - generates unique command_id (uuid v4)
  - checks command dedup log: if command_id or equivalent semantic key already processed, skip
  - checks rate limiter: if budget exhausted, queue or reject
  - builds PlaceOrderCommand
  - calls exchangeGateway.placeOrder(...)
  - on success: emits OrderAccepted
  - on exchange error: emits OrderRejected with error classification

Step 4: Fill tracking
  - exchange gateway returns fill info (sync or via polling)
  - execution emits FillReceived
  - risk-inventory updates position, family exposure, P&L
```

### Deterministic Client Order ID

```typescript
// packages/exchange/src/client-order-id.ts

import { createHash } from 'node:crypto';

/**
 * Deterministic client order ID from signal identity.
 * Same signal identity always produces the same order ID,
 * making retries safe against duplicate placement.
 */
export function buildClientOrderId(parts: {
  familyId: string;       // "us_election:binary:short"
  marketTokenId: string;  // CLOB token ID
  side: 'BUY' | 'SELL';
  intentEpochMs: number;  // rounded to nearest strategy tick
}): string {
  const raw = `${parts.familyId}|${parts.marketTokenId}|${parts.side}|${parts.intentEpochMs}`;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `plk_${hash}`;
}
```

---

## 4. ExchangeGateway Interface

```typescript
// packages/exchange/src/exchange-gateway.ts

export interface PlaceOrderParams {
  clientOrderId: string;
  tokenId: string;          // Polymarket CLOB token ID
  side: 'BUY' | 'SELL';
  size: number;             // in token units
  price: number;            // limit price (0-1 range for binary)
  orderType: 'GTC' | 'GTD' | 'FOK';
  expiration?: number;      // unix seconds, for GTD
}

export interface CancelOrderParams {
  orderId: string;          // exchange-assigned order ID
}

export interface ExchangeOrder {
  orderId: string;
  clientOrderId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  sizeTotal: number;
  sizeFilled: number;
  sizeRemaining: number;
  status: 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'EXPIRED';
  createdAt: number;        // unix ms
}

export interface ExchangeFill {
  fillId: string;
  orderId: string;
  clientOrderId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  fee: number;
  timestamp: number;        // unix ms
}

export interface ExchangeBalance {
  asset: string;            // "USDC" or token ID
  available: number;
  locked: number;
}

export interface PlaceOrderResult {
  success: boolean;
  orderId?: string;
  errorCode?: ExchangeErrorCode;
  errorMessage?: string;
}

export interface CancelOrderResult {
  success: boolean;
  errorCode?: ExchangeErrorCode;
  errorMessage?: string;
}

export type ExchangeErrorCode =
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_PRICE'
  | 'INVALID_SIZE'
  | 'MARKET_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'NONCE_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export interface ExchangeGateway {
  /** Place a limit order. Never throws -- returns result object. */
  placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult>;

  /** Cancel a single order by exchange ID. */
  cancelOrder(params: CancelOrderParams): Promise<CancelOrderResult>;

  /** Cancel all open orders. Used during shutdown. */
  cancelAllOrders(): Promise<CancelOrderResult>;

  /** Fetch all currently open orders. */
  getOpenOrders(): Promise<ExchangeOrder[]>;

  /** Fetch open orders for a specific token. */
  getOpenOrdersForToken(tokenId: string): Promise<ExchangeOrder[]>;

  /** Fetch fills since a given timestamp. */
  getFills(sinceMs: number): Promise<ExchangeFill[]>;

  /** Fetch current balances / collateral. */
  getBalances(): Promise<ExchangeBalance[]>;

  /** Lightweight health check -- validates API key and connectivity. */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}
```

### Implementations

| Class | Module | Purpose |
|---|---|---|
| `LiveExchangeGateway` | `packages/exchange/src/live-gateway.ts` | Wraps `@polymarket/clob-client`, signs orders, hits real endpoints |
| `SimulationExchangeGateway` | `packages/exchange/src/sim-gateway.ts` | In-memory order book, instant fills at stated price, zero fees by default |

Both implement `ExchangeGateway`. The runtime receives the gateway via constructor injection; it never imports a concrete class.

---

## 5. Execution Engine Contract

### What it accepts

```typescript
// packages/domain/src/commands.ts

export interface PlaceOrderCommand {
  commandId: string;              // uuid v4, unique per attempt
  clientOrderId: string;          // deterministic from signal identity
  source: 'strategy' | 'operator' | 'reconciliation';
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  orderType: 'GTC' | 'GTD' | 'FOK';
  expiration?: number;
  familyId: string;
  metadata?: Record<string, unknown>;
}

export interface CancelOrderCommand {
  commandId: string;
  orderId: string;
  reason: 'strategy_exit' | 'risk_breach' | 'operator' | 'shutdown' | 'reconciliation';
  familyId: string;
}

export interface CancelAllOrdersCommand {
  commandId: string;
  reason: 'shutdown' | 'operator' | 'reconciliation';
}
```

### What it publishes

```typescript
// packages/domain/src/events.ts

export interface OrderAccepted {
  type: 'OrderAccepted';
  commandId: string;
  clientOrderId: string;
  orderId: string;            // exchange-assigned
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  familyId: string;
  timestamp: number;
}

export interface OrderRejected {
  type: 'OrderRejected';
  commandId: string;
  clientOrderId: string;
  reason: string;
  errorCode: ExchangeErrorCode;
  familyId: string;
  timestamp: number;
}

export interface OrderCancelled {
  type: 'OrderCancelled';
  commandId: string;
  orderId: string;
  reason: string;
  familyId: string;
  timestamp: number;
}

export interface FillReceived {
  type: 'FillReceived';
  fillId: string;
  orderId: string;
  clientOrderId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  fee: number;
  familyId: string;
  timestamp: number;
}
```

### Execution engine guarantees

1. **Command deduplication**: a `commandId` that was already processed is silently ignored. Result of the original attempt is returned.
2. **Semantic dedup**: if a `clientOrderId` has an open order on the exchange, a new `PlaceOrderCommand` with the same `clientOrderId` is rejected locally (no exchange call).
3. **Rate limit respect**: before calling the gateway, execution acquires a token from the shared rate limiter. If exhausted, the command is queued with bounded backpressure (max queue depth configurable, default 50).
4. **No business logic**: execution does not decide whether to trade. It only validates command shape and dedup, then dispatches.
5. **Error normalization**: all exchange errors are mapped to `ExchangeErrorCode` enum before publishing `OrderRejected`.

---

## 6. Reconciliation Flow

### 6.1 Startup Reconciliation

Runs once during boot, before strategy or execution are enabled.

```text
Step 1: Fetch exchange state
  - gateway.getOpenOrders()
  - gateway.getFills(since: lastKnownFillTimestamp from DB)
  - gateway.getBalances()

Step 2: Fetch local state
  - db.orders.getOpen()
  - db.fills.getLatest()
  - db.positions.getAll()

Step 3: Diff orders
  For each local open order:
    if not present on exchange -> mark as CANCELLED locally, emit OrderCancelled
  For each exchange open order:
    if not present locally -> insert as UNKNOWN_ORIGIN, flag for operator review

Step 4: Diff fills
  For each exchange fill not in local DB:
    -> insert fill
    -> update position
    -> emit FillReceived
  This is the critical path: a missed fill corrupts everything downstream.

Step 5: Diff balances
  Compare exchange balance vs sum(local positions + available).
  If mismatch exceeds threshold (configurable, default 1 USDC):
    -> emit ReconciliationDriftDetected with details
    -> log at WARN level
    -> do NOT auto-correct balance; flag for operator

Step 6: Emit result
  -> emit ReconciliationComplete { driftsFound: number, fillsRecovered: number }
  -> supervisor proceeds to next boot phase
```

### 6.2 Periodic Reconciliation

Runs on a configurable interval (default: every 60 seconds).

```text
Same steps as startup reconciliation, but:
  - runs while strategy and execution are active
  - if critical drift detected (missing fills), execution pauses until resolved
  - uses a lock to prevent overlapping recon cycles
  - rate-limited: recon calls count against the shared rate limiter budget
```

### Reconciliation state machine

```text
  IDLE --> RUNNING --> COMPLETED
                  \--> DRIFT_DETECTED --> OPERATOR_REVIEW
                                     \--> AUTO_REPAIRED (fills only)
```

### Key interface

```typescript
export interface ReconciliationResult {
  startedAt: number;
  completedAt: number;
  type: 'startup' | 'periodic';
  ordersOnExchange: number;
  ordersLocal: number;
  orphanedLocalOrders: number;     // local open but not on exchange
  unknownExchangeOrders: number;   // on exchange but not local
  missedFills: number;             // exchange fills not in local DB
  balanceDriftUsdc: number;        // absolute diff
  repairsApplied: string[];        // description of auto-repairs
  requiresOperatorReview: boolean;
}
```

---

## 7. Startup / Shutdown Sequence

### 7.1 Startup Sequence

```text
Phase 1: INITIALIZING
  1.1  Load config from env + config files
  1.2  Validate config (fail fast on missing required values)
  1.3  Open SQLite DB (WAL mode)
  1.4  Run pending migrations
  1.5  Initialize repository instances

Phase 2: CONNECTING
  2.1  Construct ExchangeGateway (Live or Sim based on config)
  2.2  gateway.healthCheck() -- fail if exchange unreachable or auth invalid
  2.3  Initialize rate limiter with exchange-specific limits

Phase 3: RECONCILING
  3.1  Run startup reconciliation (see section 6.1)
  3.2  If critical drift: halt and require operator intervention
  3.3  Initialize risk-inventory state from reconciled DB state

Phase 4: STREAMING
  4.1  Start market data source (REST polling or WS)
  4.2  Wait for first MarketSnapshotReceived (timeout: 30s, fail if none)
  4.3  Run normalization on initial snapshot

Phase 5: READY
  5.1  Enable strategy scanner loop
  5.2  Enable periodic reconciliation loop
  5.3  Enable execution engine (accept commands)
  5.4  Emit RuntimePhaseChanged { phase: 'READY' }
  5.5  Log "Runtime ready, accepting signals"
```

### 7.2 Shutdown Sequence

Triggered by SIGINT, SIGTERM, or operator command.

```text
Phase 1: DRAINING
  1.1  Emit RuntimePhaseChanged { phase: 'SHUTTING_DOWN' }
  1.2  Stop strategy scanner (no new signals)
  1.3  Stop market data polling

Phase 2: CANCELLING
  2.1  If config.shutdownMode === 'cancel_all':
         gateway.cancelAllOrders()
       else:
         log open orders left on exchange
  2.2  Wait for pending execution commands to complete (timeout: 10s)

Phase 3: FLUSHING
  3.1  Flush all pending event bus handlers (drain queue)
  3.2  Run final reconciliation snapshot (best-effort, timeout: 15s)

Phase 4: PERSISTING
  4.1  Persist final runtime state (positions, family state, metrics)
  4.2  Write shutdown checkpoint to DB

Phase 5: CLOSING
  5.1  Close DB connection
  5.2  Close exchange gateway connections
  5.3  Emit RuntimePhaseChanged { phase: 'STOPPED' }
  5.4  Process exit 0
```

### Supervisor state enum

```typescript
export type RuntimePhase =
  | 'INITIALIZING'
  | 'CONNECTING'
  | 'RECONCILING'
  | 'STREAMING'
  | 'READY'
  | 'SHUTTING_DOWN'
  | 'STOPPED'
  | 'ERROR';
```

---

## 8. Rate Limiter Design

### Where it sits

`packages/shared/src/rate-limiter.ts` (or inline in `apps/runtime/src/shared/rate-limiter.ts` for v1).

Consumed by:
- **Execution engine** -- before every `placeOrder` / `cancelOrder` call
- **Market data source** -- before every REST poll
- **Reconciliation** -- before every `getOpenOrders` / `getFills` / `getBalances` call

All three share one rate limiter instance scoped to the exchange API.

### Algorithm

Token bucket with per-second refill. Simple, no Redis needed for v1 single-process.

```typescript
export interface RateLimiterConfig {
  maxTokens: number;         // bucket capacity (e.g., 10)
  refillPerSecond: number;   // tokens added per second (e.g., 5)
}

export interface RateLimiter {
  /**
   * Acquire a token. Resolves when a token is available.
   * If bucket is empty, waits until refill provides one.
   * Rejects if wait would exceed maxWaitMs.
   */
  acquire(maxWaitMs?: number): Promise<void>;

  /** Current available tokens (for observability). */
  available(): number;
}
```

### Implementation sketch

```typescript
export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  let tokens = config.maxTokens;
  let lastRefill = Date.now();
  const waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  function refill() {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    tokens = Math.min(config.maxTokens, tokens + elapsed * config.refillPerSecond);
    lastRefill = now;
  }

  function tryDrain() {
    refill();
    while (waiters.length > 0 && tokens >= 1) {
      tokens -= 1;
      waiters.shift()!.resolve();
    }
  }

  const interval = setInterval(tryDrain, 200);
  // cleanup: clearInterval on process shutdown

  return {
    acquire(maxWaitMs = 5000): Promise<void> {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject };
        waiters.push(entry);
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) {
            waiters.splice(idx, 1);
            reject(new Error('Rate limiter timeout'));
          }
        }, maxWaitMs);
        const origResolve = entry.resolve;
        entry.resolve = () => { clearTimeout(timer); origResolve(); };
      });
    },
    available() {
      refill();
      return Math.floor(tokens);
    },
  };
}
```

### v1 defaults

| Consumer | Budget | Notes |
|---|---|---|
| Execution (place/cancel) | 10 tokens, 5/s refill | Polymarket CLOB is not high-frequency; conservative is fine |
| Market data polling | Same bucket | Shares the budget; polling interval naturally paces this |
| Reconciliation | Same bucket | Recon should be infrequent enough to not starve execution |

Single bucket is acceptable for v1 because there is one process and one exchange. If different endpoints get different rate limits in the future, split into per-endpoint buckets.

---

## 9. Key Runtime Contracts

Every interface below must exist for the runtime to compile and function. Grouped by package.

### @plankton/domain

```typescript
/** Core identity types */
export type FamilyId = string;          // "family_key:regime:horizon"
export type TokenId = string;           // Polymarket CLOB token ID
export type CommandId = string;         // uuid v4
export type ClientOrderId = string;     // deterministic "plk_..." hash
export type OrderId = string;           // exchange-assigned

export type Side = 'BUY' | 'SELL';
export type OrderType = 'GTC' | 'GTD' | 'FOK';

export type FamilyState = 'probe' | 'scaled' | 'reduce_only' | 'quarantine';

export interface NormalizedMarket {
  tokenId: TokenId;
  conditionId: string;
  question: string;
  familyId: FamilyId;
  familyKey: string;
  regime: string;
  horizon: string;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spread: number;
  volume24h: number;
  lastTradePrice: number;
  endDate: number;                   // unix ms
  active: boolean;
  updatedAt: number;                 // unix ms
}

export interface Signal {
  signalId: string;
  familyId: FamilyId;
  tokenId: TokenId;
  side: Side;
  suggestedPrice: number;
  suggestedSize: number;
  reason: string;                    // human-readable
  strategyTick: number;             // epoch ms of the scanner tick
}

export interface Position {
  tokenId: TokenId;
  familyId: FamilyId;
  side: Side;
  size: number;
  avgEntryPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  updatedAt: number;
}
```

### @plankton/event-bus

```typescript
/** Typed event map -- every key is an event name, value is the payload type */
export interface RuntimeEventMap {
  MarketSnapshotReceived: { markets: NormalizedMarket[]; timestamp: number };
  NormalizedMarketUpdated: { markets: NormalizedMarket[]; timestamp: number };
  SignalProduced: Signal;
  SignalApproved: Signal & { approvedAt: number };
  SignalRejected: Signal & { rejectedAt: number; reason: string };
  OrderAccepted: OrderAccepted;
  OrderRejected: OrderRejected;
  OrderCancelled: OrderCancelled;
  FillReceived: FillReceived;
  PositionUpdated: Position;
  FamilyExposureChanged: { familyId: FamilyId; totalExposure: number; state: FamilyState };
  ReconciliationDriftDetected: { details: string; severity: 'warn' | 'critical' };
  ReconciliationComplete: ReconciliationResult;
  RuntimePhaseChanged: { phase: RuntimePhase; timestamp: number };
}

/** The bus itself */
export interface EventBus {
  publish<K extends keyof RuntimeEventMap>(
    event: K,
    payload: RuntimeEventMap[K],
  ): Promise<void>;

  subscribe<K extends keyof RuntimeEventMap>(
    event: K,
    handler: (payload: RuntimeEventMap[K]) => Promise<void>,
  ): () => void;   // returns unsubscribe function

  /** Drain: wait for all in-flight handlers to complete */
  drain(timeoutMs?: number): Promise<void>;
}
```

### @plankton/exchange

```typescript
// ExchangeGateway -- see full definition in section 4 above
export { ExchangeGateway } from './exchange-gateway';
export { PlaceOrderParams, CancelOrderParams, ExchangeOrder, ExchangeFill, ExchangeBalance } from './exchange-gateway';
export { buildClientOrderId } from './client-order-id';
```

### @plankton/db

```typescript
export interface OrderRepository {
  insert(order: DbOrder): Promise<void>;
  updateStatus(orderId: OrderId, status: string): Promise<void>;
  getOpen(): Promise<DbOrder[]>;
  getByClientOrderId(clientOrderId: ClientOrderId): Promise<DbOrder | null>;
  getByFamilyId(familyId: FamilyId): Promise<DbOrder[]>;
}

export interface FillRepository {
  insert(fill: DbFill): Promise<void>;
  getLatestTimestamp(): Promise<number>;   // for reconciliation cursor
  getByOrderId(orderId: OrderId): Promise<DbFill[]>;
}

export interface PositionRepository {
  upsert(position: DbPosition): Promise<void>;
  getAll(): Promise<DbPosition[]>;
  getByFamilyId(familyId: FamilyId): Promise<DbPosition[]>;
  getByTokenId(tokenId: TokenId): Promise<DbPosition | null>;
}

export interface FamilyStateRepository {
  upsert(state: DbFamilyState): Promise<void>;
  get(familyId: FamilyId): Promise<DbFamilyState | null>;
  getAll(): Promise<DbFamilyState[]>;
}

export interface CommandLogRepository {
  insert(entry: { commandId: CommandId; clientOrderId: ClientOrderId; status: string; timestamp: number }): Promise<void>;
  getByCommandId(commandId: CommandId): Promise<{ status: string } | null>;
  getByClientOrderId(clientOrderId: ClientOrderId): Promise<{ commandId: CommandId; status: string } | null>;
}
```

### Runtime-internal contracts (apps/runtime)

```typescript
/** Execution engine -- internal module interface */
export interface ExecutionEngine {
  handlePlaceOrder(cmd: PlaceOrderCommand): Promise<void>;
  handleCancelOrder(cmd: CancelOrderCommand): Promise<void>;
  handleCancelAll(cmd: CancelAllOrdersCommand): Promise<void>;
  /** Returns count of queued (not yet dispatched) commands */
  queueDepth(): number;
}

/** Risk gate -- internal module interface */
export interface RiskGate {
  checkEligibility(signal: Signal): Promise<
    | { eligible: true }
    | { eligible: false; reason: string }
  >;
}

/** Market data source -- internal module interface */
export interface MarketDataSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Resolves when at least one snapshot has been received */
  waitForFirstSnapshot(timeoutMs: number): Promise<void>;
}

/** Reconciler -- internal module interface */
export interface Reconciler {
  runFull(): Promise<ReconciliationResult>;
}

/** Supervisor -- internal module interface */
export interface Supervisor {
  start(): Promise<void>;
  shutdown(reason: string): Promise<void>;
  phase(): RuntimePhase;
}
```

---

## Summary of Invariants

These are non-negotiable runtime invariants that all modules must respect:

1. **Execution is the sole order actor.** No other module calls the exchange gateway for order mutations.
2. **Every command has a unique `commandId`.** The execution engine deduplicates on it.
3. **Client order IDs are deterministic.** Same signal identity yields the same `clientOrderId`. Retries are safe.
4. **Strategy must not start before market data is live.** Supervisor enforces ordering.
5. **Execution must not accept commands before reconciliation completes.** Supervisor enforces ordering.
6. **Exchange state wins.** During reconciliation, if local state disagrees with the exchange, exchange is the source of truth (except for balance auto-correction, which requires operator review).
7. **Rate limiter is shared.** All exchange-facing calls go through one token bucket in v1.
8. **Shutdown cancels open orders by default.** Configurable, but the safe default is `cancel_all`.
9. **All events are async.** The event bus uses `Promise`-based handlers. No synchronous event dispatch.
10. **No module holds direct references to another module's internals.** Communication is via the event bus or via injected interface dependencies.
