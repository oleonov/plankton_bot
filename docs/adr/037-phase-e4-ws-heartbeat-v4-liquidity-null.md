# ADR-037: Phase E.4 WS Heartbeat + V4 Liquidity Null Hot-Fixes

Date: 2026-05-20

## Status

Proposed

## Context

Phase E.3 + V4 deployed successfully fixed the main decision-loop bottleneck: decision tick
latency dropped from hundreds of seconds to millisecond-scale. Two narrow production issues remained:

1. WS reconnects and gap events continued after CPU pressure was removed. The post-E.3 diagnostic
   identified a heartbeat protocol mismatch: Krabs sent the literal string `PING`, while the
   Polymarket market WebSocket documentation specifies an empty JSON object heartbeat payload (`{}`).
2. V4 admission rate was materially above the target range. The V4 calibration diagnostic found
   that sparse production snapshots left liquidity null for many candidates, and the V4 evaluator's
   pass-on-null liquidity policy made the liquidity gate ineffective.

Evidence:

- `research_plankton/ws_reconnect_root_cause_post_e3_2026-05-20.md`
- `research_plankton/v4_calibration_diagnostic_2026-05-20.md`
- Polymarket market WSS documentation: `https://docs.polymarket.com/api-reference/wss/market`

## Decision

Phase E.4 applies two surgical fixes:

1. Market and user WebSocket heartbeat payloads now send `{}` instead of `PING`.
2. V4 liquidity gating now rejects missing liquidity: `liquidity == null || liquidity < 100`.

Volume handling is unchanged. Missing `volume_24h` still passes the volume gate so this hot-fix only
inverts the liquidity-null behavior recommended by the calibration diagnostic.

WS diagnostics are also made more explicit:

- Pong timeouts emit a distinct `pong-timeout` market gap reason.
- Pong timeouts log structured error details.
- Socket close logging includes close code, reason, shard/stream context, and subscribed count.

## Expected Metrics

- WS reconnects: from the post-E.3 elevated rate toward near zero if heartbeat mismatch was the
  dominant cause.
- V4 admit rate: from 52.32% toward roughly 9-11%, at the lower edge of the target range [10%, 30%].
- V4 reject reason telemetry should show increased `rejected_liquidity_below_100` counts, including
  null-liquidity candidates.

## Rollback

Both changes are single-line behavioral reverts:

- WS heartbeat rollback: change heartbeat payload constants from `{}` back to `PING`.
- V4 liquidity rollback: restore pass-on-null liquidity check.

If only one metric regresses, each fix can be reverted independently.

## Deferred

- Move WS parsing/normalization off the main thread if reconnects persist after heartbeat correction.
- Investigate snapshot pipeline coverage; the V4 calibration diagnostic found sparse liquidity
  availability upstream of the evaluator.
