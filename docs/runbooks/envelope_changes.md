# Envelope changes — operations runbook

This runbook covers how to change a profile's envelope, execution policy, and
related settings stored in `control.db.profile_settings`. Every change made
through the API is recorded in `profile_settings_history`. Direct SQL writes
are not auditable — avoid them.

## Why this matters

`profile_settings` holds the live trading envelope: `maxFamilies`,
`maxActiveMarkets`, `maxOpenValueUsdc`, `maxOrderUsdc`, the family allowlist,
and the full `ExecutionPolicy` JSON. Changes here directly affect production
trading. Before this runbook existed, the cap was raised 50 → 60 → 100 via
direct SQL `UPDATE`, leaving no record of who changed what or why. The
history table closes that gap.

## Persistence guarantees

`control.db` lives in the Docker named volume `krabs-data`, mounted at
`/app/apps/runtime/data` inside the container and `/var/lib/docker/volumes/krabs-data/_data`
on the host. Named volumes survive `docker compose down`, image rebuilds, and
`./deploy.sh` — settings persist across deploys without any extra step.

## Change envelope (cap, allowlist, wallet mode, etc.)

`PUT /api/v1/profiles/:profileId/settings` UPSERTs the row and appends one
history entry per changed tracked field. Tracked fields:

- `initial_balance_usdc`
- `envelope_json`
- `risk_caps_json`
- `wallet_mode`
- `min_order_usdc`
- `relayer_json`
- `execution_policy_json` (via PATCH endpoint below)

### Example: raise `maxActiveMarkets` 60 → 100

```bash
curl -s -X PUT https://bot.example.com/api/v1/profiles/live-lite/settings \
  -H "Authorization: Bearer $KRABS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "envelopeJson": "{\"maxFamilies\":100,\"maxOpenValueUsdc\":500,\"maxOrderUsdc\":25,\"maxActiveMarkets\":100,\"familyAllowlist\":[...]}",
    "reason": "raise active markets cap to absorb new admissions per R64"
  }'
```

The whole `envelope_json` payload is replaced, so include every field — partial
JSON merging is not done at this layer. To avoid clobbering the allowlist,
fetch the current envelope first:

```bash
curl -s https://bot.example.com/api/v1/profiles/live-lite/settings \
  -H "Authorization: Bearer $KRABS_API_KEY" | jq -r '.data.envelope_json' > /tmp/envelope.json
# Edit /tmp/envelope.json, then PUT it back as the value of envelopeJson.
```

## Change execution policy (rules, thresholds)

`PATCH /api/v1/profiles/:profileId/execution-policy` accepts a partial policy,
deep-merges on top of the stored value, validates, and records one history row
under field `execution_policy_json` (skipped when the merged result is
byte-identical to the previous value).

```bash
curl -s -X PATCH https://bot.example.com/api/v1/profiles/live-lite/execution-policy \
  -H "Authorization: Bearer $KRABS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"marketSelection":{"maxMidPrice":0.55},"reason":"widen mid cap experiment"}'
```

## Read change history

```bash
# Last 50 changes for live-lite, all fields
curl -s "https://bot.example.com/api/v1/profiles/live-lite/history" \
  -H "Authorization: Bearer $KRABS_API_KEY" | jq

# Only envelope changes
curl -s "https://bot.example.com/api/v1/profiles/live-lite/history?field=envelope_json&limit=20" \
  -H "Authorization: Bearer $KRABS_API_KEY" | jq

# Only execution policy changes
curl -s "https://bot.example.com/api/v1/profiles/live-lite/history?field=execution_policy_json" \
  -H "Authorization: Bearer $KRABS_API_KEY" | jq
```

Each entry carries `before_value`, `after_value`, `actor` (`api_key` or session
username), `source` (`api_put_settings` / `api_patch_execution_policy`), and
`reason` passed in the request body.

## Rollback a bad change

History stores the full `before_value` text, so a rollback is just another PUT
or PATCH with the old payload.

```bash
# Get the most recent envelope_json change
PREV=$(curl -s "https://bot.example.com/api/v1/profiles/live-lite/history?field=envelope_json&limit=1" \
  -H "Authorization: Bearer $KRABS_API_KEY" | jq -r '.data.history[0].before_value')

# Restore it (the reason field is recorded against the rollback entry)
curl -s -X PUT https://bot.example.com/api/v1/profiles/live-lite/settings \
  -H "Authorization: Bearer $KRABS_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"envelopeJson\": $(jq -Rs <<<"$PREV"), \"reason\": \"rollback bad envelope from id=<entry-id>\"}"
```

### Rolling back to NULL

The PUT endpoint UPSERTs with `COALESCE(excluded.col, profile_settings.col)`, so
passing `null` (or omitting the field) keeps the existing value instead of
clearing it. If a tracked column needs to be reset to SQL `NULL` (`before_value`
in history is `null`), the API path cannot express that — fall back to a manual
SQL `UPDATE` and record the action via the explicit `INSERT INTO
profile_settings_history (... source='manual', ...)` recipe at the bottom of
this runbook.

## Do not do this

Direct SQL writes bypass the audit trail:

```sql
-- DO NOT — leaves no history row, undoable only via DB restore
UPDATE profile_settings SET envelope_json = '...' WHERE profile_id = 'live-lite';
```

If you absolutely must touch the DB directly (e.g. recovering from a corrupted
JSON value that the API refuses to accept), record what you did manually
afterwards:

```sql
INSERT INTO profile_settings_history
  (profile_id, field, before_value, after_value, actor, source, reason)
VALUES
  ('live-lite', 'envelope_json', '<old>', '<new>', '<your-username>', 'manual', 'corrupted JSON recovery on 2026-MM-DD');
```
