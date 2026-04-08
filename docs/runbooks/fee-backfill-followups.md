# Fee Backfill — Operator Follow-Ups (2026-04-07)

After the fee formula fix + backfill (see
`docs/superpowers/plans/2026-04-07-fee-normalization-bug.md`), the
following operator actions are required. They are NOT automated.

## 1. Review canary-driven demotions

The backfill does not un-quarantine families. It only resets derived
state so the next evaluation cycle sees clean inputs.

Query:

```sql
SELECT family_id, profile, operator_mode, strategy_stage,
       operator_reason, updated_at
FROM family_deployments
WHERE profile = 'live-lite'
  AND enabled = 1
  AND operator_mode IN ('quarantine', 'reduce-only')
  AND (operator_reason LIKE '%fee%' OR
       operator_reason LIKE '%canary%' OR
       operator_reason LIKE '%leakage%')
ORDER BY updated_at DESC;
```

For each row:

- Confirm the family has genuinely-clean recent canary scorecards
  (`SELECT * FROM family_validation_scorecards WHERE family_id = ?
AND profile = 'live-lite' ORDER BY validated_at DESC LIMIT 1;`).
- If the scorecard's `executionTelemetry24h.explicitFeesUsdc` is 0
  AND `feeLeakageRatio` is 0, the demotion is stale.
- Manually flip `operator_mode` back to `active` via the API action
  (NOT directly in SQL): `POST /api/v1/families/<family_id>/operator-mode`
  with `{"mode": "active", "reason": "fee bug backfill review"}`.

## 2. Review families with persistent inflated scorecards

Even after backfill, if any scorecards remain with non-zero
`explicitFeesUsdc`, those are unrelated to the fee bug and need
separate investigation (historical volumeUsdc inflation, see
out-of-scope P3 in the plan).

Query:

```sql
SELECT family_id, validated_at,
       json_extract(summary_json, '$.executionTelemetry24h.explicitFeesUsdc') AS fees,
       json_extract(summary_json, '$.executionTelemetry24h.volumeUsdc') AS volume
FROM family_validation_scorecards
WHERE profile = 'live-lite'
  AND validated_at > datetime('now', '-1 hour')
  AND json_extract(summary_json, '$.executionTelemetry24h.explicitFeesUsdc') > 0
ORDER BY validated_at DESC;
```

## 3. Success criteria

Backfill is considered successful when:

- `SELECT SUM(fee) FROM fills WHERE liquidity_role = 'maker'` returns 0
- `SELECT SUM(fee) FROM fills WHERE liquidity_role = 'taker'` returns a
  small value consistent with the number of taker fills × `size × rate × p × (1-p)`
- Recent scorecards for all 9 traded families have `explicitFeesUsdc = 0`
  (except for any families with new genuine taker fills)
- No new demotions with reason containing "fee leakage" or "execution
  canary" for at least 24 hours after the fix
