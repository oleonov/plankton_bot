# Polymarket Bot — Architecture Guidelines (Asyncio)

Version: 1.0
Date: 2026-03-13

---

## Goal

Asyncio-based trading bot that is easy to extend, debug, and operate 24/7 without major refactoring.

---

## 1. State Ownership (no shared mutable state)

Every piece of state has exactly one owner. Tasks do not modify state directly — they publish events, and state managers apply them.

| State Manager        | Owns                                                  | Consumers                 |
| -------------------- | ----------------------------------------------------- | ------------------------- |
| MarketStateManager   | Market metadata, orderbook snapshots, staleness flags | SignalEngine, Scanner     |
| PositionStateManager | Open/closed positions, entry/exit prices, P&L         | RiskEngine, ExitEvaluator |
| OrderStateManager    | Open/pending/filled orders                            | Executor, Reconciliation  |

RiskEngine is read-only — it queries state managers but never modifies positions or orders.

---

## 2. Event-Driven Communication

All inter-component communication uses structured events and commands.

### Events (something happened)

```
MarketDiscovered(market_id, category, token_ids, metadata)
OrderBookUpdated(market_id, best_bid, best_ask, mid, spread, ts)
StaleData(market_id, last_update_ts, ttl_exceeded_by)
TradingSignal(signal_id, market_id, side, price, size, reason, confidence)
RiskDecision(signal_id, verdict: APPROVED|REJECTED|ADJUSTED, adjusted_size, reasons)
OrderPlaced(command_id, client_order_id, market_id, side, price, size)
OrderFilled(client_order_id, fill_price, fill_size, fee)
OrderCancelled(client_order_id, reason)
PositionOpened(position_id, market_id, side, entry_price, size)
PositionClosed(position_id, exit_price, pnl, reason)
ReconciliationMismatch(entity, local_state, exchange_state, resolution)
```

### Commands (request to do something)

```
PlaceOrderCommand(command_id, market_id, side, price, size, signal_id, order_type)
CancelOrderCommand(command_id, client_order_id, reason)
ClosePositionCommand(command_id, position_id, reason)
```

Every event and command has a unique ID for tracing.

### Event Bus

Simple `asyncio.Queue`-based event bus. Components publish events, subscribers consume them. Prevents circular imports between layers.

```
EventBus
    .publish(event)
    .subscribe(event_type, handler)
```

Future: replaceable with Redis Streams or Kafka without changing component code.

---

## 3. Executor-Only Ordering

**ExecutionEngine is the ONLY component that interacts with the exchange API for orders.**

Components emit commands:

- SignalEngine → PlaceOrderCommand
- ExitEvaluator → ClosePositionCommand
- Reconciliation → CancelOrderCommand

ExecutionEngine:

- Receives commands from event bus
- Checks idempotency (dedup by command_id)
- Applies rate limiting
- Routes to ExchangeGateway (simulation or live)
- Publishes result events (OrderPlaced, OrderFilled, OrderCancelled)

---

## 4. Risk Engine (separate validation layer)

Sits between SignalEngine and ExecutionEngine. Every TradingSignal passes through RiskEngine before becoming a PlaceOrderCommand.

### Risk checks (all configurable)

| Check                               | Config Key                           | Default |
| ----------------------------------- | ------------------------------------ | ------- |
| Max USDC per single order           | `risk.max_order_size`                | $10     |
| Max total exposure                  | `risk.max_total_exposure`            | $500    |
| Max exposure per market             | `risk.max_market_exposure`           | $50     |
| Max exposure per category           | `risk.max_category_exposure`         | $200    |
| Max open orders                     | `risk.max_open_orders`               | 100     |
| Max open positions                  | `risk.max_open_positions`            | 200     |
| Daily loss limit (stop trading)     | `risk.daily_loss_limit`              | $100    |
| Cooldown after N consecutive losses | `risk.loss_cooldown_trades`          | 10      |
| Cooldown duration                   | `risk.loss_cooldown_minutes`         | 30      |
| Min edge threshold                  | `risk.min_edge`                      | 0.02    |
| Max order size vs liquidity         | `risk.max_liquidity_fraction`        | 0.25    |
| Stale data rejection                | `risk.max_data_age_seconds`          | 60      |
| Duplicate signal prevention         | `risk.signal_dedup_window_seconds`   | 300     |
| Circuit breaker (API errors)        | `risk.circuit_breaker_errors`        | 5       |
| Circuit breaker pause               | `risk.circuit_breaker_pause_minutes` | 5       |

