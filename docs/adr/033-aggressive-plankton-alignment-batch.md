# ADR-033: Aggressive Plankton-Alignment Batch

Date: 2026-05-18

Status: Proposed

## Context

Krabs traded 87 markets in the 2026-05-11 to 2026-05-18 window while the
Plankton comparison set traded approximately 2,450 markets. The universe
waterfall attributes most of the gap to real-time tracking capacity: roughly
946 entry-candidate WebSocket slots versus 21,348 active/tradable candidates,
with the remaining markets rotating through REST discovery at 50 tokens per
5 minutes. The characterization of missed Plankton winners estimates 1,720
weekly winner markets not reached by Krabs, with approximately $6,630 of
missed PnL in the comparison exercise.

Separately, Krabs entries in the same week were dominated by the static
FALLBACK BUY rule rather than an explicit entry signal. The R23 entry-signal
analysis identifies a price-dip trigger as the historical Plankton-like first
BUY signal: current midpoint at or below 68.3% of the recent peak, equivalent
to a 31.7% dip.

Evidence trail:

- `research_plankton/plankton_vs_krabs_87_tokens_2026-05-18.md`
- `research_plankton/plankton_missed_winners_characterization_2026-05-18.md`
- `research_plankton/crabs_universe_waterfall_2026-05-18.md`
- `research_plankton/crabs_ws_capacity_audit_2026-05-18.md`
- `research_plankton/plankton_entry_signal_analysis_2026-05-18.md`
- `research_plankton/plankton_strategy_gaps_unified_2026-05-17.md`

## Decision

Deploy one coordinated batch that changes the entry surface and capacity
surface together:

1. Raise the runtime container memory limit from 640 MiB to 2 GiB.
2. Raise `MARKET_DATA_MAX_TRACKED_TOKENS` from 1000 to 5000.
3. Raise `MARKET_DATA_MAX_WS_SHARDS` to 10, preserving the existing
   500-subscriptions-per-shard target.
4. Raise discovery rotation from 50 to 500 tokens per 5 minutes via
   `MARKET_DATA_DISCOVERY_BATCH_SIZE=500`.
5. Neutralize `FALLBACK` from BUY to HOLD while preserving the required
   startup fallback row.
6. Add `R23_DIP_TRIGGER`, evaluated before static decision rules and before
   the now-neutral FALLBACK row.

R23 predicate:

```text
state == OTHER
AND max_midpoint_last_24h is available
AND current_midpoint / max_midpoint_last_24h <= 0.683
AND market has already passed pre-entry selection filters
```

When R23 fires it emits a BUY signal with `decision_rule_id='R23_DIP_TRIGGER'`.
When it does not fire, unmatched first-entry candidates fall through to
FALLBACK HOLD instead of default-buying.

The 0.683 value is the R23 dip ratio, equal to `1 - 0.317`. The 24-hour
window comes from the same R23 first-BUY entry-signal measurement. The R23
sample referenced in the evidence was calibrated on 1,000 historical first
BUYs; this ADR keeps that value explicit in config as `r23DipTrigger`.

## Implementation

Runtime configuration:

- `docker-compose.yml`: `mem_limit: 2g`
- `docker-compose.yml`: `NODE_OPTIONS=--max-old-space-size=1536`
- `docker-compose.yml`: `MARKET_DATA_MAX_TRACKED_TOKENS=5000`
- `docker-compose.yml`: `MARKET_DATA_MAX_WS_SHARDS=10`
- `docker-compose.yml`: `MARKET_DATA_DISCOVERY_BATCH_SIZE=500`

Control migration:

- `packages/db/src/migrations-control/059_aggressive_alignment_r23_fallback_hold.sql`
  updates `algo_decision_rules` so `FALLBACK` action becomes `HOLD`.
- The same migration stores explicit live-lite `r23DipTrigger` defaults and
  bumps `execution_policy_version` if it had to add the key.

Code:

- `packages/domain/src/r23-dip-trigger.ts`
- `packages/domain/src/execution-policy.ts`
- `apps/runtime/src/modules/algo-decision/market-snapshot-price-history.ts`
- `apps/runtime/src/modules/algo-decision/algo-decision-module.ts`

## Trade-Offs

