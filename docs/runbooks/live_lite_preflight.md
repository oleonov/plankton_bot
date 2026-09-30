# Live-Lite Preflight Checklist

## Prerequisites

- [ ] Paper signoff complete (see `paper_signoff.md`)
- [ ] Selection rules seeded for the `live-lite` profile — verify via `GET /selection-rules?profileId=live-lite`
- [ ] Caps defined: max open value, max order, max active markets
- [ ] API credentials verified for exchange connectivity
- [ ] `control.db` + `ledger-live-lite.db` snapshot taken for rollback

## Config Verification

Verify these env vars are set:

| Env var                         | Expected value   |
| ------------------------------- | ---------------- |
| `RUNTIME_MODE`                  | `live-lite`      |
| `LIVE_LITE_CONFIRM`             | `true`           |
| `LIVE_LITE_MAX_OPEN_VALUE_USDC` | positive number  |
| `LIVE_LITE_MAX_ORDER_USDC`      | positive number  |
| `LIVE_LITE_MAX_ACTIVE_MARKETS`  | positive integer |
| `POLY_API_KEY`                  | set              |
| `POLY_API_SECRET`               | set              |
| `POLY_PASSPHRASE`               | set              |

## DB State Verification

- [ ] Review any existing positions in the DB
- [ ] Review any existing open orders in the DB
- [ ] Confirm no orphaned state from previous runs
- [ ] Confirm `selection_rules` for `live-lite` profile are the intended set (enabled + patterns)

## Credential Verification

- [ ] Verify `POLY_API_KEY` is set and non-empty
- [ ] Verify `POLY_API_SECRET` is set and non-empty
- [ ] Verify `POLY_PASSPHRASE` is set and non-empty
- [ ] Test API key connectivity: runtime boot will fail-closed if credentials are invalid (gateway healthCheck fails)
- [ ] Confirm credentials have appropriate permissions for order placement

## Fail Closed Conditions

The runtime will **exit immediately** if:

- Missing any cap env var (`MAX_OPEN_VALUE_USDC`, `MAX_ORDER_USDC`, `MAX_ACTIVE_MARKETS`)
- Missing `LIVE_LITE_CONFIRM=true`
- Missing API credentials (`POLY_API_KEY`, `POLY_API_SECRET`, `POLY_PASSPHRASE`)

## Startup Preflight Caps

- Combined exposure (positions + open buy order notional) over `maxOpenValueUsdc` is a blocker
  (`EXPOSURE_EXCEEDS_CAP`): startup fails.
- Held open markets over `maxActiveMarkets` only warn (`MARKETS_EXCEED_CAP`): startup continues
  so existing positions stay managed, and new-market BUYs stay blocked until the count is back
  under the cap.

## Steps

1. Set all env vars as shown above
2. Start runtime: `RUNTIME_MODE=live-lite node apps/runtime/dist/index.js`
3. Check logs for preflight results
4. If started paused: review violations, resolve, then resume via web UI
5. If started clean: verify web dashboard shows live-lite banner

## Abort Conditions

- Runtime exits on startup (fail-closed) → review error message, fix config
- Preflight finds >2 distinct violations → investigate before resuming
- API credential test fails → do not proceed

## Artifacts to Save

- [ ] `bot_run_id` from this session
- [ ] Timestamp/session window
- [ ] Active selection-rules set (`GET /selection-rules?profileId=live-lite`) + caps
- [ ] Preflight log output
- [ ] Screenshot of Overview page (showing envelope)
- [ ] Final `/api/v1/status` JSON snapshot

## Market-data socket / stream tuning (v103 + v104)

All knobs are defaulted to safe values and are **read once at process start** (container restart required to change). Leave unset unless an incident log points at the corresponding subsystem.

### Tiered pricing universe (Task 1)

