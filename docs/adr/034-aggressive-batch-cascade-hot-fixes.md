# ADR-034: Aggressive Batch Cascade Hot Fixes

Date: 2026-05-19

Status: Proposed

## Context

ADR-033 increased the real-time tracking surface to 5000 tokens and enabled
R23 dip-trigger entry. Phase A deployment showed the capacity gain, but Phase B
diagnostic found a cascading failure mode:

```text
WS gaps -> large REST fallback poll set -> Gamma/Data API fan-out ->
stale or feature-poor snapshots -> admission rejection -> empty
selectedMarketCache -> R23 not reached -> zero signals
```

The independent Phase B reviewer accepted the diagnosis with concerns:

- R23 reachability is a verification metric, not a separate fix target.
- Event-loop starvation can amplify WS gaps, so the system needs explicit
  event-loop and GC diagnostics.
- Data API public-trade-count enrichment is the dominant fan-out multiplier and
  must be scoped, not just observed.
- Admission telemetry needs reason-level breakdown so stale/missing-feature
  rejection does not collapse into a generic selection rejection counter.

Evidence trail:

- `research_plankton/aggressive_phase_b_diagnostic_2026-05-19.md`
- `research_plankton/aggressive_phase_b_diagnostic_reviewer_2026-05-19.md`
- `research_plankton/aggressive_redeploy_phase_a_2026-05-19.md`
- `research_plankton/aggressive_redeploy_phase_a_reviewer_2026-05-19.md`
- ADR-033: `docs/adr/033-aggressive-plankton-alignment-batch.md`

## Decision

Keep ADR-033 behavior intact and add protective bounds around the recovery path
that caused the cascade.

1. Bound REST fallback polling after WS gaps.
2. Restrict public-trade-count enrichment to tokens where D9 or entry admission
   can use the field.
3. Add runtime diagnostics for event-loop lag, GC pause, HTTP error classes, and
   per-shard WS gaps.
4. Add admission rejection reason counters.
5. Do not change R23 predicate or evaluation order. `r23DipChecked > 0` is a
   post-deploy verification signal that admission recovered.

## Configuration

New runtime environment parameters:

```text
MARKET_DATA_FALLBACK_POLL_CONCURRENCY=50
MARKET_DATA_FALLBACK_POLL_RATE_PER_SEC=5
MARKET_DATA_STALE_TOKEN_AGE_MS=30000
```

Effective fallback batch size is:

```text
min(
  MARKET_DATA_FALLBACK_BATCH_SIZE,
  MARKET_DATA_FALLBACK_POLL_CONCURRENCY,
  MARKET_DATA_FALLBACK_POLL_RATE_PER_SEC * poll_interval_seconds
)
```

With the current 5-second poll interval, the default token budget is 25 fallback
tokens per poll. If the interval is 60 seconds, the concurrency cap becomes the
limiting factor at 50 tokens.

## Implementation

Fallback polling:

- `MarketDataModule` tracks gap tokens with first-seen timestamps instead of a
  plain set.
- Poll candidates are sorted by role: execution critical first, then entry
  candidates, legacy, and unassigned. Open positions and open orders get fresh
  prices first under congestion to preserve D8/D9 correctness.
- Candidates beyond the bounded token budget are deferred.
- Gap tokens older than `MARKET_DATA_STALE_TOKEN_AGE_MS` are dropped from the
  gap queue instead of being endlessly retried as gap recovery work.

Public trade count enrichment:

- Production wiring enriches only execution-critical tokens and tokens currently
  admitted by `MarketSelectionCache`.
- The enrichment worker remains bounded by existing concurrency, and the module
  now reports eligible/skipped/condition/request counts.
- Data API enrichment errors are classified and recorded, but they do not fail
  the whole market-data poll.

Diagnostics:

- Runtime diagnostics metric `runtime_diagnostics` records event-loop lag,
  GC pause latency, and memory in MiB.
- HTTP error class counter `http_error_class` records `{source,errorClass}` for
  Gamma pricing, Gamma discovery, Data API public trade count, and trade-count
  observer fetches.
- Market stream metrics include `wsGapsByShard`.
- `/api/v1/metrics/coverage` exposes event-loop, GC, and HTTP error summaries.

Admission telemetry:

- `MarketSelectionCache` exposes `selectionRejectReasons`.
- Reasons include `rejected_no_midprice`, `rejected_stale_snapshot`,
  `rejected_missing_feature_liquidity`, `rejected_mid_price_too_high`,
  `rejected_liquidity_too_low`, `rejected_strike_short_horizon`,
  `rejected_zero_coverage_category`, and `rejected_other`.

## Expected Metrics

After deployment, success means:

- `pendingGapTokenCount < 100` in steady state.
- `fallbackPollCount` stays bounded by the configured rate cap.
- `publicTradeCountEnrichmentRequestCount` tracks entry/open scope, not all
  5000 tracked tokens.
- `selectionRuleAdmitted > 0`.
- `r23DipChecked > 0`.
- `decision_tick_latency_p95 < 30s`.
- HTTP errors are visible by class rather than only as generic timeout logs.

## Rollback

Config-only mitigation:

```text
MARKET_DATA_FALLBACK_POLL_CONCURRENCY=10
MARKET_DATA_FALLBACK_POLL_RATE_PER_SEC=1
MARKET_DATA_STALE_TOKEN_AGE_MS=10000
```

If behavior still degrades, revert the Phase C commit and redeploy. ADR-033
capacity can also be reverted independently:

```text
MARKET_DATA_MAX_TRACKED_TOKENS=1000
MARKET_DATA_MAX_WS_SHARDS=2
MARKET_DATA_DISCOVERY_BATCH_SIZE=50
```

R23 itself is unchanged by this ADR. If R23 needs disabling, use the ADR-033
`r23DipTrigger.enabled=false` config rollback.

## Consequences

The system may recover more slowly from a whole-shard gap because fallback
polling is intentionally rate-limited. That is an explicit trade-off: bounded
recovery is preferred to saturating the event loop and starving admission for
all tokens.

This change increases observability but does not claim to solve Polymarket WS
disconnects. It prevents the fallback and enrichment recovery paths from
turning a WS disturbance into a process-wide REST/API cascade.