The memory increase intentionally accepts the risk of discovering production
bottlenecks under real load. If memory overflows, the rollback path is to
restore the cgroup limit and tracking cap together.

Neutralizing FALLBACK means Krabs may open fewer new positions if R23 is too
selective or if price-history coverage is insufficient. That is intentional:
default-buy entries are the behavior being removed. Existing positions and
exit management continue to flow through D1-D9, continuation, preserved-only,
and SELL-specific gates.

This reverses the ADR-022 deferral of dip/reaction entry triggers. ADR-022
kept dip telemetry for later analysis; ADR-033 promotes the R23 signal into a
live entry rule.

## Monitoring

First four hours after deployment:

- Runtime RSS and cgroup memory utilization.
- CPU utilization.
- WebSocket shard count and per-shard health.
- WebSocket event throughput and reconnect count.
- Queue overflow or backpressure logs.
- Decision tick latency: `algo_decision_latency` in `runtime_metrics` stores
  p50/p95/p99/max over the latest 100 completed decision passes. The same
  values are embedded in `algo_decision_eval_counters.decisionTickLatency`.
- Signal emission rate by rule: especially `R23_DIP_TRIGGER`, D1-D9,
  and FALLBACK.
- R23 skip reason distribution: `r23-no-history`, `r23-no-dip`,
  `r23-existing-position`.
- R23 cache activity: `r23_cache_activity` in `runtime_metrics` stores
  `invocations`, `hits`, `misses`, and `hitRate` for
  `maxMidpointInWindow`. The operator API exposes this through
  `GET /api/v1/metrics/r23`.
- Order placement, fill, cancel, and rejection rates.
- New positions opened per minute.
- Error log rate.

Operator dashboard:

- Market Coverage card reads `GET /api/v1/metrics/coverage` and displays WS
  tracked count, active/tradable universe count, coverage percent, shard count,
  event rate, rotation cycle, positions opened in 24h, decision tick p95/p99,
  and R23 cache hit rate.
- R23 Dip Trigger card reads `GET /api/v1/metrics/r23` every 10 seconds and
  displays latest-tick checks/fires/skips, R23 cache hit rate, attributed
  orders/fills in 24h, and decision latency p95.

Paging / alerting:

- `DECISION_TICK_LATENCY_P95_HIGH` is emitted to the existing `infra_alert`
  channel when `decision_tick_latency_p95 > 30s` is sustained for 5 minutes.
  The channel is surfaced in `/api/v1/status` and the web alert strip. Alert
  cooldown is 15 minutes.
- There is no separate Slack/PagerDuty connector in Krabs as of this ADR.
  The production action is the existing operator-visible infra-alert plus
  container/log monitoring. A future external pager integration can consume
  the same `infra_alert` row without changing decision code.

Rollback triggers:

- OOM kill or container restart loop: at least 2 restarts in 15 minutes.
- More than 5 WebSocket reconnects in the first hour.
- Memory above 90% of 2 GiB for 5 sustained minutes.
- Decision tick latency above 30 seconds sustained.
- Critical runtime errors in market-data, normalization, algo-decision, or
  execution modules.

## Rollback

FALLBACK back to BUY:

```sql
UPDATE algo_decision_rules
   SET action = 'BUY'
 WHERE rule_id = 'FALLBACK'
   AND priority = 999;
```

R23 config disable:

```sql
UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.r23DipTrigger.enabled',
         json('false')
       ),
       updated_at = datetime('now')
 WHERE profile_id = 'live-lite';

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1;
```

Capacity revert:

- Unset or reduce `MARKET_DATA_MAX_TRACKED_TOKENS` back to 1000.
- Unset or reduce `MARKET_DATA_MAX_WS_SHARDS` back to 2.
- Restore `MARKET_DATA_DISCOVERY_BATCH_SIZE=50`.
- Restore `mem_limit: 640m` and `NODE_OPTIONS=--max-old-space-size=448`.
- Restart the runtime container.

Estimated rollback time for all five changes is 5 to 10 minutes.

## Known Limitations

R23 depends on `market_snapshots` coverage for a 24-hour peak. New markets or
markets without recent snapshots return `r23-no-history` and do not enter.

R23 is category-neutral in this batch. Category-conditional entry and sizing
remain separate work.

The R23 threshold is historical evidence, not a guarantee that production
capacity or execution will match Plankton immediately.