### Output

```
RiskDecision:
    APPROVED → command forwarded to executor
    APPROVED_WITH_ADJUSTED_SIZE → size reduced, command forwarded
    REJECTED → logged with reason, no command
```

---

## 5. Market Data Layer

### Separation of concerns

```
MarketDataFeed
    ├── fetches raw data (REST polling / future WebSocket)
    ├── validates response
    ├── normalizes to internal format
    ├── attaches timestamp + TTL
    └── publishes OrderBookUpdated / StaleData events
```

### Data staleness

Every data point carries `fetched_at` timestamp. TTL is configurable (`data.orderbook_ttl_seconds`, default 60). If data exceeds TTL → `StaleData` event → SignalEngine ignores this market until fresh data arrives. This is a property of the data itself, not a separate check task.

### Future extensibility

Swapping REST polling for WebSocket requires changing only MarketDataFeed internals. SignalEngine consumes the same `OrderBookUpdated` events regardless of source.

---

## 6. Signal Engine (strategy logic)

Consumes normalized market data. Produces TradingSignal events.

### Pluggable strategies

```python
class Strategy(Protocol):
    async def evaluate(self, market: MarketSnapshot) -> TradingSignal | None: ...
```

### Strategy implementations (based on planktonXD data)

| Strategy             | Description                                     | Priority  |
| -------------------- | ----------------------------------------------- | --------- |
| CheapContractScalper | Buy 1-20¢ contracts, sell at 20-50% rise        | Primary   |
| IntraMarketArb       | YES+NO < $1 → buy both sides                    | Secondary |
| SpreadCapture        | Post limit orders on both sides of thin markets | Secondary |
| EventFamilyTrader    | Track recurring markets (daily BTC, weather)    | Tertiary  |

Strategy selection is configurable per category.

### Market evaluation logging

Every market evaluation (including rejections) is logged to `market_evaluations` table. Rejected signals are as important as accepted ones for strategy tuning.

---

## 7. Position Lifecycle

```
EVALUATING → ENTERING → OPEN → MONITORING → EXITING → CLOSED
                                    │
                              HOLDING_TO_RESOLUTION → REDEEMED
```

Each transition = event. PositionStateManager tracks current state of every position.

### Exit conditions (based on planktonXD analysis)

| Condition                    | Config Key                    | Default               |
| ---------------------------- | ----------------------------- | --------------------- |
| Target profit %              | `exit.target_profit_pct`      | 0.30 (30%)            |
| Stop loss %                  | `exit.stop_loss_pct`          | 0.15 (15%)            |
| Max hold time (minutes)      | `exit.max_hold_minutes`       | 1440 (24h)            |
| Hold-to-resolution threshold | `exit.hold_to_resolution_pct` | 0.80 (80% confidence) |

ExitEvaluator is a separate periodic task that checks open positions against exit conditions and emits ClosePositionCommand when triggered.

---

## 8. Persistence (SQLite)

### Required tables

| Table                | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `bot_runs`           | Start/stop timestamps, config snapshot hash, mode                   |
| `config_snapshots`   | Full config YAML per bot_run (for comparing results across configs) |
| `markets`            | Discovered markets, metadata, category, token_ids                   |
| `market_evaluations` | Every evaluation: accepted AND rejected, with reasons               |
| `signals`            | Generated trading signals with confidence and reason                |
| `risk_decisions`     | APPROVED/REJECTED/ADJUSTED with reasons                             |
| `orders`             | All orders: command_id, client_order_id, status, timestamps         |
| `fills`              | Execution fills: price, size, fee                                   |
| `positions`          | Position lifecycle: state, entry/exit, P&L                          |
| `risk_events`        | Limit hits, circuit breakers, cooldowns                             |
| `reconciliation_log` | Mismatches found and resolutions applied                            |
| `metrics`            | Periodic snapshots: exposure, P&L, open positions                   |

### Restart recovery

1. Load config
2. Read local state from DB
3. Fetch exchange state (open orders, positions, balances)
4. Reconciliation: compare and fix mismatches
5. Resume from consistent state

---

## 9. Reconciliation Loop

Periodic task (every 30 seconds).

### Checks

| Check                                              | Resolution                             |
| -------------------------------------------------- | -------------------------------------- |
| Local order OPEN, exchange says FILLED             | Update local state, create fill record |
| Local order OPEN, exchange says CANCELLED          | Update local state, log reason         |
| Local order OPEN, exchange says NOT FOUND          | Mark as lost, alert                    |
| Local position OPEN, no matching exchange position | Investigate, mark as stale             |
| Exchange has order not in local state              | Cancel it (orphaned order from crash)  |
| Balance mismatch                                   | Log warning, do not auto-fix           |

