# ADR-039: Phase F WS Handling in Dedicated Workers

Date: 2026-05-20

## Context

Phase E.3/E.5 restored decision throughput and V4 selection:

- decision tick p95 recovered to sub-second latency;
- WS tracked count recovered to 5000;
- V4 admission stabilized inside the target band;
- the process remained stable and opened new positions.

The remaining operational issue is spurious market WS pong-timeouts. Diagnostic evidence in
`research_plankton/ws_pong_timeout_diagnostic_2026-05-20.md` showed the connection is alive and
market data continues to flow, but the main Node event loop can still stall long enough for heartbeat
timers to fire before the PONG/inbound message is processed.

ADR-035 already identified main-thread WS parsing/heartbeat handling as a follow-up performance risk.
Phase F resolves that risk directly instead of tuning timeout constants on the main loop.

## Decision

Move production WS handling into dedicated worker threads.

### Topology

Use one dedicated market WS worker per shard and one dedicated user WS worker.

Rejected alternatives:

- Single worker for all market shards: lower thread count, but one worker event loop can still stall
  all 10 shards together.
- Generic WS worker pool: adds routing complexity and weakens shard crash isolation.

Chosen topology:

- Market pricing stream keeps the existing shard contract.
- Each shard owns one worker when `WS_WORKER_COUNT` permits it.
- User event stream owns one worker in production.
- Tests and injected WebSocket factories default to the legacy in-process path.

This matches the current 10 shard production shape: 5000 tracked tokens / 500 tokens per shard.

## Architecture

Before:

```text
main thread
  Polymarket WS sockets
  JSON parse
  heartbeat timers
  reconnect logic
  market-data callbacks
  decision/event-bus/runtime work
```

After:

```text
market WS worker per shard
  connect/subscribe/reconnect
  heartbeat send + health check
  inbound JSON parse
  bounded queue
  parsed record IPC

main thread
  normalized update application
  market-data cache
  event bus
  decision workers
```

User stream follows the same separation:

```text
user WS worker
  connect/auth subscribe/reconnect
  heartbeat health
  inbound parse + map trade/order events

main thread
  user order stream handlers
```

## Heartbeat Model

Workers send `PING` and accept `PONG`. Heartbeat health is based on worker-local time:

- per-shard heartbeat jitter avoids synchronized PING bursts;
- any inbound message after a sent PING counts as connection liveness;
- timeout threshold adapts to worker event-loop lag;
- reconnect happens only from the worker context.

This preserves the E.5 protocol correction while removing main-loop timer coupling.

## IPC Contract

Worker to main:

- parsed market records plus precomputed parse metrics;
- gap/reconnect/breaker events;
- queue depth and overflow notices;
- heartbeat snapshots per shard.

Main to worker:

- set token IDs / condition IDs;
- close.

The worker sends raw parsed records rather than full market snapshots. The main thread remains the
only writer of the canonical pricing cache.

## Configuration

- `WS_WORKER_COUNT`: max number of market shards backed by workers.
  - Default: `20`.
  - Production compose: `10`.
  - `0` disables market worker shards and falls back to the legacy in-process market WS path.

Decision worker configuration remains separate:

- `ALGO_DECISION_WORKER_COUNT`
- `ALGO_DECISION_WORKER_BATCH_SIZE`

## Monitoring

`market_data_stream_activity.wsHeartbeat` is exposed through runtime metrics and
`GET /api/v1/metrics/coverage` as `ws_heartbeat`.

Dashboard coverage card now shows:

- heartbeat PING/PONG counters;
- timeout count;
- worker event-loop lag max.

Success metrics after deploy:

- market WS pong-timeouts trend to zero or near-zero;
- WS tracked stays at 5000;
- decision tick p95 remains below 30s;
- V4 admission telemetry remains in the expected band;
- worker event-loop lag remains materially below main loop stalls.

## Migration

No DB migration is required.

The deploy changes process topology only. Existing stream interfaces are preserved.

## Rollback

Fast config rollback:

```bash
WS_WORKER_COUNT=0
```

Then restart runtime. This disables market worker shards. If user WS worker specifically causes
issues, revert this ADR commit and redeploy.

Full rollback:

```bash
git revert <phase-f-commit>
./deploy.sh
```

Auto-rollback remains disabled per Phase A. Alerts are visibility-only; human watcher decides
manual rollback.

## Known Limitations

- Market workers still IPC parsed records to the main thread. If IPC becomes the next bottleneck,
  the next optimization is binary/transferable packing or a shared-memory market-state ring.
- User WS worker heartbeat telemetry is routed through worker events but not yet shown as a separate
  dashboard card because current production pain is market shard pong-timeouts.
- The main thread remains the canonical market cache writer to avoid cross-thread mutable state.
