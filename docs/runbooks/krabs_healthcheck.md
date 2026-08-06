# Krabs Production Healthcheck Runbook

This document is the checklist an agent should follow when the operator asks:

> "Пройди healthcheck и дай отчет."

It is intentionally operational and read-only. It covers host resources, Docker,
API health, SQLite, runtime metrics, trading activity, orders, fills, positions,
Track C/G/H/I/J/K/L safety, external data flow, and logs.

Last validated against production on `2026-06-05T04:12Z`.

Current production discovery:

- Deploy script: `deploy.sh`
- Server: `root@your.server.ip`
- App path: `/opt/krabs`
- Public API: `https://bot.example.com`
- Local API on server: `http://127.0.0.1:3100`
- Ledger DB: `/var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db`
- Control DB: `/var/lib/docker/volumes/krabs-data/_data/control.db`
- Containers:
  - `krabs-krabs-runtime-1`
  - `krabs-krabs-api-1`
  - `krabs-krabs-runtime-manager-1`
  - `krabs-docker-socket-proxy-1`

## Rules For Agents

Do:

- Use read-only commands unless the operator explicitly authorizes action.
- Use `sqlite3 -readonly` for production DB queries.
- Use GET-only API calls.
- Never print `KRABS_API_KEY`, private keys, or `.env.production` contents.
- Include exact numbers and timestamps in the final report.
- Call out unavailable metrics explicitly instead of guessing.
- If a RED condition appears, alert the operator. Do not rollback/restart unless
  explicitly authorized.

Do not:

- Run `./deploy.sh`.
- Restart containers.
- Write to SQLite.
- Run `VACUUM`, `PRAGMA wal_checkpoint`, migrations, deletes, updates, inserts.
- Commit, push, or change configs.
- Query Polymarket from localhost; if external API verification is needed, run it
  through the production server.

## Severity Model

Use these status labels in reports:

- `GREEN`: expected / healthy.
- `WAITING`: no activity yet, but acceptable for the time window.
- `WARN`: degraded or suspicious, monitor or investigate.
- `RED`: likely production issue; operator decision needed.
- `CRITICAL`: safety/capital/process risk; immediate operator alert.

General thresholds are intentionally conservative:

| Area                            | WARN                   | RED / CRITICAL                                      |
| ------------------------------- | ---------------------- | --------------------------------------------------- |
| Any container down              | n/a                    | RED                                                 |
| Runtime restart count           | `>0`                   | RED if increasing                                   |
| OOMKilled                       | n/a                    | CRITICAL                                            |
| Disk `/`                        | `>80%`                 | RED `>90%`                                          |
| Ledger DB footprint             | `>20GB`                | RED `>30GB`                                         |
| Runtime memory                  | `>80%` container limit | RED `>90%` or rising fast                           |
| Runtime CPU                     | `>80%` sustained 10m   | RED `>95%` sustained                                |
| API health                      | n/a                    | RED if not `ok`                                     |
| `paused`                        | WARN if unexpected     | RED if bot should trade                             |
| `marketDataStale`               | WARN once              | RED if persists 5m                                  |
| Reconciliation lag p99          | WARN `>5s`             | RED `>30s`                                          |
| `publishExchangeState` p99      | WARN `>100ms`          | RED `>200ms`; CRITICAL near seconds/minutes         |
| Event loop lag p95              | WARN `>200ms`          | RED `>1500ms`                                       |
| WS full-book skipped            | WARN `>0`              | RED if growing                                      |
| WS gaps                         | WARN if burst          | RED if continuous                                   |
| Track C pipeline failures       | WARN `>0` after deploy | RED if increasing                                   |
| `floor_intents active`          | n/a                    | CRITICAL if `>0` in Phase 1                         |
| Queue overflow                  | WARN if historical     | RED if current/increasing                           |
| `db_size_guard_triggered_total` | n/a                    | CRITICAL; bot auto-pauses and needs operator action |
| Live-lite envelope usage        | WARN `>80%` cap        | RED `>95%` cap or cap breach                        |
| Exchange balance rejects        | WARN `>0`              | RED if increasing or blocking orders                |
| Same-price reprice loops        | WARN `>=3` in 24h      | RED if repeated on multiple tokens                  |
| Open order age                  | WARN `>2h`             | RED `>6h` unless intentionally GTC                  |

## Quick 5-Minute Triage

Run this first when the operator asks for a fast answer.

```bash
ssh root@your.server.ip '
set -e
echo "== time =="; date -u +%Y-%m-%dT%H:%M:%SZ
echo "== host =="; hostname; uptime
echo "== memory =="; free -m
echo "== disk =="; df -h / /opt/krabs /var/lib/docker/volumes/krabs-data/_data 2>/dev/null || df -h
echo "== containers =="; docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
echo "== docker stats =="; docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}"
echo "== health =="; curl -sS http://127.0.0.1:3100/api/v1/health; echo
'
```

Then fetch the main application snapshots:

```bash
ssh root@your.server.ip '
set -e
API_KEY=$(grep "^KRABS_API_KEY=" /opt/krabs/.env.production | cut -d= -f2-)
for path in \
  /api/v1/status \
  /api/v1/dashboard/kpi \
  /api/v1/metrics \
  /api/v1/metrics/coverage \
  /api/v1/hold-resolution?status=active
do
  echo "== $path =="
  curl -sS -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:3100$path" \
    | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin), indent=2)[:8000])"
done
'
```

Fast report should include:

- deploy version, SHA, uptime
- paused / market stale / reconciliation age
- containers up, restart/OOM status if checked
- runtime CPU/RAM, disk free
- winrate 7d, open positions, open orders, fills 24h
- Track C/G/H/I/J/K/L red signals
- log errors or queue overflows
- overall verdict

## Section 1 — System And Docker

### What To Check

- Server time is sane.
- Host load is not saturated.
- Disk has headroom.
- Runtime has not restarted or OOM-killed.
- All four containers are up.
- Runtime memory is stable.
- Runtime CPU is not pinned.

### Commands

```bash
ssh root@your.server.ip '
date -u +%Y-%m-%dT%H:%M:%SZ
hostname
uptime
free -m
df -h / /opt/krabs /var/lib/docker/volumes/krabs-data/_data 2>/dev/null || df -h
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}"
docker inspect --format "{{.Name}} restart={{.RestartCount}} oom={{.State.OOMKilled}}" \
  krabs-krabs-runtime-1 krabs-krabs-api-1 krabs-krabs-runtime-manager-1 krabs-docker-socket-proxy-1
'
```

### Production Baseline Observed 2026-06-05

- Host uptime: `14d 13h`.
- Disk `/`: `100G`, used `9.2G`, free `91G`, `10%`.
- Runtime: `1.237GiB / 4GiB`, `30.92%`, CPU `32.10%`.
- API: `81MiB / 256MiB`, `31.64%`.
- All four containers were up.