---

## 10. Idempotent Commands

Every command carries a unique `command_id`. Executor maintains a dedup cache (in-memory + DB).

```
If command_id already processed → skip, return cached result
If command_id new → execute, cache result
```

`client_order_id` is derived deterministically from `signal_id` + `attempt_number` to prevent double orders on retry.

---

## 11. Task Scheduling

### Periodic tasks

| Task                 | Interval | Critical | Notes                                                                                                                                                                                                                                                                                                              |
| -------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| market_scanner       | 5 min    | Yes      | Discovers new markets via Gamma API. Cadence is empirical; ADR-017 §D2 ships discovery-latency telemetry (`MarketScannerModule.getDiscoveryLatencySnapshot`) so the value can be re-tuned against measured first-sighting delay. WSS hint via `NewMarketDiscoveredHint` accelerates the next cycle when available. |
| orderbook_feed       | 30s      | Yes      | Fetches prices for tracked markets                                                                                                                                                                                                                                                                                 |
| exit_evaluator       | 30s      | Yes      | Checks exit conditions for open positions                                                                                                                                                                                                                                                                          |
| reconciliation       | 60s      | Yes      | Syncs local state with exchange                                                                                                                                                                                                                                                                                    |
| risk_state_update    | 15s      | No       | Updates daily P&L, exposure counters                                                                                                                                                                                                                                                                               |
| metrics_flush        | 60s      | No       | Writes metrics snapshot to DB                                                                                                                                                                                                                                                                                      |
| stale_market_cleanup | 5 min    | No       | Removes resolved/expired markets from tracking                                                                                                                                                                                                                                                                     |

### Rules

- No overlapping executions (skip if previous run still active)
- Measure and log execution duration per task
- Alert if execution duration > 50% of interval

### Backpressure

Scanner may find many markets at once. Signal processing queue has a configurable max depth (`scheduler.max_signal_queue`, default 50). Excess signals are dropped with logging (oldest first).

---

## 12. Supervisor

### Responsibilities

- Start all tasks in correct order (see Startup Sequence)
- Monitor task health via heartbeats
- Restart non-critical tasks on failure
- Stop entire bot if critical task fails
- Health check: task is "productive" (scanner found markets, feed got data), not just "alive"

### Task classification

| Critical (bot stops) | Non-critical (auto-restart) |
| -------------------- | --------------------------- |
| orderbook_feed       | metrics_flush               |
| execution_engine     | stale_market_cleanup        |
| reconciliation       | risk_state_update           |

market_scanner and exit_evaluator: restart up to 3 times, then stop bot.

### Circuit breaker (bot-level)

N consecutive API errors (`risk.circuit_breaker_errors`, default 5) → pause all trading for M minutes (`risk.circuit_breaker_pause_minutes`, default 5). Data collection continues, but no new orders.

---

## 13. Startup Sequence

```
1. Load and validate config
2. Connect to DB, run migrations if needed
3. Initialize EventBus
4. Initialize state managers (load from DB)
5. Connect to exchange (health check: get_ok + get_server_time)
6. Token allowance check (live mode only)
7. Run reconciliation (sync local state with exchange)
8. Start data feeds (scanner + orderbook_feed)
9. Wait for first data cycle to complete
10. Start signal engine + exit evaluator
11. Start execution engine
12. Start non-critical tasks (metrics, cleanup)
13. Log: "Bot started in {mode} mode, tracking {N} markets, {M} open positions"
```

---

## 14. Shutdown Sequence

```
1. Receive SIGTERM/SIGINT
2. Log: "Shutdown initiated"
3. Stop scanner (no new market discovery)
4. Stop signal engine (no new signals)
5. Stop exit evaluator
6. Cancel all open orders (via executor, with timeout)
7. Wait for pending fills (max 10 seconds)
8. Persist final state to DB
9. Stop data feeds
10. Flush metrics
11. Close DB connection
12. Close exchange connection
13. Log: "Shutdown complete"
```

---

## 15. Rate Limiter

Centralized rate limiter shared by all components making API calls.

```
RateLimiter
    .acquire(endpoint_group) → waits if limit reached
```

### Endpoint groups

| Group            | Limit                                  | Shared by                |
| ---------------- | -------------------------------------- | ------------------------ |
| market_data_read | 10 req/s (initial, adjust empirically) | orderbook_feed, scanner  |
| order_write      | 5 req/s (initial)                      | executor                 |
| order_read       | 10 req/s                               | reconciliation, executor |

