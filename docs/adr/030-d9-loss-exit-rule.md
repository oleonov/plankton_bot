# ADR-030 - D9_LOSS_EXIT rule

## Status

Accepted, deployed 2026-05-17T06:58:14Z.

- Classifier deploy: commit `8b5900f` (`v040`) at
  `2026-05-17T05:13:52Z`.
- First D9 logic + data pipeline reached `master` in commits `5f1be88`
  and `e9aba4d`; production activation was `2026-05-17T01:34:17Z`,
  followed by config rollback at `2026-05-17T04:06:36Z` after the
  aggregated UNKNOWN rejection threshold was exceeded.
- v041 deploy: commit `1449cde` at `2026-05-17T05:54:52Z`, activated
  `2026-05-17T06:03:30Z`, rolled back `2026-05-17T06:34:34Z` after the
  first post-only-cross pre-submit guard used the wrong book-side
  inequality.
- v042 final deploy: commit `b4b281b` at `2026-05-17T06:50:11Z`,
  activated `2026-05-17T06:58:14Z`; one-hour monitoring passed.

## Context

Closed bot positions in the `$0.20-$0.50` bucket showed `0/14` win-rate.
R94 found that Plankton's historical no-SELL hold-to-resolve cohort had
only `3.05%` REDEEM-inferred win-rate, with `1,781` inferred loser
positions. This made the bot's no-loss-exit gap explicit: D6 could hold
S2 positions with `buy_count >= 4` absolutely, and there was no
profit-ratio-aware exit path for liquid losing positions.

## Formula

D9 fires when all conditions are true:

```text
state in [S1, S2]
AND avg_buy_price > 0
AND profit_ratio < 1.0
AND public_trade_count_24h >= 41

profit_ratio = current_price / avg_buy_price
avg_buy_price = cumulative_buy_notional / cumulative_buy_size
```

Production v3 uses no fixed post-BUY-fill SELL cooldown:

```text
postBuyFillSellCooldownMs = 0
```

## Analytical evidence

R94 (`research_plankton/plankton_holding_drawdown_R94_report.md`):

- Hold-to-resolve no-SELL positions: `2,299`.
- REDEEM-inferred resolved coverage: `1,837 / 2,299 = 79.90%`.
- REDEEM-inferred winners: `56`; losers: `1,781`.
- Hold-to-resolve win-rate: `3.05%`.
- R94 replay S2 SELL fills: `559 / 1,338 = 41.78%`; S2 loss exits with
  `profit_ratio < 1`: `87 / 559 = 15.56%`.

R95 (`research_plankton/plankton_loss_exit_calibration_R95_report.md`):

- Strict CUT sample (`profit_ratio < 0.95`): `n=4,555`.
- HOLD loser sample: `n=1,781`.
- HOLD midlife price-history feature coverage:
  `4 / 1,781 = 0.22%`.
- R95 was inconclusive and recommended R96 backfill because true
  HOLD-side market snapshots were too sparse.

R96 backfill (`research_plankton/r96_backfill_completion_2026-05-16.md`):

- Backfill wall-clock: `1h 21m 40s`.
- Rows inserted/replaced: `604,066`.
- Covered R95 cohort pairs after backfill: `1,781 / 1,781`.
- Total rows for the R95 cohort after backfill: `604,728`.

R96 (`research_plankton/plankton_loss_exit_boundary_R96_report.md`):

- HOLD decision opportunities reconstructed from real price-history
  points: `573,192`.
- Q3 selected non-degenerate 2D rule:
  `(profit_ratio <= 1.0000) AND (public_trade_count_24h >= 41.0000)`.
- Metrics on `n=4,555` CUT vs `n=573,192` HOLD opportunities: balanced
  accuracy `76.62%`, CUT recall `69.43%`, HOLD specificity `83.80%`,
  confusion `TP=3,091; FN=1,361; FP=92,846; TN=480,309`.
- The time/liquidity OR rule reached `80.42%` balanced accuracy, but R96
  flags its time-to-end branch as partly a cohort-support separator: HOLD
  loser lifetime max was `43.44d`, while CUT included longer-horizon rows.
- R96 Q4 state-conditional support:
  - S1: CUT `n=21`, HOLD `n=268,022`, best profit balanced accuracy
    `73.47%`.
  - S2: CUT `n=2,045`, HOLD `n=305,170`, activity balanced accuracy
    `74.00%`, profit balanced accuracy `68.91%`.
  - S3: CUT `n=2,489`, HOLD `n=0`; S3 could not be calibrated as a
    HOLD-vs-CUT state.