### RED Signals

- Any container missing or restarting.
- Runtime OOMKilled.
- Runtime memory above `90%` limit.
- Disk above `90%`.
- CPU near `100%` for multiple samples and reconciliation lag rising.

## Section 2 — API Health And Bot State

### Endpoints

Health is unauthenticated:

```bash
ssh root@your.server.ip 'curl -sS http://127.0.0.1:3100/api/v1/health'
```

Authenticated status:

```bash
ssh root@your.server.ip '
API_KEY=$(grep "^KRABS_API_KEY=" /opt/krabs/.env.production | cut -d= -f2-)
curl -sS -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3100/api/v1/status \
  | python3 -m json.tool
'
```

### Fields To Report

From `/api/v1/health`:

- `data.status`
- `data.deployVersion`
- `data.sha`
- `data.deployedAt`
- `data.uptime`

From `/api/v1/status`:

- `runtimeMode`, `envMode`, `currentProfile`, `ledgerProfile`
- `paused`
- `marketDataStale`
- `lastReconciliationAt`
- `marketDataLastUpdateAt`
- `openConditionCount`
- `openOrderCount`
- `openPositionCount`
- `ordersPlacedLastMin`
- `positionsOpenedLastMin`
- `totalOpenValueUsdc`
- `walletBalanceUsdc`
- `polymarketPortfolio`
- `tradingState`
- `signalActivity`
- `riskEventVolume`
- `userOrderStreamActivity`
- `marketDataStreamActivity`
- `liveLite`
- `reconciliationDriftDetected`

Also verify recent runtime starts directly from SQLite. This catches crash/restart
loops even if Docker restart count is not enough context:

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT run_id, mode, started_at
  FROM bot_runs
 ORDER BY started_at DESC
 LIMIT 10;
SQL'
```

### Healthy Example Observed 2026-06-05

- `status=ok`
- `deployVersion=77`
- `sha=e4d93c1`
- `runtimeMode=live-lite`
- `paused=false`
- `marketDataStale=false`
- `lastReconciliationAt` within seconds
- `marketDataLastUpdateAt` within seconds
- `openOrderCount=5`
- `openPositionCount=57`
- `tradingState=EXITS_ONLY`

### RED Signals

- `health.ok=false` or HTTP failure.
- `paused=true` when operator expects trading.
- `marketDataStale=true`.
- `lastReconciliationAt` older than `2m`.
- `marketDataLastUpdateAt` older than `60s`.
- `runtimeMode` not `live-lite` in production.
- `reconciliationDriftDetected=true`.
- multiple `bot_runs` in a short window without an operator deploy.
- `tradingState=NO_SIGNALS` for a long period while scanner has candidates and markets are open.

## Section 2.1 — Live-Lite Capital Envelope

For real-money production, always report live-lite caps and current utilization.

Sources:

- `/api/v1/status.data.liveLite`
- `/api/v1/status.data.totalOpenValueUsdc`
- `/api/v1/status.data.openPositionCount`
- `/api/v1/status.data.openOrderCount`
- `runtime_metrics.live_lite_envelope`
- `runtime_metrics.exchange_balance_reject_count`

Commands:

```bash
ssh root@your.server.ip '
API_KEY=$(grep "^KRABS_API_KEY=" /opt/krabs/.env.production | cut -d= -f2-)
curl -sS -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3100/api/v1/status \
  | python3 -c "import json,sys; d=json.load(sys.stdin)[\"data\"]; print({\"liveLite\": d.get(\"liveLite\"), \"totalOpenValueUsdc\": d.get(\"totalOpenValueUsdc\"), \"openPositionCount\": d.get(\"openPositionCount\"), \"openOrderCount\": d.get(\"openOrderCount\"), \"walletBalanceUsdc\": d.get(\"walletBalanceUsdc\")})"

sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT metric_name, value, labels, captured_at
  FROM runtime_metrics
 WHERE metric_name IN ('live_lite_envelope', 'exchange_balance_reject_count')
 ORDER BY captured_at DESC, id DESC
 LIMIT 20;
SQL
'
```

RED/WARN:

- `totalOpenValueUsdc` near `liveLite.maxOpenValueUsdc`.
- `openPositionCount` near `liveLite.maxActiveMarkets`.
- any recent `exchange_balance_reject_count`.
- wallet balance unexpectedly low relative to open orders and intended entries.

## Section 3 — Dashboard KPIs

Use the API first because it reflects the dashboard's own interpretation.

```bash
ssh root@your.server.ip '
API_KEY=$(grep "^KRABS_API_KEY=" /opt/krabs/.env.production | cut -d= -f2-)
curl -sS -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3100/api/v1/dashboard/kpi \
  | python3 -m json.tool