Limits are configurable. Actual Polymarket limits are undocumented — start conservative, increase based on 429/rate-limit responses.

---

## 16. Exchange Gateway Abstraction

```python
class ExchangeGateway(Protocol):
    async def get_markets(self, filters) -> list[Market]: ...
    async def get_orderbook(self, token_id) -> OrderBook: ...
    async def get_midpoint(self, token_id) -> float: ...
    async def place_order(self, order: OrderParams) -> OrderResult: ...
    async def cancel_order(self, order_id: str) -> bool: ...
    async def get_open_orders(self) -> list[Order]: ...
    async def get_positions(self) -> list[Position]: ...
    async def get_balance(self) -> Balance: ...
```

### Implementations

| Class                 | Mode       | Behavior                                                            |
| --------------------- | ---------- | ------------------------------------------------------------------- |
| PolymarketLiveGateway | live       | Real CLOB API via py-clob-client                                    |
| SimulationGateway     | simulation | Simulates fills based on orderbook snapshot, tracks virtual balance |
| ReplayGateway         | replay     | Replays historical data, simulates fills at historical prices       |

Strategy, RiskEngine, and all other components are mode-agnostic. Only the gateway changes.

---

## 17. Execution Modes

| Mode       | Orders            | Data               | P&L                    | Use case            |
| ---------- | ----------------- | ------------------ | ---------------------- | ------------------- |
| simulation | Virtual (DB only) | Real-time from API | Virtual, tracked in DB | Strategy validation |
| live       | Real (CLOB API)   | Real-time from API | Real                   | Production trading  |
| replay     | Virtual           | Historical from DB | Virtual                | Backtesting         |

Mode is set in config (`bot.mode`, default: `simulation`). Switching to `live` requires explicit config change + API credentials.

---

## 18. Structured Logging

JSON format. Every log entry includes:

```json
{
    "ts": "2026-03-13T12:00:00Z",
    "level": "INFO",
    "component": "signal_engine",
    "event": "signal_generated",
    "signal_id": "sig_abc123",
    "market_id": "0x...",
    "data": { ... }
}
```

### Trace chain

```
OrderBookUpdated (market_id)
  → TradingSignal (signal_id, market_id)
    → RiskDecision (signal_id)
      → PlaceOrderCommand (command_id, signal_id)
        → OrderPlaced (command_id, client_order_id)
          → OrderFilled (client_order_id)
            → PositionOpened/Closed (position_id)
```

All linked by signal_id → command_id → client_order_id → position_id.

---

## 19. Metrics

### Collected metrics (written to DB periodically)

| Metric                          | Type      |
| ------------------------------- | --------- |
| bot_uptime_seconds              | Counter   |
| tracked_markets_count           | Gauge     |
| signals_generated_total         | Counter   |
| risk_approved_total             | Counter   |
| risk_rejected_total             | Counter   |
| orders_placed_total             | Counter   |
| orders_filled_total             | Counter   |
| api_errors_total                | Counter   |
| api_retries_total               | Counter   |
| reconciliation_mismatches_total | Counter   |
| unrealized_pnl_usdc             | Gauge     |
| realized_pnl_usdc               | Gauge     |
| total_exposure_usdc             | Gauge     |
| stale_data_count                | Gauge     |
| task_execution_duration_seconds | Histogram |

---

## 20. Layered Architecture

```
Layer 1 – Ingress (data in)
    market_scanner          → discovers markets via Gamma API
    orderbook_feed          → fetches prices for tracked markets
    [future] websocket_feed → real-time orderbook stream
    [future] news_feed      → external signals

        ↓ events (MarketDiscovered, OrderBookUpdated)

Layer 2 – State (single source of truth)
    MarketStateManager
    PositionStateManager
    OrderStateManager

        ↓ state queries

Layer 3 – Decision (strategy + risk)
    SignalEngine             → evaluates markets, emits TradingSignal
    ExitEvaluator            → checks open positions, emits ClosePositionCommand
    RiskEngine               → validates signals, emits RiskDecision

        ↓ commands (PlaceOrderCommand, CancelOrderCommand)

Layer 4 – Execution (exchange interaction)
    ExecutionEngine          → places/cancels orders via ExchangeGateway
    ReconciliationEngine     → syncs local state with exchange

        ↓ events (OrderPlaced, OrderFilled, PositionClosed)

Layer 5 – Operations (observability + control)
    Supervisor               → task lifecycle management
    RateLimiter              → API call throttling
    MetricsCollector         → periodic metrics snapshots
    ConfigManager            → YAML + env config loading
    ShutdownHandler          → graceful shutdown sequence
    EventBus                 → inter-layer communication
```

