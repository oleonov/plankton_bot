# Leg Phase Audit

`leg_state_transitions` is the append-only ledger trail for leg phase analysis.
Runtime writes it on every `FillReceived`, zero-size position clear, and settlement.
Startup also backfills missing fill-backed transitions from historical `fills`.

Current algorithm phases are `S0`, `S1`, `S2`, `S3`. `S4` is reserved in the DB
constraint for future compatibility; `S4` in `06_algorithm_spec.md` size flow is
a source label, not the current runtime phase.

## API

```bash
curl -s \
  -H "Authorization: Bearer $KRABS_API_KEY" \
  "https://bot.example.com/api/v1/positions/<position_id>/phase-transitions?limit=200"
```

## Server SQL

```bash
sqlite3 /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db "
SELECT occurred_at, from_phase, to_phase, action, price, size, size_usdc,
       from_buy_count, from_sell_count, to_buy_count, to_sell_count,
       fill_id, order_id, reason
  FROM leg_state_transitions
 WHERE position_id = '<position_id>'
    OR token_id = (SELECT token_id FROM positions WHERE position_id = '<position_id>')
 ORDER BY occurred_at ASC, id ASC;
"
```

Recent transitions:

```bash
sqlite3 /var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db "
SELECT id, token_id, position_id, occurred_at, from_phase, to_phase, action, reason
  FROM leg_state_transitions
 ORDER BY id DESC
 LIMIT 50;
"
```
