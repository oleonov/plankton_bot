# ADR-036: Phase E.3 Data-API Async Path + V4 Selection Algorithm

Date: 2026-05-20

## Status

Proposed. This ADR documents the implementation artifact for reviewer approval.
No commit, push, or deploy has been performed for this change set.

## Context

Phase E.2 deployed the worker-pool decision planner, but live monitoring still
showed main-thread saturation:

- `decision_tick_latency_p95_ms` remained hundreds of seconds.
- CPU stayed pinned near 98-100%.
- Event-loop lag continued to starve WebSocket heartbeat handling.
- The live diagnostic identified the bottleneck outside worker evaluation:
  market-wide continuation Data API prefetch, repeated policy reads, and repeated
  full universe selection scans.

At the same time, the Plankton selection analysis validated V4 as the next
selection algorithm:

- Source report: `research_plankton/plankton_selection_algorithm_2026-05-20.md`
- Reviewer reports:
  `research_plankton/plankton_selection_algorithm_reviewer_2026-05-20.md`,
  `research_plankton/plankton_selection_algorithm_reviewer_v2_2026-05-20.md`
- V4 holdout result: 83.07% new-holdout recall at 20.68% admit rate.

## Decision

### 1. Continuation Data API Decoupling

Replace awaited market-wide continuation prefetch in the decision tick with a
bounded in-memory background cache:

- `ContinuationTradeCountCache` schedules trade-count refreshes without waiting
  on the decision hot path.
- Decision planning reads the cache synchronously.
- Cache miss degrades to `leg_local_fallback` for that tick and schedules a
  background refresh.
- The cache keeps provider `prefetch()` compatibility for existing Data API
  providers and tests, but decision evaluation no longer awaits market-wide
  network I/O.

### 2. Batch Policy Reads

Read execution policy once per decision batch and pass the snapshot through
planning and side-effect application. Market selection cache also reads
`marketSelectionPolicy` once per `NormalizedMarketUpdated` payload, not once per
market.

### 3. Tiered Universe Scan Cache

Cache `findTrackedForPricingTiered()` results in `MarketDataModule` for 60s by
default. This removes repeated full active/tradable universe scans and JS sorts
from every pricing poll. Tests can set `tieredPricingCacheTtlMs=0` when they
need immediate dynamic repository behavior.

### 4. V4 Selection Predicate

Add executable V4 predicate:

```ts
category in HOT_CATS_40 &&
  (liquidity == null || liquidity >= 100) &&
  (volume24h == null || volume24h >= 5);
```

`HOT_CATS_40` is the 12-category list from the V4 validation:

```text
crypto-btc, crypto-eth, crypto-sol, crypto-xrp,
entertainment, esports, geopolitics, other,
politics, price-binary, stocks, weather
```

Runtime implementation notes:

- The V4 predicate lives in `packages/domain/src/v4-selection.ts`.
- Repository tiering joins the latest `market_snapshots` row to read
  `liquidity` and `volume_24h`.
- V4-admitted candidates enter the WS priority pool and are ranked by the
  existing R30 score tiers plus tick/horizon/category tie-breakers.
- V4-rejected candidates remain in `discoveryOnly`; execution-critical markets
  are never removed by V4.
- Runtime slug-derived category is a best-effort proxy because production DB
  does not persist Plankton taxonomy `primary_category`.

### 5. V4 Admission Telemetry

Add production visibility for the runtime V4 predicate before deploy:

- `v4_admit_count_total`
- `v4_admit_count_by_category`
- `v4_reject_count_total`
- `v4_reject_count_by_reason`
- `v4_admit_rate`
- `v4_seen_count_by_category`
- `v4_admit_rate_by_category`
- `v4_evaluated_total`

The counters are captured from the latest tiered-pricing universe scan and
flushed through the existing `market_data_stream_activity` runtime metric. The
operator API exposes them via `GET /api/v1/metrics/coverage`, and the dashboard
renders V4 admit rate plus top reject reasons in the Market Coverage card.

Expected first-day range: `v4_admit_rate` in `[10%, 30%]`. If the rate is
outside that band, pause interpretation of V4 production quality and inspect
the per-category and per-reject-reason breakdown. A dominant
`rejected_category_not_in_hot_cats` count indicates slug-derived category
coverage is too restrictive versus the research taxonomy. Dominant
`rejected_liquidity_below_100` or `rejected_volume_below_5` indicates the
runtime liquidity/volume gates are the binding constraint.

Rollback: telemetry is add-only and does not affect selection behavior.

## Deferred

- H9 recent-winner feedback boost: deferred. Runtime has no Plankton activity
  stream in this deploy surface.
- H14 young-market boost: deferred. V4 already outperformed random strongly;
  add this only after V4 production telemetry is available.
- Native/shared-memory worker IPC optimization: deferred from E.2 reviewer as
  non-blocking.

## Expected Metrics

The change targets main-thread load, not worker evaluation:

- Continuation trade-count network wait should disappear from decision tick
  timing.
- Universe scan/sort should run at most once per TTL instead of every poll.
- R23 reachability should remain intact.
- WS reconnect pressure should reduce if event-loop lag drops.

Targets remain:

- `decision_tick_p95 < 5s`
- `event_loop_lag_p95 < 200ms`
- CPU `<70% sustained`
- WS reconnects `<5/hour`

These targets require production validation after deploy.

## Rollback

Primary rollback is git revert of the E.3/V4 commit.

Operational mitigations if deployed:

- Set `tieredPricingCacheTtlMs=0` in tests or future config to bypass tiered
  cache behavior.
- Set `ALGO_DECISION_WORKER_COUNT=0` remains available from ADR-035, but it does
  not address the E.3 main-thread bottleneck.
- Restore pre-V4 repository ranking by reverting the V4 predicate change.

Auto-rollback remains disabled per Phase A direction; alerts are visibility
only unless a human explicitly chooses rollback.
