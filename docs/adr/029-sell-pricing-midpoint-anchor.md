# ADR-029 - Plankton-mirror SELL pricing: midpoint+5-ticks anchor

## Status

Accepted, deployed 2026-05-15T12:36:53Z.

- Code deploy: commit `b498b00c7c870a2878f837ab9c163f17224c6830`
  (`v037`) at `2026-05-15T12:36:53Z`.
- Config activation: `2026-05-15T12:49:01Z`, execution policy version
  `30 -> 31`.

## Context

Closed bot positions in the `$0.20-$0.50` bucket showed `0/14` win-rate
and total realized PnL `-$187.7`. Plankton in the same bucket showed
`81%` win-rate and `+$5,094`. The deployed SELL pricing path was
bid-anchored (`bid + 4 ticks`), which did not match observed Plankton
SELL fill behavior.

## Analytical evidence

R90 (`research_plankton/plankton_sell_pricing_formula_R90_report.md`):

- `1,338` matched SELL fills with book / midpoint / ask reconstruction.
- Midpoint-only regression: `R2 = 0.974`, coefficient `0.998`,
  intercept `0.005`.
- Midpoint + spread regression: `R2 = 0.975`, only marginal improvement.

R91 (`research_plankton/plankton_sell_pricing_calibration_R91_report.md`):

- Distribution of `fill / midpoint` by spread bucket:
  - `<10` ticks: `1.05` (`75%` of all fills)
  - `10-25`: `1.08`
  - `25-50`: `1.17`
  - `50-100`: `1.03` (`n=24`)
  - `100-200`: `0.89` (`n=5`)
  - `>200`: `0.87` (`n=4`)
- `775/850 = 91.18%` of spread_ticks-covered fills were below `25`
  ticks, and `817/850 = 96.12%` were below `50` ticks. In the `<10`
  tick bucket (`74.47%` of spread_ticks-covered fills),
  `midpoint + 5 ticks` is at or near the ask.

R92 (`research_plankton/plankton_wide_spread_placement_R92_report.md`):

- Maker/taker reconstruction was indeterminate for all wide-spread rows:
  `0 maker / 0 taker / 31 indeterminate`, due to sparse `price_change`
  events in observer shards.
- Q4: `81%` of wide-spread fills were below ask, and `55%` were at or
  above midpoint.
- Confirmed the R70 caveat: the observer does not provide order-placement
  attribution.

R93 (`research_plankton/plankton_sell_pricing_decomposition_R93_report.md`):

- Hypothesis verdicts:
  - cost-basis anchor: rejected (`Model B R2 = 0.889`)
  - size dependency: rejected (`range = 0.046`)
  - time-to-end gradient: supported, weak coverage (`339/1,338 = 25%`)
  - sequential decay: rejected (`40.5%` flat, `23.7%` growing,
    `35.8%` declining)
  - round-number bias: supported, likely artifact of repeated positions
  - depth-aware sizing: rejected
- Model A on `n=1,256`: `fill = 0.004868 + 1.000947 * midpoint`,
  `R2 = 0.976`.

## Decision

SELL price is:

```text
result = floor(min(midpoint + 5 * tick_size, bestAsk) / tick_size)
       * tick_size

midpoint = (bestBid + bestAsk) / 2
```

Where:

- `5` is derived from R93 Model A intercept `0.004868` divided by
  standard `tick_size = 0.001`.
- Cap at `bestAsk`: SELL does not exceed current ask.
- Floor to tick: exchange tick-grid constraint.

Configuration:

- `exitPricingMode: "midpoint-anchored"`
- `exitMidpointAnchorTicks: 5`

The old bid-anchored configuration (`bid + 4 ticks`) is preserved as a
rollback option through config only, without code revert.

## Alternatives considered

All alternatives below were rejected through R93:

- Cost-basis anchor (`fill = avg_buy * markup`): `R2 = 0.889`
  (Model B). Plankton does not anchor primarily to its entry price.
- Last-trade anchor (`fill = last_trade_price * markup`): `R2 = 0.935`
  (Model E), weaker than midpoint.
- Composite midpoint + avg_buy: `R2 = 0.978` (Model C). Improvement over
  Model A was only `0.0016`, not enough to justify the additional
  feature.
