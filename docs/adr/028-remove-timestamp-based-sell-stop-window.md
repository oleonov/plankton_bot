# ADR-028 - Remove timestamp-based SELL stop window

## Status

Accepted - 2026-05-15

## Context

Commit `49c3d111` (2026-05-08, "Implement mode-aware sell order lifetimes")
introduced `resolutionStopWindowMs = 1h` and a SELL placement skip when
`endMs - nowMs <= resolutionStopWindowMs`. No ADR documented the choice.
No spec evidence supported the 1h value. The same commit introduced mode
classification, documented as an inference jump in
`research_plankton/plankton-analysis/observation_vs_implementation_gap.md`.

ICEMAN incident (2026-05-15) demonstrated impact:

- Position with avg_buy `$0.0357`, profit_ratio `3.19x`.
- D8 profit-target fired 9,703 times.
- Zero SELL orders placed; all blocked by resolution-stop-window.
- Market `closed: false, acceptingOrders: true` per Gamma API.

R87 evidence (Plankton observed SELL fills relative to `end_date`):

- 486 / 36,710 (1.32%) SELL fills after nominal `end_date`.
- 600 SELL fills in `[-1h, 0]` (our stop window).
- Cheap D8 SELL fills after `end_date`: 164 / 4,188 (3.92%).
- Median post-end SELL lag: 0.28 days; max 154 days.

Spec review confirmed `[OBSERVATION_NOT_FOUND]` for the 1h window: inference
jump from observed `endDate` field semantics, not Plankton behavior.

## Decision

### D1 - Remove SELL placement skip on timestamp basis

`shouldSkipSellInsideOrderLifetimeStopWindow` is removed from the
signal-to-order pipeline. SELL placements proceed regardless of nominal
`end_date` timestamp.

### D2 - Remove timestamp-based TTL stop in resolveResolutionLimit

`resolveResolutionLimit` no longer returns a hard stop on
`timeToEndMs <= resolutionStopWindowMs`. Existing orders are not cancelled
solely because nominal `end_date` is inside the old stop window or already
past.

### D3 - Rely on hard-liveness check for actual market state

`isAlive(market)` in signal-to-order already validates `acceptingOrders`,
`enableOrderBook`, and `bestBid`. This is the authoritative gate for "can we
trade right now".

### D4 - Preserve resolutionAggressiveWindowMs

`resolutionAggressiveWindowMs = 6h` and `resolutionExitTtlCapMs = 10min`
remain in effect. These provide tightened TTL near resolution without blocking
SELL placement.

### D5 - Keep resolutionStopWindowMs config field as deprecated

`resolutionStopWindowMs` remains in the `ExecutionPolicy` interface for
backward compatibility with existing DB `profile_settings`. No SELL placement
or TTL hard-stop code path uses it after this change.

## Consequences

- ICEMAN-style cases fire D8 / D7 / D5 SELLs normally even when past nominal
  `end_date` if Polymarket still reports the market as tradable.
- Markets actually closed or resolved are still blocked by hard-liveness
  (`acceptingOrders=false`, `enableOrderBook=false`, or `bestBid=null`).
- Some orders may be attempted on markets that resolve between placement and
  fill; CLOB rejection remains a soft failure path.
- Restores the post-end and final-hour SELL opportunities measured in R87.

Operational follow-up: после deploy метрика skip count
`order-lifetime-resolution-stop-window` и cancel reason
`resolution_stop_window` идут на ноль для новых orders. Historical rows в
`risk_events` и `orders.cancel_reason` остаются нетронутыми. Existing
dashboards/SLO, наблюдающие за этими значениями, увидят silence в новых данных.
Никаких code dependencies не сломано — только observability series.

Cancel reason taxonomy shift: в зоне `timeToEndMs ∈ (0, safetyBufferMs]`
cancelReason изменился с `"end_date_safety_buffer"` на `"ttl_exceeded"`.
Семантически эквивалентно — buffer cap отключён по D2, aggressive cap
(`resolutionAggressiveWindowMs`) доминирует. Existing consumers не нарушаются
(cancelReason union не используется в decision logic, только в telemetry).

## References

- R87: `research_plankton/plankton_post_enddate_trading_R87_report.md`
- Archeology: `resolution_stop_window_archeology_2026-05-15.md`
- Spec review: `research_plankton/spec_review_resolution_stop_window_2026-05-15.md`
- Observation gap:
  `research_plankton/plankton-analysis/observation_vs_implementation_gap.md`
- ADR-025: `docs/adr/025-step8-order-lifetime-cancellation.md`
