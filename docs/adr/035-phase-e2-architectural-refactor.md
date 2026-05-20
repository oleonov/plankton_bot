# ADR-035: Phase E.2 Architectural Refactor

Date: 2026-05-19

Status: proposed

## Context

Phase E.1 diagnosed that the aggressive 5,000-token configuration exposed a hot-path architecture
problem rather than a simple memory limit:

- decision tick p95 degraded to roughly 233s
- runtime CPU pinned near 96%
- event-loop lag reached multi-second windows
- WS heartbeats starved and triggered reconnect / gap cascades
- R23 reachability recovered only after Phase C reduced fallback fanout, but decision latency stayed
  far above the target needed for Plankton-scale behavior

The root cause is synchronous fanout on one Node event loop. WS ingestion, market-data publication,
normalization, selection, scoring, risk inventory, decision evaluation, and SQLite telemetry shared
the same runtime thread.

## Decision

This diff implements the second architecture cut. It keeps the prior Phase E.2 changes and closes
the critical missing architecture boundary: decision evaluation is now split into a serializable
pure planner plus a main-thread applier. The planner can run in a worker pool without accessing
SQLite, the event bus, pending-order maps, or mutable runtime caches.

Implemented:

1. Market-data publications are delta-shaped. REST and WS paths publish changed/polled market
   snapshots, not the entire 5,000-token cache.
2. Cached/degraded market-data recovery updates the local cache but does not fan out all tracked
   tokens downstream.
3. Algo decision uses a dirty-token scheduler. Market/execution/leg-state events mark tokens dirty,
   and a periodic full sweep marks only cached open-position tokens plus selected entry candidates.
4. Decision state reads are cached:
   - leg-state cache hydrates once at startup from `leg_states`
   - position cache hydrates once at startup from open positions
   - `LegStateUpdated` / `LegStateCleared` bus events keep the cache coherent after fills,
     settlements, and zero-size position updates
   - normal full sweeps no longer call `legStateRepo.getAll()`
   - after hydration, entry-candidate cache misses are treated as "no leg" instead of calling
     `legStateRepo.get()` per token
5. Decision telemetry persistence supports a dedicated SQLite worker thread. Production wiring uses
   `decisionPersistenceMode: "worker"` with the ledger DB path, so `decision_signal_log` and
   `risk_events` inserts are queued off the decision caller stack.
6. R23/history reads are maintained from in-memory observed market samples in production. Production
   wires `MarketSnapshotPriceHistoryProvider({ syncMissLookup: false })`, so a cold 24h-history
   miss returns `null` instead of scanning `market_snapshots` synchronously on the decision path.
7. REST fallback now applies the same null-pricing gate as the WS path. Missing pricing does not
   overwrite the last usable market state.
8. WS subscription priority is changed to a Plankton-aligned composite:
   - fresh R30 score tiers dominate
   - tick/horizon/category are tie-breaks
   - operator `selection_status` is now below R30-tier priority for entry candidates
   - execution-critical markets still outrank all entry candidates
9. Category bias was reduced to tie-break scale. The supporting research says category lift is weak
   (`~0.0011` AUC); the bias must not overpower meaningful R30 score differences.
10. Decision evaluation now has a pure `DecisionPlan` boundary:
    - planner input is a serializable snapshot of market, leg, position, rules, policy, cached
      continuation facts, R23 history, and drop-trigger history
    - planner output is a signal draft, suppression plans, side-effect requests, and metrics deltas
    - main thread applies side effects in token order: dust transitions, suppression telemetry,
      wallet-budget checks, pending BUY reservation, decision telemetry, and `SignalProduced`
11. Decision planning is dispatched through a worker pool:
    - production uses `ALGO_DECISION_WORKER_COUNT` (default `CPU_COUNT - 1`)
    - `ALGO_DECISION_WORKER_BATCH_SIZE` controls IPC batch size
    - worker failures degrade to local planning for the affected batch instead of dropping signals
    - result ordering is preserved before main-thread side effects are applied

## R30 Override Behavior

Entry-candidate ordering now intentionally lets R30 score tier outrank the legacy
`selection_status` rank. This is a behavioral change:

```text
executionCritical
  > R30 high-confidence entry candidates
  > R30 active-pool entry candidates
  > other entry candidates by tie-breaks
  > legacy selection_status rank
```

Rationale: `selection_status` is an operator/admission artifact, not a Plankton-priority signal.
The Phase E objective is to use the 5,000 real-time slots for Plankton-like priorities.

## Leg-State Cache Audit

Known leg-state writers:

