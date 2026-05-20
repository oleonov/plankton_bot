# ADR-038: Phase E.5 WS Heartbeat Correction and V4 Orderbook Proxy

Date: 2026-05-20

## Status

Accepted for reviewer handoff.

## Context

Phase E.4 attempted two narrow fixes after the Phase E.3 deploy:

1. WebSocket heartbeat payload was changed from `PING` to `{}`.
2. V4 admission changed missing liquidity from pass-on-null to reject-on-null.

Both changes backfired in production:

- Polymarket returned `INVALID OPERATION` for `{}` heartbeat payloads, and WS tracking collapsed.
- V4 admit rate dropped to 1.65%, below the 10-30% operating band.

Evidence:

- `research_plankton/ws_protocol_forensic_2026-05-20.md`
- `research_plankton/v4_null_handling_alternatives_2026-05-20.md`

The WS forensic isolated test showed that the CLOB websocket accepts text `PING` and responds with
text `PONG`. The V4 null-handling diagnostic showed that null liquidity is often an API artifact:
93.7% of null-liquidity markets still had active orderbook data. The selected alternative is Alt G,
using orderbook spread as a quality proxy when liquidity is missing.

## Decision

### WS Heartbeat

Use text `PING` as the heartbeat payload on both market and user WS streams, and keep `PONG` as the
expected heartbeat response.

The structured E.4 logging stays in place:

- `MARKET_WS_PONG_TIMEOUT`
- `USER_WS_PONG_TIMEOUT`
- market/user WS close code and close reason logs

### V4 Admission

Replace strict missing-liquidity rejection with a hybrid V4 predicate:

```text
category in HOT_CATS_40
AND (
  (liquidity >= 100 AND volume_24h >= 5)
  OR
  (best_bid != null AND best_ask != null AND (best_ask - best_bid) < 0.10)
)
```

`best_bid` and `best_ask` are taken from the latest `market_snapshots` row and plumbed into the V4
selection evaluator.

Add telemetry reason:

```text
rejected_no_orderbook_proxy
```

This records sparse-liquidity markets where the populated path fails and no tight orderbook proxy is
available.

## Expected Impact

- WS reconnects should return near the pre-E.4 behavior or better because the protocol payload is
  again accepted by Polymarket.
- V4 admit rate should move from 1.65% toward the diagnostic estimate of roughly 28.9%.
- Existing E.3 tick-latency gains should be unaffected.
- V4 telemetry remains sufficient to validate category and reject-reason behavior post-deploy.

## Rollback

Each change is a single-line behavioral rollback:

- WS: revert heartbeat payload from `PING` back to the prior payload if production evidence
  contradicts the forensic result.
- V4: revert the predicate to the prior populated-only liquidity/volume gate if the orderbook proxy
  admits an unsafe cohort.

Full rollback remains `git revert` plus redeploy. Auto-rollback remains disabled; human watcher mode
continues from Phase A.

## Monitoring

Post-deploy monitoring should track:

- market/user WS reconnects
- pong timeout counts
- close code distribution
- tracked token count and shard health
- V4 admit rate
- `rejected_no_orderbook_proxy`
- V4 admit count by category
- decision tick p95 and event-loop lag p95

## Known Limitations

- The orderbook proxy uses spread only. It does not validate book depth or last-trade freshness.
- Sparse snapshot coverage remains an upstream issue.
- The V4 slug/category proxy remains less precise than the research taxonomy.