R97 (`research_plankton/plankton_post_buy_sell_timing_R97_report.md`):

- Same-position consecutive BUY -> SELL adjacencies: `18,748` total,
  including `327` same-second adjacencies.
- Cross-condition wallet-level BUY -> SELL adjacencies: `17,473` total,
  including `1,347` same-second adjacencies.
- Same-second BUY -> SELL adjacencies across Q1 and Q3: `1,674`.
- Positive Q1-Q3 pairs with `1s <= delta < 5s`: `3,497`.
- Verdict: no positive cooldown boundary observed; no R-derived fixed
  cooldown candidate.

## Numerical derivations

- `public_trade_count_24h >= 41`: R96 Q3 selected 2D rule,
  `(profit_ratio <= 1.0000) AND (public_trade_count_24h >= 41.0000)`,
  with balanced accuracy `76.62%`.
- `state in [S1, S2]`: R96 Q4 state-conditional calibration. S1 and S2
  had both CUT and HOLD support; S3 had `0` HOLD samples and OTHER was
  too sparse.
- `profit_ratio < 1.0`: mathematical loss definition, implemented as a
  strict less-than check so break-even or profitable positions remain
  outside D9.
- `postBuyFillSellCooldownMs = 0`: R97 rejected a fixed Plankton-mirror
  cooldown because same-second and 1-5s Plankton BUY -> SELL adjacencies
  were present.

## Decision

Use D9_LOSS_EXIT as the loss-exit path for liquid losing positions:

```text
fire D9 if:
  state in lossExit.states
  AND cumulative_buy_size > 0
  AND cumulative_buy_notional / cumulative_buy_size > 0
  AND current_price / avg_buy_price < 1.0
  AND public_trade_count_24h >= lossExit.minPublicTradeCount24h
```

Current production activation:

- `lossExit.enabled: true`
- `lossExit.states: ["S1", "S2"]`
- `lossExit.minPublicTradeCount24h: 41`
- `postBuyFillSellCooldownMs: 0`

Repository default remains disabled:

- `DEFAULT_LOSS_EXIT_POLICY.enabled: false`

This preserves config-only rollback while documenting the deployed
production profile as the accepted D9 v3 state.

## Alternatives considered

- S2-only state-conditional rule: rejected as primary formula because R96
  Q4 S2 profit balanced accuracy was `68.91%`, weaker than the selected
  R96 Q3 cross-state rule.
- Time-to-end OR public activity rule:
  `(time_to_end_days >= 38.5970) OR (public_trade_count_24h >= 72.0000)`
  reached `80.42%` balanced accuracy in R96, but R96 marked the
  time-to-end branch as partly a cohort-support separator because HOLD
  lifetime max was `43.44d`.
- Max-drawdown high-recall rule:
  `(profit_ratio <= 1.0000) AND (max_drawdown_to_decision >= -0.8671)`
  reached `72.59%` balanced accuracy and `95.52%` CUT recall in R96, but
  with only `49.65%` HOLD specificity.
- Cost-basis SELL pricing anchor: rejected by R93 for pricing, not D9
  eligibility; avg-buy-only Model B had `R2 = 0.889`, below midpoint
  Model A `R2 = 0.976`.
- Fixed post-BUY cooldown: rejected by R97 because Plankton showed
  `1,674` same-second BUY -> SELL adjacencies across same-position and
  cross-condition streams.
- Composite midpoint + avg_buy pricing: rejected in ADR-029; R93 Model C
  improved over midpoint-only by only `0.0016 R2`.

## Implementation

- D9 evaluator: `packages/domain/src/d9-loss-exit.ts`
  - line `31` documents the R96-derived formula.
  - line `45` defines `evaluateD9LossExit`.
  - lines `49-70` enforce state, avg-buy availability, loss condition,
    public trade-count availability, and public trade-count threshold.
- Default config: `packages/domain/src/execution-policy.ts`
  - lines `140-149` define `DEFAULT_LOSS_EXIT_POLICY`, default disabled,
    states `["S1", "S2"]`, and threshold `41`.
- Public trade count provider:
  `packages/exchange/src/data-api-trade-count-provider.ts`
  - line `147` defines `fetchPublicTradeCount24h`.
  - lines `157-176` fetch public trades and count the last 24h rows.