'
```

Report:

- `winrate_7d.value`, wins, losses, total
- `winrate_7d.sell_closed_pct`
- `winrate_7d.resolved_closed_pct`
- `exit_multiple_7d.median`
- `exit_multiple_7d.p90`
- `fills_24h.total`
- `fills_24h.maker_ratio`
- `fills_24h.volume_usd`
- `fills_24h.rate_per_position`
- `open_positions_count`
- `stuck_positions_count`
- `hold_resolution_active_count`
- `health.severity` and each health check

Observed 2026-06-05:

- `winrate_7d=21.05%`, `4W / 15L / 19 total`
- `sell_closed_pct=20%`
- `resolved_closed_pct=25%`
- `exit_multiple_7d.median=2.1667`, `count=1`
- `fills_24h.total=22`, maker ratio `100%`, volume `$9.47`
- `open_positions_count=57`
- `stuck_positions_count=3`
- `hold_resolution_active_count=0`
- `health.severity=warn` due to stuck positions

### How To Interpret

- Winrate is the main strategy metric, but it needs enough closed positions.
- If there are few closes in the last 7d, report `INCONCLUSIVE`, not a false
  regression.
- `stuck_positions_count > 0` is WARN; `>=4` is dashboard critical.
- `hold_resolution_active_count > 0` is WARN, not automatically bad, but every
  active row needs lifecycle tracking.

## Section 4 — SQLite And Storage Health

### DB Files

```bash
ssh root@your.server.ip '
ls -lh /var/lib/docker/volumes/krabs-data/_data/*.db*
sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db "
SELECT page_count, page_size,
       ROUND(page_count * page_size / 1024.0 / 1024.0, 1) AS db_mb,
       freelist_count
  FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count();
"
'
```

Observed 2026-06-05:

- `ledger-live-lite.db=3.2G`
- WAL `11M`
- SQLite page footprint `3198.4MB`
- DB size guard threshold in code: `30GB`

### Table Counts And Core State

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT status, COUNT(*) AS count,
       ROUND(SUM(COALESCE(current_value_usdc,0)), 4) AS current_value,
       ROUND(SUM(cost_basis_usdc), 4) AS cost_basis,
       ROUND(SUM(realized_pnl), 4) AS realized
  FROM positions
 GROUP BY status
 ORDER BY count DESC;

SELECT COUNT(*) AS open_count,
       MIN(opened_at) AS oldest_opened_at,
       MAX(opened_at) AS newest_opened_at,
       ROUND(SUM(cost_basis_usdc),4) AS open_cost,
       ROUND(SUM(COALESCE(current_value_usdc,0)),4) AS open_value
  FROM positions
 WHERE status = 'open';

SELECT status, COUNT(*) AS count
  FROM orders
 GROUP BY status
 ORDER BY count DESC;

SELECT COUNT(*) AS fills,
       ROUND(SUM(size_usdc),4) AS fill_notional,
       ROUND(SUM(fee),6) AS fees
  FROM fills;
SQL'
```

### RED Signals

- Ledger DB plus WAL above `30GB` or growing rapidly.
- WAL above `1GB` and growing.
- Disk under `10GB` free.
- SQLite query errors, malformed schema, or missing tables.
- `runtime_metrics` not updating.

Do not run `VACUUM` or checkpoints during a healthcheck.

## Section 5 — Runtime Metrics

The main telemetry table is `runtime_metrics(metric_name, value, labels, captured_at)`.

### Latest Metric Names

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT metric_name, COUNT(*) AS samples, MAX(captured_at) AS last_at
  FROM runtime_metrics
 WHERE captured_at >= datetime('now', '-6 hours')
 GROUP BY metric_name
 ORDER BY last_at DESC, metric_name
 LIMIT 100;
SQL'
```

### Metrics That Must Be Fresh

These should usually have a recent row:

- `market_data_last_update`
- `last_reconciliation`
- `reconciliation_lag_ms_p99`
- `runtime_diagnostics`
- `market_data_stream_activity`
- `signal_activity`
- `signal_conversion_activity`
- `risk_event_volume`
- `user_order_stream_activity`
- `execution_queue`
- `order_capacity_activity`
- `algo_decision_latency`
- `algo_decision_eval_counters`
- `r23_cache_activity`
- `runtime_paused`

### Critical/Fault Metrics

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT metric_name,
       ROUND(SUM(value),4) AS total,
       COUNT(*) AS samples,
       MAX(captured_at) AS last_at
  FROM runtime_metrics
 WHERE captured_at >= datetime('now', '-24 hours')
   AND (
     metric_name LIKE '%failed%' OR
     metric_name LIKE '%overflow%' OR
     metric_name LIKE '%pipeline%' OR
     metric_name IN (
       'db_size_guard_triggered_total',
       'track_l_noop_guard_total',
       'downprice_reprice_events_total',
       'exit_reprice_suppressed_threshold_total',
       'wallet_position_reader_timeout_total',
       'exchange_balance_reject_count',
       'stuck_sell_warnings_total',
       'reconciliation_drift'
     )
   )
 GROUP BY metric_name
 ORDER BY total DESC
 LIMIT 80;
SQL'
```

Observed 2026-06-05:

- `track_l_noop_guard_total=3909`
- `redeem_sweep_async_queue_overflow_total=683`
- `exit_reprice_suppressed_threshold_total=121`
- `downprice_reprice_events_total=28`

Interpretation:

- Track L guard activity is expected if wide-spread no-op reprices are being
  suppressed.
- Queue overflow is WARN if historical; RED if current and increasing.
- Any `*_failed_total` increasing is WARN/RED depending on path.
- `db_size_guard_triggered_total` is CRITICAL: the runtime auto-pauses when the
  ledger footprint crosses the hard DB-size guard. There is no auto-resume; an
  operator must inspect disk/DB growth before resuming.
- `exchange_balance_reject_count` means order placement is blocked by available
  balance/allowance and must be tied back to wallet state.
- `stuck_sell_warnings_total` should be reported with `stuck_positions_count`
  and reprice-chain diagnostics.

## Section 6 — Runtime Diagnostics And Latency

Use API coverage first:

```bash
ssh root@your.server.ip '
API_KEY=$(grep "^KRABS_API_KEY=" /opt/krabs/.env.production | cut -d= -f2-)
curl -sS -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3100/api/v1/metrics/coverage \
  | python3 -m json.tool
'
```

Key fields:

- `decision_tick_latency_p95_ms`
- `decision_tick_latency_p99_ms`
- `event_loop_lag_p95_ms`
- `event_loop_lag_max_ms`
- `gc_pause_max_ms`
- `stage_coalescing_flush_p95_ms`
- `stage_coalescing_flush_max_ms`
- `stage_metrics_flush_total_p95_ms`
- `stage_metrics_flush_sqlite_writes_p95_ms`
- `stage_risk_signal_approval_p95_ms`
- `stage_signal_to_order_bridge_p95_ms`
- `http_errors_by_class_1h`
- `ws_heartbeat`

Observed 2026-06-05:

- decision p95 `11ms`, p99 `17ms`
- event loop lag p95 `23ms`, max `132ms`
- GC max `50.28ms`
- coalescing flush p95 `10.33ms`, max `123.501ms`
- metrics flush total p95 `16.239ms`

### Reconciliation Stage Timings From Logs

`publishExchangeState` is best observed in reconciliation logs:

```bash
ssh root@your.server.ip 'docker logs krabs-krabs-runtime-1 --since 1h 2>&1 | python3 -c '"'"'exec("""
import sys,json
vals={"lagMs":[],"orders":[],"fills":[],"stale":[],"sentinel":[],"publishExchangeState":[]}
n=0
for line in sys.stdin:
    try:
        obj=json.loads(line)
    except Exception:
        continue
    if obj.get("msg") != "reconciliation pass complete":
        continue
    n += 1
    if isinstance(obj.get("lagMs"),(int,float)):
        vals["lagMs"].append(obj["lagMs"])
    st=obj.get("stageTimingsMs") or {}
    for k in ["orders","fills","stale","sentinel","publishExchangeState"]:
        if isinstance(st.get(k),(int,float)):
            vals[k].append(st[k])
def q(a,p):
    if not a: return None
    b=sorted(a)
    return b[min(len(b)-1, int(round((len(b)-1)*p)))]
out={"passes":n}
for k,a in vals.items():
    out[k]={"count":len(a),"p50":q(a,.5),"p95":q(a,.95),"p99":q(a,.99),"max":max(a) if a else None}
print(json.dumps(out,indent=2))
""")'"'"''
```

Observed 2026-06-05 last hour:

- `publishExchangeState`: p50 `4ms`, p95 `6ms`, p99 `17ms`, max `21ms`
- reconciliation `lagMs`: p50 `792ms`, p95 `1593ms`, p99 `2465ms`
- `fills` stage: p50 `100ms`, p95 `144ms`, p99 `1026ms`, max `1639ms`

RED signals:

- `publishExchangeState` p99 above `200ms`, especially after Track H/I.
- Reconciliation lag p99 above `30s`.
- Fills/orders stage p99 repeatedly in seconds and growing.
- Event loop p95 above `1500ms`.

## Section 7 — Market Data, WebSockets, Track G

Sources:

- `/api/v1/status.data.marketDataStreamActivity` for raw camelCase stream
  telemetry such as `trackedTokenCount`, `bookSignalFullBookSubscribedCount`,
  `wsHeartbeat`, `staleTokenCount`, and `pendingGapTokenCount`.
- `/api/v1/metrics/coverage` for normalized snake_case dashboard coverage
  fields such as `ws_tracked`, `coverage_pct`, `decision_tick_latency_p99_ms`,
  `event_loop_lag_p95_ms`, and stage timers.

Do not look for `trackedTokenCount` or `bookSignalFullBookSubscribedCount` at
the top level of `/metrics/coverage`; they are nested under
`/status.data.marketDataStreamActivity`.

Report:

- `wsEnabled`
- `trackedTokenCount`
- `wsCapUtilizationPct`
- `shardCount`
- `wsEventsReceivedPerSec`
- `rawWsRecordsPerSec`
- `parsedUpdatesPerSec`
- `emittedUpdatesPerSec`
- `noopUpdatesPerSec`
- `wsEventGapDetected`
- `reconnectCount`
- `staleTokenCount`
- `silentTrackedTokenCount`
- `fallbackPollCount`
- `fallbackDroppedStaleCount`
- `pendingGapTokenCount`
- `bookSignalFullBookDemandCount`
- `bookSignalFullBookSubscribedCount`
- `bookSignalFullBookSkippedCount`
- `bookSignalFullBookCapUtilizationPct`
- `wsHeartbeat.timeoutFired`
- `wsHeartbeat.workerEventLoopLagMaxMs`

Useful extraction command:

```bash
ssh root@your.server.ip '
API_KEY=$(grep "^KRABS_API_KEY=" /opt/krabs/.env.production | cut -d= -f2-)
curl -sS -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3100/api/v1/status \
  | python3 -c "import json,sys; d=json.load(sys.stdin)[\"data\"].get(\"marketDataStreamActivity\") or {}; keys=[\"trackedTokenCount\",\"wsCapUtilizationPct\",\"shardCount\",\"wsEventsReceivedPerSec\",\"wsEventGapDetected\",\"reconnectCount\",\"staleTokenCount\",\"silentTrackedTokenCount\",\"fallbackPollCount\",\"pendingGapTokenCount\",\"bookSignalFullBookDemandCount\",\"bookSignalFullBookSubscribedCount\",\"bookSignalFullBookSkippedCount\",\"bookSignalFullBookCapUtilizationPct\",\"wsHeartbeat\"]; print({k:d.get(k) for k in keys})"
'
```

Observed 2026-06-05:

- `ws_tracked=5004`
- active universe `16505`
- coverage `30.32%`
- events/sec `4280.717`
- `bookSignalFullBookDemandCount=57`
- `bookSignalFullBookSubscribedCount=57`
- `bookSignalFullBookSkippedCount=0`
- `wsEventGapDetected=1`
- `reconnectCount=1`
- `wsHeartbeat.timeoutFired=0`

RED signals:

- `bookSignalFullBookSkippedCount > 0` and growing.
- `wsEventGapDetected` bursts every poll.
- `pendingGapTokenCount > 0` for more than one poll.
- `staleTokenCount` increasing on execution-critical tokens.
- `wsHeartbeat.timeoutFired > 0`.
- `trackedTokenCount` drops significantly without known deploy/restart.

## Section 8 — Track C / Strategic Exit Safety

### Decision Distribution

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT metric_name,
       ROUND(SUM(value),4) AS total,
       COUNT(*) AS samples,
       MIN(captured_at) AS first_at,
       MAX(captured_at) AS last_at
  FROM runtime_metrics
 WHERE captured_at >= datetime('now', '-24 hours')
   AND metric_name LIKE 'track_c.%'
 GROUP BY metric_name
 ORDER BY metric_name;
SQL'
```

Report:

- `track_c.verdict.live`, `.dead`, `.unknown`
- `track_c.action.continue_normal`, `.continue_passive_sit`, `.hold_resolution`
- `track_c.stale_branch.none`, `.price_only`, `.chain`, `.chain+price`
- `track_c_pipeline_failed_total`

Sparse-counter rule: Track C branch and failure counters are emitted only when
that branch fires. If a counter is absent from the 24h query, treat it as `0`
for that window, not as missing telemetry. Examples: `track_c.action.hold_resolution`,
`track_c.stale_branch.price_only`, `.chain`, `.chain+price`, and
`track_c_pipeline_failed_total`.

Observed 2026-06-05 24h:

- `track_c.verdict.dead=306`
- `track_c.verdict.live=38`
- `track_c.verdict.unknown=14`
- `track_c.action.continue_passive_sit=306`
- `track_c.action.continue_normal=52`
- `track_c.stale_branch.none=358`

Interpretation:

- UNKNOWN should be low after warmup. Persistent `>20%` after 1h is WARN.
- Any new `track_c_pipeline_failed_total` after a fix is RED.
- `floor_intents active > 0` is CRITICAL in current Phase 1 safety model.

### Hold Resolution And Floor Intents

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT status, COUNT(*) AS count, MIN(marker_created_at) AS first_at, MAX(marker_created_at) AS last_at
  FROM hold_resolution_states
 GROUP BY status;

SELECT COUNT(*) AS active_gt_24h
  FROM hold_resolution_states
 WHERE status = 'active'
   AND marker_created_at < datetime('now', '-24 hours');

SELECT status, COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
  FROM floor_intents
 GROUP BY status;

SELECT COUNT(*) AS active_floor_intents
  FROM floor_intents
 WHERE status = 'active';
SQL'
```

Observed 2026-06-05:

- no active hold-resolution rows
- no floor intents

## Section 9 — Track H/I Async Queues And Track D Redeem Safety

Report these metrics from `runtime_metrics`:

- `redeem_sweep_async_enqueued_total`
- `redeem_sweep_async_completed_total`
- `redeem_sweep_async_failed_total`
- `redeem_sweep_async_queue_depth`
- `redeem_sweep_async_queue_overflow_total`
- `redeem_sweep_async_latency_ms`
- `resolution_async_enqueued_total`
- `resolution_async_completed_total`
- `resolution_async_failed_total`
- `resolution_async_queue_depth`
- `resolution_async_queue_overflow_total`
- `resolution_async_worker_crashed_total`
- `resolution_async_latency_ms`
- `wallet_position_reader_timeout_total`
- `redeem_quarantined_total`
- `redeem_quarantine_skipped_total`
- `redeem_sweep_skipped_total`

Resolution queue sparse-counter rule: these metrics are emitted only when a
MarketResolvedHint/RedeemRequested resolution job is enqueued or processed. If
all `resolution_async%` metrics are absent for the time window and there were
no resolution events in logs, report `WAITING / no resolution jobs`. If logs
show resolution jobs but metrics are absent, report `WARN: telemetry gap`.

SQL:

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT metric_name, ROUND(SUM(value),4) AS total, COUNT(*) AS samples, MAX(captured_at) AS last_at
  FROM runtime_metrics
 WHERE captured_at >= datetime('now', '-24 hours')
   AND (
     metric_name LIKE 'redeem_%'
     OR metric_name LIKE 'resolution_async%'
     OR metric_name = 'wallet_position_reader_timeout_total'
     OR metric_name = 'db_size_guard_triggered_total'
   )
 GROUP BY metric_name
 ORDER BY metric_name;

SELECT COUNT(*) AS quarantined_positions,
       MAX(consecutive_state_failed_count) AS max_consecutive_state_failed_count
  FROM positions
 WHERE redeem_quarantine_until_ts IS NOT NULL
    OR consecutive_state_failed_count > 0;
SQL'
```

RED signals:

- `*_failed_total` increasing.
- queue depth not returning to `0`.
- queue overflow current/increasing.
- many wallet reader timeouts plus reconciliation lag rising.
- quarantine count rising rapidly with failed redeems.

## Section 10 — Orders

Use both API and SQL. API is good for recent examples; SQL is better for
aggregates.

API:

```bash
ssh root@your.server.ip '
API_KEY=$(grep "^KRABS_API_KEY=" /opt/krabs/.env.production | cut -d= -f2-)
curl -sS -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:3100/api/v1/orders?limit=50" \
  | python3 -m json.tool
curl -sS -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:3100/api/v1/orders?status=open&limit=100" \
  | python3 -m json.tool
'
```

SQL:

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT status, COUNT(*) AS orders, ROUND(SUM(size_usdc),4) AS notional
  FROM orders
 WHERE created_at >= datetime('now', '-24 hours')
 GROUP BY status
 ORDER BY orders DESC;

SELECT COALESCE(cancel_reason,'(null)') AS cancel_reason,
       COUNT(*) AS orders,
       ROUND(SUM(size_usdc),4) AS notional,
       MIN(created_at) AS first_at,
       MAX(created_at) AS last_at
  FROM orders
 WHERE created_at >= datetime('now', '-24 hours')
 GROUP BY cancel_reason
 ORDER BY orders DESC
 LIMIT 20;

SELECT COUNT(*) AS open_orders,
       MIN(created_at) AS oldest_open,
       MAX(created_at) AS newest_open,
       ROUND(MAX((julianday('now')-julianday(created_at))*24*60),1) AS max_age_min
  FROM orders
 WHERE status = 'open';

SELECT token_id, side, price, size, COUNT(*) AS c
  FROM orders
 WHERE status = 'open'
 GROUP BY token_id, side, price, size
HAVING COUNT(*) > 1
 LIMIT 20;

SELECT token_id, side, price, size, COUNT(*) AS c,
       MIN(created_at) AS first_at,
       MAX(created_at) AS last_at
  FROM orders
 WHERE created_at >= datetime('now', '-24 hours')
   AND cancel_reason = 'downpriced_reprice'
 GROUP BY token_id, side, price, size
HAVING COUNT(*) >= 3
 ORDER BY c DESC
 LIMIT 20;
SQL'
```

Observed 2026-06-05:

- 24h orders: `232 cancelled`, `5 open`, `4 filled`, `1 rejected`
- 24h cancel reasons:
  - `stale_entry_ttl=184`
  - `downpriced_reprice=27`
  - `phantom_missing_on_exchange=6`
  - `stale_exit_ttl=6`
  - `sell_replace_reprice=4`
- Open orders max age: `264.7m`
- Same-price downprice loop still found for one token:
  - price `0.022`, size `67.621`, count `19`
  - first `2026-06-04T01:17:55Z`, last `2026-06-04T02:13:49Z`

RED signals:

- Duplicate open orders with same token/side/price/size.
- Same-price `downpriced_reprice` loop count `>=3` after Track L deploy.
- `phantom_missing_on_exchange` high and growing.
- `exchange_balance_reject_count` or balance rejection logs.
- Open orders older than expected with no fills or updates.
- Filled orders not reflected in positions.

## Section 11 — Fills And Execution Quality

API:

```bash
ssh root@your.server.ip '
API_KEY=$(grep "^KRABS_API_KEY=" /opt/krabs/.env.production | cut -d= -f2-)
curl -sS -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:3100/api/v1/fills?limit=100" \
  | python3 -m json.tool
'
```

SQL:

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT side, liquidity_role,
       COUNT(*) AS fills,
       ROUND(SUM(size_usdc),4) AS notional,
       ROUND(SUM(fee),6) AS fees,
       MIN(filled_at) AS first_at,
       MAX(filled_at) AS last_at
  FROM fills
 WHERE filled_at >= datetime('now', '-24 hours')
 GROUP BY side, liquidity_role
 ORDER BY fills DESC;

SELECT COUNT(*) AS duplicate_fill_ids
  FROM (
    SELECT fill_id
      FROM fills
     GROUP BY fill_id
    HAVING COUNT(*) > 1
  );

SELECT COUNT(*) AS unknown_role_fills_24h
  FROM fills
 WHERE filled_at >= datetime('now', '-24 hours')
   AND liquidity_role = 'unknown';
SQL'
```

Observed 2026-06-05:

- 24h fills: `15 buy maker`, `9 sell maker`
- 24h fill notional: buy `$7.0652`, sell `$11.5133`
- taker fills in dashboard: `0`
- maker ratio: `100%`

RED signals:

- No fills for a long period while orders are being placed and markets are live.
- Unknown liquidity role >0 after mapper fixes.
- Duplicate fills.
- Large fee leakage ratio.
- Fills missing corresponding local order, unless explicitly classified and reconciled.

## Section 12 — Positions, Winrate, Exit Multiple

Dashboard API gives the canonical UI values. SQL below is for independent
verification.

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT COUNT(*) AS total,
       SUM(realized_pnl > 0) AS wins,
       SUM(realized_pnl < 0) AS losses,
       SUM(realized_pnl = 0) AS breakeven,
       ROUND(100.0 * SUM(realized_pnl > 0) / NULLIF(COUNT(*),0), 2) AS winrate_pct,
       ROUND(SUM(realized_pnl),4) AS realized_pnl
  FROM positions
 WHERE status = 'closed'
   AND closed_at >= datetime('now', '-7 days');

SELECT p.position_id,
       m.slug,
       p.token_id,
       p.opened_at,
       p.closed_at,
       p.avg_entry_price,
       ROUND(SUM(f.size_usdc) / NULLIF(SUM(f.size), 0) / p.avg_entry_price, 4) AS exit_multiple
  FROM positions p
  JOIN fills f ON f.token_id = p.token_id
  LEFT JOIN markets m ON m.token_id = p.token_id
 WHERE p.status = 'closed'
   AND p.closed_at IS NOT NULL
   AND p.closed_at >= datetime('now', '-7 days')
   AND p.avg_entry_price > 0
   AND LOWER(f.side) = 'sell'
   AND f.filled_at >= p.opened_at
   AND f.filled_at <= p.closed_at
 GROUP BY p.position_id, p.avg_entry_price
HAVING exit_multiple IS NOT NULL
 ORDER BY exit_multiple DESC;

SELECT p.position_id, m.slug, p.token_id, p.opened_at,
       ROUND(p.cost_basis_usdc,4) AS cost_basis,
       ROUND(COALESCE(p.current_value_usdc,0),4) AS current_value,
       ROUND(CASE WHEN p.cost_basis_usdc > 0 THEN
         100.0 * (COALESCE(p.current_value_usdc,0) - p.cost_basis_usdc) / p.cost_basis_usdc
       ELSE NULL END, 2) AS pnl_pct
  FROM positions p
  LEFT JOIN markets m ON m.token_id = p.token_id
 WHERE p.status = 'open'
 ORDER BY pnl_pct ASC
 LIMIT 20;
SQL'
```

Interpretation:

- The target winrate is strategy-dependent; compare to the latest operator
  baseline rather than hardcoding one forever.
- If closed position count is small, mark winrate as `INCONCLUSIVE`.
- Watch the worst open positions by unrealized PnL, but do not call them
  realized losses until closed.
- If `exit_multiple_7d.count` is low, median/p90 are unstable.

## Section 13 — Portfolio PnL Series

Use this when dashboard/Polymarket PnL numbers are questioned.

```bash
ssh root@your.server.ip '
API_KEY=$(grep "^KRABS_API_KEY=" /opt/krabs/.env.production | cut -d= -f2-)
for interval in 1d 1w 1m all; do
  echo "== $interval =="
  curl -sS -H "Authorization: Bearer $API_KEY" \
    "http://127.0.0.1:3100/api/v1/metrics/portfolio-series?interval=$interval" \
    | python3 -c "import json,sys; d=json.load(sys.stdin)[\"data\"]; print({k:d.get(k) for k in [\"baseline\",\"currentEquity\",\"portfolioPnl\",\"historyStart\",\"coverageComplete\",\"interval\"]}); print(\"points\", len(d.get(\"items\", [])), \"first\", d.get(\"items\", [None])[0], \"last\", d.get(\"items\", [None])[-1])"
done
'
```

Also inspect raw snapshots:

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT captured_at, equity_usdc, wallet_usdc, position_value_usdc,
       realized_pnl_usdc, open_value_usdc
  FROM portfolio_snapshots
 WHERE profile = 'live-lite'
 ORDER BY julianday(replace(captured_at, '+00', '')) DESC
 LIMIT 30;
SQL'
```

The ordering is wrapped for the same reason the runtime readers are: `captured_at` still carries
`DEFAULT (datetime('now'))` on the production table, and a space-rendered row sorts BELOW every
same-day ISO row (`' '` 0x20 < `'T'` 0x54). A raw `ORDER BY captured_at DESC` would then show an
older row as the latest snapshot — the exact wrong answer to ask a diagnostic query for.

Known caveat: API field `equityUsdc` in the portfolio series currently carries
windowed PnL points, not raw Polymarket portfolio equity. If the operator is
comparing against Polymarket UI, report:

- interval
- `baseline`
- `currentEquity`
- `portfolioPnl`
- first/last point
- whether `coverageComplete` is true

## Section 14 — Trading Activity And Signal Flow

`/api/v1/metrics/trading-activity?days=1` returns only the historical time
series fields:

- `tradingState`
- `signalsProduced`
- `signalsApproved`
- `signalsRejected`
- `capturedAt`

Use it for state distribution and signal-volume trend, not for conversion
details.

```bash
ssh root@your.server.ip '
API_KEY=$(grep "^KRABS_API_KEY=" /opt/krabs/.env.production | cut -d= -f2-)
curl -sS -H "Authorization: Bearer $API_KEY" \
  "http://127.0.0.1:3100/api/v1/metrics/trading-activity?days=1" \
  | python3 -c "import json,sys,collections; items=json.load(sys.stdin)[\"data\"][\"items\"]; states=collections.Counter(i[\"tradingState\"] for i in items); print({\"points\":len(items),\"states\":dict(states),\"signalsProduced\":sum(i[\"signalsProduced\"] for i in items),\"signalsApproved\":sum(i[\"signalsApproved\"] for i in items),\"signalsRejected\":sum(i[\"signalsRejected\"] for i in items),\"first\":items[0] if items else None,\"last\":items[-1] if items else None})"
'
```

For current conversion details, use `/api/v1/status.data.signalActivity`:

```bash
ssh root@your.server.ip '
API_KEY=$(grep "^KRABS_API_KEY=" /opt/krabs/.env.production | cut -d= -f2-)
curl -sS -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3100/api/v1/status \
  | python3 -c "import json,sys; s=json.load(sys.stdin)[\"data\"].get(\"signalActivity\") or {}; keys=[\"signalsProducedLast10m\",\"signalsApprovedLast10m\",\"signalsRejectedLast10m\",\"entrySignalsApprovedLast10m\",\"exitSignalsApprovedLast10m\",\"lastEntryApprovedAt\",\"lastSignalRejectedAt\",\"signalsConvertedLast10m\",\"conversionSkippedLast10mByReason\",\"exchangeAcceptedLast10m\",\"exchangeRejectedLast10mByCode\",\"exchangeRejectedLast10mByReason\",\"fillsLast10m\",\"topBlockingLayer\"]; print({k:s.get(k) for k in keys})"
'
```

For durable latest metric payloads, inspect `runtime_metrics`:

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT metric_name, value, labels, captured_at
  FROM runtime_metrics
 WHERE metric_name IN (
   'signal_activity',
   'scanner_activity',
   'signal_conversion_activity',
   'last_entry_approved',
   'last_signal_rejected'
 )
 ORDER BY captured_at DESC, id DESC
 LIMIT 20;
SQL'
```

Report:

- Distribution of `tradingState`: `ACTIVELY_TRADING`, `EXITS_ONLY`,
  `NO_SIGNALS`, `ALIVE_BUT_BLOCKED`, `PAUSED`
- `signalsProduced`, `signalsApproved`, `signalsRejected`
- current `lastEntryApprovedAt`
- current `lastSignalRejectedAt`
- current `signalsConvertedLast10m`
- current conversion skipped reasons
- current exchange accepted/rejected counts
- current fills last 10m
- `scanner_activity` if status says scanner is the blocking layer

RED/WARN:

- No entries for many hours if operator expects active entry trading.
- `signalsProduced > 0` but `signalsApproved=0` for a long time: check risk
  gate, scanner, selection rules.
- `signalsApproved > 0` but `signalsConverted=0`: check signal-to-order bridge.
- `exchangeRejectedLast10mByCode` non-empty and increasing.
- `fillsLast10m=0` is not automatically bad; interpret with order activity.

## Section 15 — Logs

Pino logs go to Docker stdout. There is no file transport.

### Level Counts And Top Warning/Error Messages

```bash
ssh root@your.server.ip 'docker logs krabs-krabs-runtime-1 --since 24h 2>&1 | python3 -c '"'"'exec("""
import sys,json,collections
levels=collections.Counter()
msgs=collections.Counter()
modules=collections.Counter()
for line in sys.stdin:
    try:
        obj=json.loads(line)
    except Exception:
        continue
    level=obj.get("level")
    if level is not None:
        levels[str(level)] += 1
    if level and int(level) >= 40:
        msgs[obj.get("msg", "(no msg)")] += 1
        modules[obj.get("module", obj.get("source", "(none)"))] += 1
print(json.dumps({
  "levels": levels,
  "warn_error_msgs": msgs.most_common(30),
  "warn_error_modules": modules.most_common(30)
}, indent=2))
""")'"'"''
```

### Suspicious Lines Tail

```bash
ssh root@your.server.ip '
docker logs krabs-krabs-runtime-1 --since 24h 2>&1 \
  | grep -Ei "error|failed|TypeError|Unhandled|uncaught|panic|overflow|gap|reconnect|downprice|noop|track_c|missing on exchange" \
  | tail -120
'
```

Observed 2026-06-05 level counts:

- `level=30`: `56279`
- `level=40`: `42339`
- `level=50`: `96`

Top warnings/errors included:

- fallback poll deferrals
- min-size sell blocks
- unknown exchange orders
- reserved sell drift
- wallet position drift
- resolution unknown/manual review
- redeem sweep async queue overflow
- market-data stream gaps
- wallet reader timeouts
- user websocket stream errors

Important: a naive grep for `failed` will overcount expected/recovered paths.
Always classify by message and metric trend.

RED signals:

- New `TypeError`, `Unhandled`, `uncaught`, `panic`.
- `level=50` increasing with new message types.
- Repeated user websocket errors without catch-up sync.
- Repeated market-data gaps with stale tokens.
- Reconciliation pass slow with stage timings above thresholds.
- Any log showing floor intent creation in Phase 1.

## Section 16 — External API / Polymarket Connectivity

Do not test Polymarket from local dev network. Use the production server.

### API-Level Symptoms

Check:

- `http_errors_by_class_1h` from `/api/v1/metrics/coverage`
- source metric `runtime_metrics.http_error_class`
- `trade_count_fetch_ok`
- `trade_count_fetch_err`
- `marketDataStale`
- `market_data_stream_activity.wsEventGapDetected`
- `userOrderStreamActivity.wsEventGapDetected`
- exchange rejection counters in `signal_conversion_activity`

SQL:

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT metric_name, COUNT(*) AS samples, MAX(captured_at) AS last_at
  FROM runtime_metrics
 WHERE captured_at >= datetime('now', '-24 hours')
   AND metric_name IN ('http_error_class', 'trade_count_fetch_ok', 'trade_count_fetch_err')
 GROUP BY metric_name
 ORDER BY metric_name;
SQL'
```

### Direct Read-Only Checks

Only use public/read endpoints. Do not place/cancel orders.

```bash
ssh root@your.server.ip '
curl -sS -I https://gamma-api.polymarket.com/health 2>/dev/null | head
curl -sS -I https://clob.polymarket.com/ 2>/dev/null | head
'
```

If these endpoints do not expose useful health, rely on app telemetry instead.

RED signals:

- `http_errors_by_class_1h` non-empty and growing.
- CLOB rejects for balance/allowance/min-size suddenly spike.
- Market data stale while host network is healthy.
- User order stream gap without catch-up sync.

## Section 17 — Current Known Operational Watchpoints

These are not necessarily bugs, but they should appear in health reports until
closed by operator decision.

1. **Winrate below target.**
   - Observed `2026-06-05`: dashboard 7d winrate `21.05%`.
   - Needs enough post-deploy closed positions before judging the strategic
     Track C/G target.

2. **Stuck positions.**
   - Observed `2026-06-05`: `stuck_positions_count=3`, dashboard WARN.

3. **Track L same-price no-op guard.**
   - `track_l_noop_guard_total` is active and should suppress same-price churn.
   - Same-price reprice loop SQL should return zero after Track L has had enough
     time to apply.

4. **Redeem sweep queue overflow history.**
   - Observed `2026-06-05`: `redeem_sweep_async_queue_overflow_total=683` in
     last 24h, historical. Treat as RED only if current/increasing.

5. **Wallet/redeem drift.**
   - Watch `wallet_position_reader_timeout_total`, `redeem_quarantined_total`,
     and positions with `consecutive_state_failed_count`.

6. **Runtime memory trend.**
   - Observed runtime memory `1.237GiB / 4GiB`.
   - Not dangerous now, but include trend in longer checks.

7. **User websocket and market-data gaps.**
   - Occasional gaps with catch-up are tolerable.
   - Continuous gaps or stale execution-critical tokens are RED.

## Section 18 — Full Report Template

Use this structure for operator reports.

```markdown
# Krabs Healthcheck Report — YYYY-MM-DD HH:MM UTC

## Verdict

Overall: GREEN / WARN / RED / CRITICAL
Reason:

## 1. System / Docker

- Server time:
- Uptime/load:
- Disk:
- Memory:
- Docker containers:
- Restart/OOM:
- Verdict:

## 2. API / Bot State

- deployVersion / sha / deployedAt:
- health status:
- runtimeMode/profile:
- paused:
- marketDataStale:
- lastReconciliationAt age:
- marketDataLastUpdateAt age:
- reconciliationDriftDetected:
- recent bot_runs:
- tradingState:
- open orders / positions / conditions:
- wallet / portfolio:
- liveLite envelope and cap utilization:
- Verdict:

## 3. DB / Storage

- ledger DB size:
- WAL size:
- DB page footprint:
- db_size_guard_triggered_total:
- table/state summary:
- runtime_metrics freshness:
- Verdict:

## 4. Runtime / Latency

- event loop p95/max:
- decision p95/p99:
- reconciliation lag p50/p95/p99:
- publishExchangeState p50/p95/p99:
- slow stages:
- Verdict:

## 5. Market Data / Track G

- tracked tokens / active universe / coverage:
- events/sec:
- full-book demand/subscribed/skipped:
- WS gaps/reconnects:
- stale/silent tokens:
- heartbeat timeouts:
- Verdict:

## 6. Track C / Exit Safety

- Track C verdict distribution:
- action distribution:
- UNKNOWN rate:
- pipeline failures:
- hold_resolution active:
- floor_intents active:
- HARD RULE evidence:
- Verdict:

## 7. Async Queues / Redeem / Resolution

- Track H redeem queue depth/enqueued/completed/failed/overflow:
- Track I resolution queue enqueued/completed/failed/overflow, or WAITING if no resolution jobs:
- wallet reader timeouts:
- quarantine counts:
- Verdict:

## 8. Orders

- 24h orders by status:
- open order max age:
- cancel reasons:
- same-price reprice loops:
- duplicate open orders:
- exchange rejects:
- Verdict:

## 9. Fills / Execution

- 24h fills:
- maker/taker/unknown:
- notional/fees:
- duplicate fills:
- latest fill:
- Verdict:

## 10. Positions / Strategy KPIs

- winrate 7d:
- closed sample size:
- sell-closed / resolved-closed:
- exit multiple median/p90/count:
- open positions:
- worst open unrealized PnL:
- stuck positions:
- Verdict:

## 11. Portfolio PnL

- interval checked:
- baseline/current/portfolioPnl:
- coverageComplete:
- first/last point:
- comparison to Polymarket UI if relevant:
- Verdict:

## 12. Logs

- level counts:
- top warning/error messages:
- new/unexpected errors:
- recent suspicious lines:
- Verdict:

## Recommendations

1.
2.
3.
```

## Section 19 — One-Command SQL Bundle

Use this when the operator asks for a complete DB-side check.

```bash
ssh root@your.server.ip 'sqlite3 -readonly /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db <<'"'"'SQL'"'"'
.headers on
.mode column
SELECT 'now_utc' AS section, datetime('now') AS value;

SELECT 'db_pages' AS section, page_count, page_size,
       ROUND(page_count * page_size / 1024.0 / 1024.0, 1) AS db_mb,
       freelist_count
  FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count();

SELECT 'positions_by_status' AS section, status, COUNT(*) AS count,
       ROUND(SUM(COALESCE(current_value_usdc,0)), 4) AS current_value,
       ROUND(SUM(cost_basis_usdc), 4) AS cost_basis,
       ROUND(SUM(realized_pnl), 4) AS realized
  FROM positions
 GROUP BY status
 ORDER BY count DESC;

SELECT 'winrate_7d' AS section, COUNT(*) AS total,
       SUM(realized_pnl > 0) AS wins,
       SUM(realized_pnl < 0) AS losses,
       SUM(realized_pnl = 0) AS breakeven,
       ROUND(100.0 * SUM(realized_pnl > 0) / NULLIF(COUNT(*),0), 2) AS winrate_pct,
       ROUND(SUM(realized_pnl),4) AS realized_pnl
  FROM positions
 WHERE status = 'closed'
   AND closed_at >= datetime('now', '-7 days');

SELECT 'fills_24h_by_side_role' AS section, side, liquidity_role,
       COUNT(*) AS fills, ROUND(SUM(size_usdc),4) AS notional,
       ROUND(SUM(fee),6) AS fees
  FROM fills
 WHERE filled_at >= datetime('now', '-24 hours')
 GROUP BY side, liquidity_role
 ORDER BY fills DESC;

SELECT 'orders_24h_status' AS section, status, COUNT(*) AS orders,
       ROUND(SUM(size_usdc),4) AS notional
  FROM orders
 WHERE created_at >= datetime('now', '-24 hours')
 GROUP BY status
 ORDER BY orders DESC;

SELECT 'orders_24h_cancel_reason' AS section, COALESCE(cancel_reason,'(null)') AS cancel_reason,
       COUNT(*) AS orders, ROUND(SUM(size_usdc),4) AS notional,
       MIN(created_at) AS first_at, MAX(created_at) AS last_at
  FROM orders
 WHERE created_at >= datetime('now', '-24 hours')
 GROUP BY cancel_reason
 ORDER BY orders DESC
 LIMIT 20;

SELECT 'open_order_age' AS section, COUNT(*) AS open_orders,
       MIN(created_at) AS oldest_open,
       MAX(created_at) AS newest_open,
       ROUND(MAX((julianday('now')-julianday(created_at))*24*60),1) AS max_age_min
  FROM orders
 WHERE status = 'open';

SELECT 'same_price_reprice_loops_24h' AS section, token_id, side, price, size,
       COUNT(*) AS c, MIN(created_at) AS first_at, MAX(created_at) AS last_at
  FROM orders
 WHERE created_at >= datetime('now', '-24 hours')
   AND cancel_reason = 'downpriced_reprice'
 GROUP BY token_id, side, price, size
HAVING COUNT(*) >= 3
 ORDER BY c DESC
 LIMIT 20;

SELECT 'track_c_24h' AS section, metric_name,
       ROUND(SUM(value),4) AS total,
       COUNT(*) AS samples,
       MIN(captured_at) AS first_at,
       MAX(captured_at) AS last_at
  FROM runtime_metrics
 WHERE captured_at >= datetime('now', '-24 hours')
   AND metric_name LIKE 'track_c.%'
 GROUP BY metric_name
 ORDER BY metric_name;

SELECT 'critical_metrics_24h' AS section, metric_name,
       ROUND(SUM(value),4) AS total,
       COUNT(*) AS samples,
       MAX(captured_at) AS last_at
  FROM runtime_metrics
 WHERE captured_at >= datetime('now', '-24 hours')
   AND (
     metric_name LIKE '%failed%'
     OR metric_name LIKE '%overflow%'
     OR metric_name LIKE '%pipeline%'
     OR metric_name IN (
       'track_l_noop_guard_total',
       'downprice_reprice_events_total',
       'exit_reprice_suppressed_threshold_total',
       'wallet_position_reader_timeout_total',
       'exchange_balance_reject_count',
       'stuck_sell_warnings_total',
       'reconciliation_drift'
     )
   )
 GROUP BY metric_name
 ORDER BY total DESC
 LIMIT 80;

SELECT 'hold_resolution' AS section, status, COUNT(*) AS count,
       MIN(marker_created_at) AS first_at,
       MAX(marker_created_at) AS last_at
  FROM hold_resolution_states
 GROUP BY status;

SELECT 'floor_intents' AS section, status, COUNT(*) AS count,
       MIN(created_at) AS first_at,
       MAX(created_at) AS last_at
  FROM floor_intents
 GROUP BY status;
SQL'
```
