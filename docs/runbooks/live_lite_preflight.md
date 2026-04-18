# Live-Lite Preflight Checklist

## Prerequisites

- [ ] Paper signoff complete (see `paper_signoff.md`)
- [ ] Selection rules seeded for the `live-lite` profile — verify via `GET /selection-rules?profileId=live-lite`
- [ ] Caps defined: max open value, max order, max active markets
- [ ] API credentials verified for exchange connectivity
- [ ] `control.db` + `ledger-live-lite.db` snapshot taken for rollback

## Config Verification

Verify these env vars are set:

| Env var                         | Expected value     |
| ------------------------------- | ------------------ |
| `RUNTIME_MODE`                  | `live-lite`        |
| `LIVE_LITE_CONFIRM`             | `true`             |
| `LIVE_LITE_MAX_OPEN_VALUE_USDC` | positive number    |
| `LIVE_LITE_MAX_ORDER_USDC`      | positive number    |
| `LIVE_LITE_MAX_ACTIVE_MARKETS`  | positive integer   |
| `POLY_API_KEY`                  | set                |
| `POLY_API_SECRET`               | set                |
| `POLY_PASSPHRASE`               | set                |

## DB State Verification

- [ ] Review any existing positions in the DB
- [ ] Review any existing open orders in the DB
- [ ] Confirm no orphaned state from previous runs
- [ ] Confirm `selection_rules` for `live-lite` profile are the intended set (enabled + patterns)

## Credential Verification

- [ ] Verify `POLY_API_KEY` is set and non-empty
- [ ] Verify `POLY_API_SECRET` is set and non-empty
- [ ] Verify `POLY_PASSPHRASE` is set and non-empty
- [ ] Test API key connectivity: runtime boot will fail-closed if credentials are invalid (gateway healthCheck fails)
- [ ] Confirm credentials have appropriate permissions for order placement

## Fail Closed Conditions

The runtime will **exit immediately** if:

- Missing any cap env var (`MAX_OPEN_VALUE_USDC`, `MAX_ORDER_USDC`, `MAX_ACTIVE_MARKETS`)
- Missing `LIVE_LITE_CONFIRM=true`
- Missing API credentials (`POLY_API_KEY`, `POLY_API_SECRET`, `POLY_PASSPHRASE`)

## Start Paused Conditions

The runtime will **start in paused state** if:

- Existing active markets count exceeds `MAX_ACTIVE_MARKETS`
- Combined exposure (positions + open buy order notional) exceeds `MAX_OPEN_VALUE_USDC`

## Steps

1. Set all env vars as shown above
2. Start runtime: `RUNTIME_MODE=live-lite node apps/runtime/dist/index.js`
3. Check logs for preflight results
4. If started paused: review violations, resolve, then resume via web UI
5. If started clean: verify web dashboard shows live-lite banner

## Abort Conditions

- Runtime exits on startup (fail-closed) → review error message, fix config
- Preflight finds >2 distinct violations → investigate before resuming
- API credential test fails → do not proceed

## Artifacts to Save

- [ ] `bot_run_id` from this session
- [ ] Timestamp/session window
- [ ] Active selection-rules set (`GET /selection-rules?profileId=live-lite`) + caps
- [ ] Preflight log output
- [ ] Screenshot of Overview page (showing envelope)
- [ ] Final `/api/v1/status` JSON snapshot
