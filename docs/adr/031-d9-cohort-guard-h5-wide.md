# ADR-031 - D9 H5_wide cohort guard

## Status

Draft for review - 2026-05-17

## Context

D9_LOSS_EXIT was introduced to cut loss-zone positions when public market
liquidity is high. The initial deploy showed that D9 fires mechanically, but it
misclassified the S2 mid-entry long-horizon cohort where the bot had no
Plankton-equivalent loss-cut evidence.

Observed Krabs impact from the 2026-05-17 audits:

- 11 tokens entered a D9 same-price-cooldown pattern.
- More than 152k same-price-cooldown observations accumulated across those
  tokens.
- The aliens position alone produced more than 41k D9 SELL signals in 24h,
  with repeated stale_exit_ttl cancellation and same-price cooldown.
- The affected S2 mid-entry long-horizon tokens were aliens, Trump-out-2027,
  and Putin-out.

Evidence trail:

- `research_plankton/plankton_h5_validation_2026-05-17.md`
- `research_plankton/plankton_per_token_analog_2026-05-17.md`
- `research_plankton/crabs_h5_surface_audit_2026-05-17.md`
- `research_plankton/crabs_11_cooldown_profile_2026-05-17.md`
- `research_plankton/crabs_supplementary_aliens_2026-05-17.md`
- `research_plankton/bot_holding_decision_aliens_2026-05-16.md`
- `research_plankton/plankton_cohort_taxonomy_2026-05-17.md`

## Decision

Add a configurable H5_wide cohort guard before the existing D9 loss-exit
predicate.

D9_LOSS_EXIT must not emit a SELL signal when all of the following are true:

- `state == "S2"`
- `0.02 <= avg_buy_price <= 0.40`
- `days_to_resolve > 14`

The boundaries are deliberate:

- `avg_buy_price` lower and upper bounds are inclusive.
- `days_to_resolve` is strict. `14.0` does not match; `15.0` matches.
- Missing `endDate`, invalid `endDate`, and expired markets do not match the
  guard.
- Missing/zero cumulative buy size does not match the guard and falls through
  to the existing D9 `avg-buy-unavailable` no-fire path.

The default policy shape is:

```json
{
  "lossExit": {
    "cohortGuard": {
      "enabled": true,
      "state": "S2",
      "avgBuyMin": 0.02,
      "avgBuyMax": 0.4,
      "minDaysToResolve": 14
    }
  }
}
```

When the guard matches, the evaluator returns non-fire with reason
`h5-wide-cohort-guard`. The runtime persists a `signal_suppressed` risk event
with `decisionRuleId = "D9_LOSS_EXIT"` and telemetry fields:

- `d9AvgBuyPrice`
- `d9DaysToResolve`
- `d9ProfitRatio`
- `d9PublicTradeCount24h`
- `state`
- `buyCount`

## Plankton Mirror Analysis

The H5_wide guard is based on the final verdict across the seven reports listed
above:

- Marginal cohort: 0 / 23 Plankton CUT observations.
- Putin-out exact R96 analog: 0 CUT / 28 HOLD.
- 99% of Plankton CUTs occur in S3, while H5_wide only suppresses S2.
- Trade-off: removes 2 R96 CUT events while avoiding 6,388 HOLD false
  positives.
- Balanced accuracy improves by +0.54pp in the validated retroactive replay.

## Per-Token Validation

| token          | H5_wide result | Validation note                                                  |
| -------------- | -------------- | ---------------------------------------------------------------- |
| aliens         | blocked        | S2, avg_buy 0.12, long horizon, validated as hold cohort         |
| Trump-out-2027 | blocked        | S2, avg_buy 0.127, long horizon, validated as hold cohort        |
| Putin-out      | blocked        | S2, avg_buy 0.026, 43d horizon, exact R96 analog 0 CUT / 28 HOLD |
| Hormuz         | unaffected     | DTR < 0, expired/near-expired path outside H5_wide               |
| S3 tokens      | unaffected     | H5_wide only applies to S2                                       |

## Consequences

- D9 remains active for loss-zone liquid markets outside the H5_wide cohort.
- D9 stops emitting for S2 mid-entry long-horizon positions that matched the
  validated hold cohort.
- Existing D6 HOLD behavior becomes visible again for the guarded positions.
- Guard behavior can be disabled without redeploy via
  `lossExit.cohortGuard.enabled = false`.
- No D9 numerical threshold is changed: `minPublicTradeCount24h = 41` remains
  intact.

## Known Limitations

- R96 HOLD support is capped at 43.4 days; aliens and Trump-out have longer
  horizons.
- Marginal cohort support is n=23.
- This ADR does not alter execution-layer stale_exit_ttl or same-price-cooldown
  behavior.
- This ADR does not alter D9 behavior for S3 positions.

## Rollback Criteria

Rollback if post-deploy telemetry shows either:

- D9 emit rate drops suspiciously on non-H5 positions.
- A manual or expected SELL path fails where the position is outside H5_wide.
- `h5-wide-cohort-guard` appears for positions that do not satisfy the exact
  cohort predicate.

## Rollback Procedure

Preferred rollback is config-only:

```sql
-- DO NOT EXECUTE from this ADR without operator sign-off.
UPDATE profile_settings
SET execution_policy_json = json_set(
      COALESCE(execution_policy_json, '{}'),
      '$.lossExit.cohortGuard.enabled',
      json('false')
    ),
    updated_at = datetime('now')
WHERE profile_id = 'live-lite';
```

Then bump `runtime_control_state.execution_policy_version` through the standard
profile update path. Expected propagation is the next execution-policy refresh
and decision tick, normally under one minute.

Code rollback remains possible with:

```bash
git revert <h5_wide_commit_sha>
```

## Monitoring Plan

For the first 24h after deploy:

- Track D9 emission rate per token.
- Track `h5-wide-cohort-guard` risk events per token.
- Track same-price-cooldown counts.
- Confirm aliens, Trump-out, and Putin-out transition from D9 spam to D6 HOLD.
- Confirm S3 tokens and near-expiry tokens remain unaffected.