- `LegStateTrackerModule` via `FillReceived`
- `LegStateTrackerModule` via zero-size `PositionUpdated`
- `LegStateTrackerModule` via `PositionSettled`
- startup adoption / seeding before runtime module start
- `AlgoDecisionModule` dust-abandonment counters (`incrementSellResidualReject`)
- API abandoned-dust reset endpoint
- reconciliation reprice-chain metadata

Cache coherence implemented here covers the runtime-critical fill/position/settlement paths via
`LegStateUpdated` and `LegStateCleared`. Startup seeding is covered by startup hydration. The
remaining direct mutation paths either happen inside `AlgoDecisionModule` itself or are operator /
maintenance paths; they are documented residual risks for a later repository-level write-through
cache abstraction.

## Before

```text
WS / REST poll
  -> MarketSnapshotReceived [often full 5,000-token batch]
    -> Normalization copies full batch
      -> MarketSelectionCache loops full batch
      -> SoftRanking loops full batch
      -> RiskInventory loops full batch
      -> Execution cache loops full batch
      -> AlgoDecision evaluates full batch
         -> sync SQLite reads/writes inside event loop
```

## After This Diff

```text
WS / REST poll
  -> changed-token MarketSnapshotReceived delta
    -> Normalization copies changed tokens only
      -> Subscribers process changed tokens only
      -> AlgoDecision observes price sample + marks token dirty

Decision scheduler
  -> evaluate dirty tokens after short debounce
  -> periodic full sweep marks cached open legs + selected entry candidates
  -> R23 history served from in-memory samples
  -> build serializable decision snapshots
  -> worker pool evaluates pure decision plans
  -> main thread applies ordered side effects
  -> decision telemetry queued to SQLite worker
```

## Worker Boundary

The planner is intentionally pure. It cannot:

- publish on the event bus
- call repositories
- reserve pending orders
- generate IDs
- mutate dust counters
- write decision telemetry

It can:

- evaluate D8/D9/R23/static decision predicates
- evaluate sizing
- produce suppression plans
- produce signal drafts
- request bounded side effects such as `sell_residual_reject` or `dust_recovered`
- return metrics deltas

This is the architectural guardrail that lets the runtime parallelize CPU-heavy decision math while
keeping correctness-sensitive effects single-threaded and ordered.

## Configuration / Runtime Surface

Production wiring enables:

- `AlgoDecisionModule.decisionPersistenceMode: "worker"`
- `AlgoDecisionModule.decisionPersistenceWorkerDbPath: <ledgerDbPath>`
- `AlgoDecisionModule.decisionWorkerCount: config.algoDecisionWorkerCount`
- `AlgoDecisionModule.decisionWorkerBatchSize: config.algoDecisionWorkerBatchSize`
- `AlgoDecisionModule.deferMarketUpdateEvaluation: true`
- `MarketSnapshotPriceHistoryProvider.syncMissLookup: false`

New env vars:

- `ALGO_DECISION_WORKER_COUNT` (default `max(1, CPU_COUNT - 1)`, `0` disables workers)
- `ALGO_DECISION_WORKER_BATCH_SIZE` (default `100`)

No schema migration is introduced.

## Expected Metrics

After this cut:

- market-data batch size should track changed tokens, not 5,000-token cache size
- full sweep should no longer do `leg_states` table scans
- telemetry inserts should not block the decision caller stack
- decision math should move off the main event loop for worker-enabled production runtime
- R23 cold history misses should not scan `market_snapshots` in production
- REST null-pricing responses should not poison the market cache

Full parity targets remain:

- decision_tick_p95 < 5s
- event_loop_lag_p95 < 200ms
- CPU < 70% sustained
- WS reconnects < 5/hour

This diff addresses the decision-evaluation side of the CPU bottleneck. Dedicated WS shard workers
remain a separate larger isolation step if reconnects continue after the main event loop no longer
spends most of its time evaluating rules.

## Rollback

Rollback is a code revert. There is no data migration to undo.

If production degrades:

1. Revert this commit.
2. Redeploy the prior Phase D commit.
3. Keep existing human-watcher alert mode; do not reintroduce metric-triggered auto-rollback.

Queued decision telemetry is best-effort. On graceful shutdown the buffer drains to the worker. If
the process is hard-killed, queued telemetry can be lost, but trading state remains derived from
orders, fills, positions, leg states, and market data.

## Follow-Ups Required

1. Move WS shard processing into an isolated worker/context with bounded immutable messages if
   post-deploy telemetry shows keepalive starvation persists.
2. Replace remaining direct leg-state mutation paths with repository-level cache invalidation.
3. Persist Tier-1/recent-activity priority features in Krabs runtime state instead of relying on
   slug/category tie-breaks alone.
