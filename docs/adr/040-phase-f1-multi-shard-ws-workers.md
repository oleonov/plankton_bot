# ADR-040: Phase F.1 Multi-Shard WS Workers

Date: 2026-05-20

## Context

Phase F moved market WebSocket handling into a worker-per-shard topology:

```text
10 shard sockets -> 10 Node worker threads -> main thread
```

Production deploy `v052` OOM-killed twice under the 2 GiB runtime cgroup. The memory
diagnostic (`research_plankton/phase_f_memory_diagnostic_2026-05-20.md`) found:

- active v052 RSS reached `1379 MiB` while main-thread `heapUsed` was only `155 MiB`;
- active WorkerThread count moved from `3` paused to `13` active;
- the 10 market WS workers were the dominant delta;
- estimated market WS worker cost was `110-165 MiB` per worker;
- 10 workers could consume `1.1-1.65 GiB` before main runtime, decision worker, buffers,
  and caches.

The failure was architectural: worker-per-shard preserved heartbeat isolation but did not
fit the memory budget.

## Decision

Replace worker-per-shard with a bounded multi-shard worker topology:

```text
Before:
  shard 0 -> worker 0
  shard 1 -> worker 1
  ...
  shard 9 -> worker 9

After:
  shard 0 -> worker 0
  shard 1 -> worker 1
  shard 2 -> worker 2
  shard 3 -> worker 3
  shard 4 -> worker 0
  shard 5 -> worker 1
  shard 6 -> worker 2
  shard 7 -> worker 3
  shard 8 -> worker 0
  shard 9 -> worker 1
```

`WS_WORKER_COUNT` now means "number of market WS worker groups", not "number of
worker-backed shards". `WS_WORKER_COUNT=0` remains the kill-switch and falls back to
main-thread WS handling.

Production config target:

```text
MARKET_DATA_MAX_TRACKED_TOKENS=5000
MARKET_DATA_MAX_WS_SHARDS=10
WS_WORKER_COUNT=4
```

Rationale:

- 4 workers preserve heartbeat isolation for all 10 shard sockets.
- Expected WS worker RSS budget: `4 * ~110-165 MiB = ~440-660 MiB`.
- Total runtime target remains below `1.8 GiB` with room for main runtime, decision worker,
  persistence worker, user WS worker, buffers, and caches.
- 2 workers is safer on memory but increases per-worker socket concentration; 4 is the
  better initial balance.

## Compact IPC

Phase F cloned raw parsed WS records from workers to the main thread. Phase F.1 changes
worker IPC:

- worker parses raw WS payloads;
- worker converts records into compact `MarketPricingStreamUpdate` and lifecycle batches;
- worker serializes each compact batch into an `ArrayBuffer`;
- parent receives one transferable buffer and applies already-normalized updates.

This keeps raw payload parsing and record normalization in the worker and avoids cloning
large raw object graphs through `postMessage`.

## Memory Budget Enforcement

Each market WS worker is spawned with Node worker resource limits:

```text
maxOldGenerationSizeMb = 200
maxYoungGenerationSizeMb = 32
```

The limits do not cap native/socket memory, but they bound worker JS heap and fail a worker
before the whole process silently grows without telemetry.

Workers emit memory telemetry every 10 seconds:

- RSS MiB
- heap used / total MiB
- external memory MiB
- array buffer memory MiB
- heap limit MiB

The aggregate is exposed as:

- runtime metric `market_data_stream_activity.labels.wsWorkerMemory`
- API field `/api/v1/metrics/coverage.ws_worker_memory`
- operator dashboard coverage card

Workers also emit a structured memory warning when worker RSS exceeds `250 MiB`.

## Worker Recovery

Each worker group keeps the desired token set per shard in the parent process. If a worker
thread exits unexpectedly, the parent:

1. records `connect-failed` gaps for the affected shards;
2. starts a replacement worker with the same resource limits and stagger settings;
3. replays each shard's desired token set to the replacement worker.

This keeps failure blast radius bounded to the shards assigned to that worker group. A
worker-level memory warning is reported as telemetry/error only and does not force an
automatic reconnect by itself.

## Spawn Strategy

Worker process creation is bounded by `WS_WORKER_COUNT`. Within each worker, connection
activation is staggered:

```text
worker 0 start delay = 0 ms
worker 1 start delay = 750 ms
worker 2 start delay = 1500 ms
worker 3 start delay = 2250 ms
```

This avoids a synchronized 10-shard subscription burst while preserving the same target
coverage after startup.

## Heartbeat Isolation

Heartbeat logic remains inside the WS worker context:

- PING/PONG handling;
- `lastInboundMessageAt`;
- adaptive timeout based on worker event-loop lag;
- per-shard heartbeat snapshots;
- per-shard reconnect/backoff/breaker state.

Main-thread stalls do not directly delay heartbeat timers for market WS shards.

## Migration Path

No schema migration is required.

Config-only operator paths:

- `WS_WORKER_COUNT=4`: default Phase F.1 topology.
- `WS_WORKER_COUNT=2`: lower memory test topology.
- `WS_WORKER_COUNT=0`: kill-switch, main-thread WS fallback.

## Rollback

Rollback options:

1. Config rollback:
   - set `WS_WORKER_COUNT=0`;
   - restart runtime;
   - resume only after memory remains stable.
2. Code rollback:
   - revert the Phase F.1 commit;
   - redeploy v051/v050-equivalent behavior if needed.

## Expected Metrics

Target post-deploy:

| Metric                   |                             Target |
| ------------------------ | ---------------------------------: |
| Total runtime RSS        |              `< 1.8 GiB` sustained |
| Aggregate WS worker RSS  |              `< 800 MiB` sustained |
| Max single WS worker RSS |              `< 250 MiB` sustained |
| WS tracked tokens        |                             `5000` |
| Pong timeouts            |                   `0` or near-zero |
| Decision tick p95        | remains `< 30s`, ideally E.3-level |
| V4 admit rate            |            remains in `[10%, 30%]` |

## Open Questions

- Live RSS must still be verified in a controlled deploy because local tests cannot
  reproduce Polymarket's production WS stream volume without touching production.
- If `WS_WORKER_COUNT=4` exceeds memory budget in production, the next safe config is
  `WS_WORKER_COUNT=2`.
- Further IPC reduction is possible by replacing JSON-encoded update buffers with a
  binary schema, but this is not required before first F.1 validation.