| Key                                      | Default | Range        | Notes                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MARKET_DATA_MAX_TRACKED_TOKENS`         | 1000    | 100–5000     | Hard cap on the WS-subscribed universe (executionCritical + entryCandidates).                                                                                                                                                                                                                                                       |
| `MARKET_DATA_MAX_WS_SHARDS`              | 2       | 1–20         | Target cap on concurrent WS shards. At wiring time the gateway computes `maxSubscriptionsPerConnection = min(500, ceil(MAX_TRACKED_TOKENS / MAX_WS_SHARDS))`; the stream re-clamps to the 500/shard Polymarket hard ceiling, so oversizing the tracked universe adds more shards rather than exceeding 500 subs on a single socket. |
| `MARKET_DATA_DISCOVERY_POLL_INTERVAL_MS` | 300000  | 10000–600000 | Rolling poll cadence for the discovery tier (tokens beyond the WS cap).                                                                                                                                                                                                                                                             |
| `MARKET_DATA_DISCOVERY_BATCH_SIZE`       | 50      | 50–500       | Tokens per discovery poll cycle. Keeps each HTTP request small.                                                                                                                                                                                                                                                                     |

### CLOB axios HTTPS agent (Task 2)

| Key                           | Default | Range       | Notes                                                                           |
| ----------------------------- | ------- | ----------- | ------------------------------------------------------------------------------- |
| `CLOB_AXIOS_MAX_SOCKETS`      | 8       | 1–32        | Ceiling on concurrent HTTPS connections to Polymarket CLOB/Gamma.               |
| `CLOB_AXIOS_MAX_FREE_SOCKETS` | 2       | 0–16        | Idle pool size. Lower = fewer ESTAB against Cloudflare edges when bot is quiet. |
| `CLOB_AXIOS_IDLE_TIMEOUT_MS`  | 30000   | 5000–120000 | How long to keep idle sockets before closing them. Lower = faster sock reclaim. |

### Ingress backpressure (Task 3)

| Key                                   | Default       | Range                        | Notes                                                                    |
| ------------------------------------- | ------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `MARKET_DATA_INGRESS_QUEUE_MAX`       | 256           | 32–2048                      | Per-shard bounded queue depth. Overflow triggers the policy below.       |
| `MARKET_DATA_INGRESS_LAG_WARN_MS`     | 2000          | 500–10000                    | Emit a warn log if a queued message waits longer than this before drain. |
| `MARKET_DATA_INGRESS_OVERFLOW_POLICY` | `drop-oldest` | `drop-oldest` \| `reconnect` | What to do when the queue is full. `drop-oldest` preserves freshness.    |

### Per-shard + stream-level circuit breaker (Task 4)

Per-shard breaker: each WS shard tracks its own reconnect rate; if it exceeds `RECONNECTS_PER_MIN` inside 60 s, that shard's breaker opens for `OPEN_MS` (exponentially backed off up to `OPEN_MAX_MS` on re-opens within a stable window). The shard's tokens are routed through `pendingGapTokenIds` so the REST fallback path still feeds the execution layer.

Stream-level breaker: AND-gated quorum — fires **only** when both `openShards / totalShards ≥ SHARD_OPEN_PERCENT / 100` **AND** `openShards ≥ OPEN_SHARD_FLOOR`. On `shardCount ≤ 2` the default floor of 3 is unreachable by design; per-shard breakers handle the small-deployment case. Set `OPEN_SHARD_FLOOR=1` to opt in to stream-level fallback on tiny deployments.

| Key                                            | Default | Range         | Notes                                                           |
| ---------------------------------------------- | ------- | ------------- | --------------------------------------------------------------- |
| `MARKET_DATA_RECONNECT_BASE_MS`                | 1000    | 100–10000     | Base delay for per-shard exponential backoff (full jitter).     |
| `MARKET_DATA_RECONNECT_MAX_MS`                 | 30000   | 1000–120000   | Cap on per-shard reconnect delay.                               |
| `MARKET_DATA_SHARD_BREAKER_RECONNECTS_PER_MIN` | 10      | 3–60          | Threshold: reconnects/60 s that trips a shard's breaker.        |
| `MARKET_DATA_SHARD_BREAKER_OPEN_MS`            | 120000  | 10000–600000  | Initial open duration for a shard's breaker.                    |
| `MARKET_DATA_SHARD_BREAKER_OPEN_MAX_MS`        | 600000  | 60000–1800000 | Max open duration after repeated re-opens (exp. growth).        |
| `MARKET_DATA_CIRCUIT_SHARD_OPEN_PERCENT`       | 50      | 20–100        | Stream-level quorum: % of shards open.                          |
| `MARKET_DATA_CIRCUIT_OPEN_SHARD_FLOOR`         | 3       | 1–20          | Stream-level quorum: absolute floor (AND with percent).         |
| `MARKET_DATA_CIRCUIT_OPEN_MS`                  | 120000  | 10000–600000  | Stream-level breaker open duration.                             |
| `MARKET_DATA_STREAM_STABLE_MS`                 | 30000   | 5000–300000   | Stable window required before closing the stream-level breaker. |

### Capped rolling poll (Task 5)

| Key                               | Default | Range    | Notes                                                                        |
| --------------------------------- | ------- | -------- | ---------------------------------------------------------------------------- |
| `MARKET_DATA_FALLBACK_BATCH_SIZE` | 500     | 100–1000 | Defensive cap on each fallback/gap REST poll. Trims + warn-logs if exceeded. |

### Observability

- `sock` in `memory.stat` should stay ≤ 40 MiB steady (was 47→117 MiB over 30 min before v103).
- `memory.peak` should stay well under the `640m` cgroup cap (was breaching 520m).
- `ESTAB` connection count against Polymarket Cloudflare edges ≈ `CLOB_AXIOS_MAX_SOCKETS + CLOB_AXIOS_MAX_FREE_SOCKETS + shardCount` (axios HTTPS + WS shards share IPs; `ss` cannot split them).
- Lifecycle events emitted on the pricing stream (`queue_overflow`, `shard_circuit_open`, `shard_circuit_closed`, `stream_circuit_open`, `stream_circuit_closed`) are structured log records — grep for `lifecycle=` in runtime stdout.
