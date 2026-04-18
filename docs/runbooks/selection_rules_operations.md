# Selection Rules — Operator Runbook

Selection rules control which Polymarket event slugs the scanner admits into the trading universe. They live in `control.db` and hot-reload into the runtime within one scan tick of a mutation — no restart required.

## Rule types

| Type | Matches | Example pattern |
|---|---|---|
| `include_prefix` | event slugs starting with the pattern | `bitcoin-` |
| `exclude_prefix` | event slugs starting with the pattern | `bitcoin-price-` |
| `include_slug` | exact event slug | `bitcoin-to-150k-by-2025` |
| `exclude_slug` | exact event slug | `bitcoin-hash-rate-all-time-high` |

## Resolver precedence (specificity wins)

1. Exact-slug rules beat prefix rules.
2. Among prefix rules, the longest matching prefix wins.
3. At equal tier, `exclude` beats `include`.
4. If no rule hits: **STEP 2 fallback** admits events with exactly one tradable market (`eventMarketCount === 1`); multi-market events with no rule match are excluded.

`winningRuleId` is written to `markets.selection_winning_rule_id` for every admission/exclusion decision.

## Daily operations

### Add a rule

UI: `/selection-rules` → **Add rule** → pick type, enter pattern, enable → Save.

API:

```bash
curl -X POST https://bot.example.com/api/v1/selection-rules \
  -H "Authorization: Bearer $PLANKTON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"profileId":"live-lite","ruleType":"include_prefix","pattern":"elon-musk-","enabled":true,"note":"Musk prediction cluster"}'
```

### Disable / enable

UI: toggle the switch in the rules table.

API: `PATCH /selection-rules/:ruleId` with `{ "enabled": false }`.

### Delete

UI: trash icon. API: `DELETE /selection-rules/:ruleId`.

### Preview before shipping

`GET /selection-rules/preview?profileId=live-lite` returns buckets (`matchedInclude`, `matchedExclude`, `step2FallbackInclude`, `fallbackExclude`) for the current rule set against the live Gamma event catalog.

Draft-rule what-if: `POST /selection-rules/preview` with a full rule set in the body runs the same resolver against a hypothetical ruleset without persisting.

### Match debugger

`GET /selection-rules/match?slug=bitcoin-to-150k-by-2025&profileId=live-lite` returns `{ finalStatus, selectionStatus, winningRuleId }` — the exact verdict the scanner will produce.

## Hot-reload mechanics

Every mutation bumps `runtime_control_state.selection_rules_version`. The scanner's in-memory `RefreshableSelectionRuleEngine` polls this version before each scan tick; on mismatch it reloads rules from `control.db` in a single transaction. Expect effects within ≤1 scan tick (`MARKET_SCANNER_INTERVAL_MS`, default 60s).

## Audit trail

Every create/update/delete writes a row to `state_transitions` with `entity_type='selection_rule'`, `entity_id=<ruleId>`. Query via `/audit?entityId=<ruleId>` or in-UI via the Audit page filtered on `entityId`.

## Troubleshooting

| Symptom | Check |
|---|---|
| New rule doesn't admit markets within 1 tick | `SELECT selection_rules_version, updated_at FROM runtime_control_state` — confirm version bumped; tail runtime logs for `selection-rule-engine refresh` |
| Market excluded despite matching include rule | Look up `selection_winning_rule_id` in `markets`; another more-specific rule (e.g. `exclude_prefix`) outranks the include |
| Excluded market still has open order | Expected — `findTrackedForPricing` keeps excluded tokens in the pricing loop while orders/positions are open so exits can complete |
| Preview counts mismatch live `markets` table | Preview runs against the current Gamma response; `markets` reflects the last scan. Wait a tick and re-query |

## Rollback

Selection rules have no destructive side effects. To revert:

1. Disable the offending rule (`PATCH /selection-rules/:ruleId` with `enabled: false`) — effective in ≤1 tick.
2. If a rule set misbehaves globally, restore `control.db` from the pre-change snapshot.

**Do not** use "disable all rules" as a kill switch — STEP 2 fallback would still admit every single-market event. Pause the runtime (`/actions/pause`) for a hard stop.
