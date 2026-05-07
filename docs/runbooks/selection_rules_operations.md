# Selection Rules — Operator Runbook

Market admission is primarily controlled by the v5.11 hard filters in
`evaluatePreEntry`:

- per-token `midPrice < marketSelection.maxMidPrice` (default `0.5`)
- market `liquidity >= marketSelection.minLiquidity` (default `100`)
- not in the R9 zero-coverage category blacklist

These thresholds are stored per profile in
`profile_settings.execution_policy_json.marketSelection` and hot-reload through
the execution-policy version channel.

## Rule Types

Exact slug rules are operator overrides for individual markets:

| Type           | Matches           | Example pattern           |
| -------------- | ----------------- | ------------------------- |
| `include_slug` | exact market slug | `bitcoin-to-150k-by-2025` |
| `exclude_slug` | exact market slug | `spam-market-slug`        |

Legacy prefix rows (`include_prefix`, `exclude_prefix`) may still appear in old
databases for audit/cleanup, but they are deprecated since v5.11. The API/UI do
not allow creating or re-enabling them, and migration 042 disables enabled prefix
rows. Prefix rules are not part of live admission.

## Resolver Behavior

1. Exact `exclude_slug` wins and records `matched_exclude`.
2. Exact `include_slug` can record its `winningRuleId`, but the market still has
   to pass v5.11 hard filters.
3. If no exact rule matches, hard-filter pass records `matched_include` with no
   `winningRuleId`.
4. There is no single-market fallback admission.

`winningRuleId` is written to `markets.selection_winning_rule_id` when an exact
rule participates in the verdict.

## Daily Operations

### Add a Rule

UI: `/selection-rules` → **Add rule** → pick `include_slug` or `exclude_slug`,
enter the exact market slug, save.

API:

```bash
curl -X POST https://bot.example.com/api/v1/selection-rules \
  -H "Authorization: Bearer $PLANKTON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"profileId":"live-lite","ruleType":"exclude_slug","pattern":"spam-market-slug","enabled":true,"note":"manual block"}'
```

### Disable / Enable

UI: toggle the switch in the rules table. Disabled legacy prefix rows cannot be
re-enabled. API: `PATCH /selection-rules/:ruleId` with `{ "enabled": false }` or
`{ "enabled": true }` for exact slug rules.

### Delete

UI: trash icon. API: `DELETE /selection-rules/:ruleId`.

### Preview

`GET /selection-rules/preview?profileId=live-lite` returns buckets
(`matchedInclude`, `matchedExclude`, `step2FallbackInclude`, `fallbackExclude`)
from the persisted `markets.selection_status` values. The
`step2FallbackInclude` bucket is legacy compatibility and should be empty under
v5.11 hard-filter admission.

### Match Debugger

`GET /selection-rules/match?marketSlug=<market-slug>&eventSlug=<event-slug>&profileId=live-lite`
returns `{ finalStatus, selectionStatus, winningRuleId }`. A match endpoint
without normalized `midPrice`/`liquidity` context fails closed for hard-filter
admission; use scanner/market rows for authoritative live verdicts.

## Hot-Reload Mechanics

Selection-rule mutations bump
`runtime_control_state.selection_rules_version`; the runtime reloads the rule
engine before scan ticks. Market-selection thresholds are separate execution
policy fields and hot-reload via
`runtime_control_state.execution_policy_version`.

## Troubleshooting

| Symptom                                       | Check                                                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New rule does not affect markets              | Confirm `selection_rules_version` bumped and wait one scan interval. Exact includes still fail if mid/liquidity/category hard filters reject the market. |
| Prefix rule has no effect                     | Expected since v5.11. Delete it or keep it disabled for audit history.                                                                                   |
| Market excluded despite exact include rule    | Inspect `mid_price`, `liquidity`, and R9 category blacklist match. Exact include is not a bypass for hard filters.                                       |
| Excluded market still has open order/position | Expected: tracked pricing is preserved while orders/positions are open so exits and settlement can complete.                                             |
| Fresh market missing liquidity is excluded    | Expected fail-closed behavior. It becomes eligible only after normalized liquidity is available and passes the floor.                                    |

## Rollback

Selection-rule edits have no destructive side effects. Disable or delete the
offending exact rule, or restore `control.db` from the pre-change snapshot if a
larger rollback is needed. Pause the runtime (`/actions/pause`) for a hard stop.