- Snapshot persistence:
  `packages/db/src/migrations/058_market_snapshots_public_trade_count_24h.sql`
  - line `1` adds `market_snapshots.public_trade_count_24h`.
- Algo wiring:
  `apps/runtime/src/modules/algo-decision/algo-decision-module.ts`
  - lines `1305-1307` document that D9 runs after D8 and before static
    D-rules.
  - lines `1311-1319` call `evaluateD9LossExit`.
  - lines `1321-1337` emit `ruleId: "D9_LOSS_EXIT"`.
- Execution downstream fix:
  `apps/runtime/src/modules/execution/execution-module.ts`
  - lines `1286-1294` implement the corrected post-only-cross pre-submit
    inequality for SELL orders: `submit_price <= currentBestBid -> skip`.

## Deployment monitoring

Evidence:

- `research_plankton/deploy_d9_baseline_M0.md`
- `research_plankton/deploy_d9_monitoring_M0-M6.md`
- `research_plankton/d9_unknown_rejection_diagnostic_2026-05-17.md`
- `research_plankton/deploy_d9_v2_baseline_M0.md`
- `research_plankton/deploy_d9_v2_monitoring_M0-M3_rollback.md`
- `research_plankton/deploy_d9_v3_baseline_M0.md`
- `research_plankton/deploy_d9_v3_monitoring_M0-M6.md`

v1 activation:

- Activated `2026-05-17T01:34:17Z`.
- Rolled back `2026-05-17T04:06:36Z`.
- Diagnostic found `6` D9 UNKNOWN/no-order-id rejections: `2`
  balance/allowance zero, `2` minimum-size errors, and `2` invalid
  post-only crosses.

v2 activation:

- v041 deployed `2026-05-17T05:54:52Z`, activated
  `2026-05-17T06:03:30Z`.
- Rolled back `2026-05-17T06:34:34Z`.
- M3 showed `11,873` D9 signals, `0` D9 orders, `0` fills, and `2,499`
  post-only-cross pre-submit skips in the last 10m.

v3 final activation:

- v042 deployed `2026-05-17T06:50:11Z`, activated
  `2026-05-17T06:58:14Z`.
- One-hour monitoring passed.
- M6 totals: `31,280` D9 signals, `10` D9 orders, `1` D9 fill, `2`
  balance-insufficient rejects, `48` post-only-cross pre-submit skips.
- Post-only skips were `48 / 31,280 = 0.15%`.
- Real `rejection_unknown`: `0`; classifier-null rejection rows: `0`.

## Open questions

- Low signal-to-order conversion (`31,280 -> 10`) is downstream gate
  behavior in the v3 monitoring window. TTL, same-price-open-SELL, and
  order capacity gates were not decomposed in ADR-030.
- `rejection_balance_insufficient` appeared `2` times in the v3
  monitoring window (`2 / 31,280 = 0.006%` of D9 signals). R97 rejects a
  fixed cooldown as a Plankton-mirror rule; a retry mechanism would need
  separate evidence if this tail grows.
- Long-horizon positions are extrapolation: R96 HOLD loser lifetime max
  was `43.44d`; positions with `time_to_end > 90d` are outside the HOLD
  support range.
- Wide-spread D9 behavior is undercalibrated. R91/R92 wide-spread samples
  are small, and R96 did not fit a spread-conditional D9 rule.

## Inference jumps

- HOLD-side decision opportunities are reconstructed from real
  price-history points, not direct Plankton decision ticks. R70/R92
  observer limits still apply: unfilled orders, order_id ownership, and
  direct placement attribution are not observable.
- `public_trade_count_24h` is an activity/liquidity proxy. It does not
  encode order-book depth, queue position, order-size distribution, or
  external/social/news signals that may have affected Plankton exits.
- D9 is a threshold classifier from observed CUT fills versus
  reconstructed HOLD opportunities. It is not a proof of Plankton's
  internal rule.

## References

- R94: `research_plankton/plankton_holding_drawdown_R94_report.md`
- R95: `research_plankton/plankton_loss_exit_calibration_R95_report.md`
- R96: `research_plankton/plankton_loss_exit_boundary_R96_report.md`
- R96 backfill:
  `research_plankton/r96_backfill_completion_2026-05-16.md`
- R97: `research_plankton/plankton_post_buy_sell_timing_R97_report.md`
- Spec: `docs/spec/loss-exit-rule.md`
