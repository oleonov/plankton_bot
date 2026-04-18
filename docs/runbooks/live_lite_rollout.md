# Live-Lite Session Procedure

## Prerequisites

- [ ] Preflight passed (see `live_lite_preflight.md`)
- [ ] Operator present and monitoring
- [ ] Web dashboard open
- [ ] Terminal with live logs open

## Startup Checklist

- [ ] All env vars set per preflight
- [ ] DB path confirmed
- [ ] Logs location known
- [ ] Web dashboard accessible
- [ ] Confirm live-lite banner visible in StatusBar

## First 15 Minutes

- [ ] Signals are being produced for allowlisted families only
- [ ] Orders are being placed on exchange (check exchange dashboard)
- [ ] Fills are arriving and positions are opening
- [ ] Reconciliation runs cleanly (no drift)
- [ ] Caps holding: check Overview envelope display
- [ ] No unexpected rejections in logs

## First Hour

- [ ] Positions match expectations (size, direction, event slug within include rules)
- [ ] No reconciliation drift detected
- [ ] Caps not exceeded
- [ ] No unexpected ERROR-level log entries
- [ ] Market data remains FRESH

## Abort Conditions

- Market data STALE for >2 minutes
- Reconciliation drift detected (RECON DRIFT badge)
- Unexpected fills from non-allowlisted families
- Cap exceeded (should not happen — indicates enforcement failure)
- Any unexpected order rejection after resume
- Runtime crash or unhandled exception

## Abort Procedure

1. **PAUSE** via web UI → verify "PAUSED" badge appears
2. Verify no new orders placed after pause
3. If needed: quarantine all families via operator commands
4. Review logs and positions before taking further action

## Recovery Steps

1. Stop the live-lite runtime
2. Switch to `RUNTIME_MODE=simulation` for analysis
3. Review DB state: positions, orders, fills
4. Determine root cause of abort
5. Document findings

## Post-Run Review

- [ ] Compare positions against expectations
- [ ] Review all fills for correctness
- [ ] Check PnL matches manual calculation
- [ ] Review any rejected orders and reasons
- [ ] Document any issues found

## Artifacts to Save

- [ ] `bot_run_id` from this session
- [ ] Timestamp/session window (start → end)
- [ ] Active allowlist + caps at time of session
- [ ] Screenshot of Overview page
- [ ] Screenshot of Risk/Families page
- [ ] Relevant log excerpt (errors, warnings, rejections)
- [ ] Final `/api/v1/status` JSON snapshot