---

## 21. Configuration Structure (YAML)

```yaml
bot:
  mode: simulation # simulation | live | replay
  name: plankton_bot

exchange:
  host: https://clob.polymarket.com
  chain_id: 137
  private_key: ${POLYMARKET_PRIVATE_KEY} # env override
  funder_address: ${POLYMARKET_FUNDER_ADDRESS}
  signature_type: 0

strategy:
  enabled:
    - cheap_contract_scalper
    - intra_market_arb
  categories:
    - politics
    - crypto-btc
    - sports
    - combat-sports
    - entertainment
    - price-binary
  price_range:
    min: 0.01
    max: 0.20
  min_liquidity_usdc: 50

risk:
  max_order_size: 10
  max_total_exposure: 500
  max_market_exposure: 50
  max_category_exposure: 200
  max_open_orders: 100
  max_open_positions: 200
  daily_loss_limit: 100
  loss_cooldown_trades: 10
  loss_cooldown_minutes: 30
  min_edge: 0.02
  max_liquidity_fraction: 0.25
  max_data_age_seconds: 60
  signal_dedup_window_seconds: 300
  circuit_breaker_errors: 5
  circuit_breaker_pause_minutes: 5

exit:
  target_profit_pct: 0.30
  stop_loss_pct: 0.15
  max_hold_minutes: 1440
  hold_to_resolution_pct: 0.80

scheduler:
  scanner_interval_seconds: 180
  orderbook_interval_seconds: 30
  exit_eval_interval_seconds: 30
  reconciliation_interval_seconds: 60
  metrics_interval_seconds: 60
  max_signal_queue: 50

rate_limit:
  market_data_read_per_second: 10
  order_write_per_second: 5
  order_read_per_second: 10

data:
  orderbook_ttl_seconds: 60
  db_path: plankton_bot.db

logging:
  level: INFO
  format: json
  file: logs/bot.jsonl
```

Environment variables override any config value with prefix `PLANKTON_BOT_`.

---

## 22. Development Roadmap

### v1.0 — Foundation

- Single asyncio process
- REST polling data feed
- CheapContractScalper strategy (primary)
- RiskEngine with all checks
- ExecutionEngine with simulation gateway
- SQLite persistence
- Reconciliation loop
- Structured JSON logging
- Graceful startup/shutdown
- YAML config

### v1.1 — Live Trading

- PolymarketLiveGateway (real CLOB API)
- Token allowance management
- Balance monitoring
- Enhanced error handling for API failures

### v2.0 — Enhanced Strategies

- IntraMarketArb strategy
- SpreadCapture strategy
- EventFamilyTrader strategy
- WebSocket market feed (replace polling)
- Replay mode for backtesting

### v3.0 — Scale

- Multi-process if needed (CPU-bound analysis)
- Redis for event bus (if multi-process)
- External data feeds (news, sentiment)
- Dashboard / monitoring UI

---

## 23. Anti-Patterns to Avoid

| Anti-Pattern                       | Why                                      | Instead                                    |
| ---------------------------------- | ---------------------------------------- | ------------------------------------------ |
| Strategy calling exchange API      | Breaks audit trail, bypasses risk        | Emit TradingSignal → RiskEngine → Executor |
| Monitor closing positions directly | Bypasses risk checks                     | Emit ClosePositionCommand                  |
| Global mutable state               | Race conditions in async                 | State managers with event-driven updates   |
| Risk logic spread across code      | Impossible to audit                      | Centralized RiskEngine                     |
| Missing reconciliation             | Drift between local and exchange state   | Periodic reconciliation loop               |
| Missing persistence                | State lost on restart                    | SQLite for all state                       |
| Retries without idempotency        | Double orders                            | command_id + dedup cache                   |
| Blocking I/O in async tasks        | Blocks entire event loop                 | Use aiohttp, aiosqlite, asyncio.to_thread  |
| Mixing paper and live logic        | Bugs, accidental real trades             | ExchangeGateway abstraction                |
| Starting strategy before data      | Trades on empty state                    | Startup sequence enforces order            |
| sleep() loops                      | Inaccurate timing, no overlap protection | Proper async scheduler                     |
| Hardcoded limits                   | Can't tune without code change           | Everything in YAML config                  |