- Size-dependent placement: `fill / midpoint` range across size buckets
  was `0.046`, essentially flat.
- Sequential price decay / stair-step: `40.5%` flat pairs, `35.8%`
  declining, `23.7%` growing. No systematic decay pattern.
- Depth-aware placement: range across depth buckets was `0.040`.

## Open questions

- Wide-spread tail (`>200` ticks, `n=4` in R91/R92) is undercalibrated.
  The current formula may be suboptimal there, but this tail is `<0.5%`
  of all observed SELL fills.
- Time-to-end gradient (R93 Q4) is supported as a second-order signal
  with `25%` coverage (`339/1,338`). It is not part of ADR-029. A future
  ADR may evaluate conditional exit behavior; D9 loss-exit work is tracked
  separately for ADR-030 after that code PR is deployed and monitored.
- This formula is an inference from observable fills, not a direct
  placement observation. R92 could not classify maker/taker behavior for
  the wide-spread sample. See
  `research_plankton/plankton-analysis/observation_vs_implementation_gap.md`.

## Implementation

- Code: `apps/runtime/src/modules/strategy/signal-to-order.ts`
  - `b498b00`: line `1077` calls `resolveMidpointAnchoredSellPrice`.
  - `b498b00`: line `1430` defines `resolveMidpointAnchoredSellPrice`.
- Tick/executable helpers: `apps/runtime/src/executable-price.ts`
  - `b498b00`: line `151` defines `floorToTick`.
  - `b498b00`: line `37` defines `validateExecutablePrice`.
- Config: `packages/domain/src/execution-policy.ts`
  - `b498b00`: line `203` defaults `exitPricingMode` to
    `"midpoint-anchored"`.
  - `b498b00`: line `210` defaults `exitMidpointAnchorTicks` to `5`.
  - `b498b00`: lines `340-361` parse `exitPricingMode` and
    `exitMidpointAnchorTicks`.
- Types: `packages/domain/src/types.ts`
  - `b498b00`: lines `829` and `833` expose `exitPricingMode` and
    `exitMidpointAnchorTicks`.
- Tests: `apps/runtime/src/__tests__/signal-to-order-bridge.test.ts`
  - `b498b00`: line `31` starts the midpoint helper test block.
  - `b498b00`: line `1546` verifies default SELL edge branch uses
    midpoint-anchored pricing.
- Deployed: `2026-05-15T12:36:53Z` (`v037`, commit `b498b00`).
- Activated: `2026-05-15T12:49:01Z`, execution policy version `30 -> 31`.

## Deployment monitoring

Evidence:
`research_plankton/deploy_midpoint_anchor_baseline_M0.md` and
`research_plankton/deploy_midpoint_anchor_monitoring_M0-M6.md`.

- Pre-deploy M0 (`2026-05-15T12:31:38Z`): last-hour SELL fill rate
  `3/22 = 13.6%`, `0` midpoint-anchored decisions, `12` bid-anchored
  SELL decisions.
- Config activation (`2026-05-15T12:49:01Z`): profile reloaded from
  execution policy version `30` to `31`.
- Activation monitoring window (`2026-05-15T12:49:01Z` to
  `2026-05-15T13:49:01Z`): `639` midpoint-anchored SELL decisions,
  `0` bid-anchored SELL decisions, `17` SELL orders placed, `6` SELL
  fills, `0` SELL rejects, `0` exchange UNKNOWN/no-order-id errors.
- One-hour monitoring passed with post-activation SELL fill rate
  `6/17 = 35.3%`.
- ICEMAN verification passed: observed active SELL at `0.056`; structured
  placement logs verified midpoint+5 or ask-cap behavior, including
  `midpoint 0.053 + 5 * 0.001 = 0.058`, capped at ask `0.056`.

## References

- R90: `research_plankton/plankton_sell_pricing_formula_R90_report.md`
- R91: `research_plankton/plankton_sell_pricing_calibration_R91_report.md`
- R92: `research_plankton/plankton_wide_spread_placement_R92_report.md`
- R93: `research_plankton/plankton_sell_pricing_decomposition_R93_report.md`
- Spec: `docs/spec/sell-pricing.md`
