# Paper Mode Signoff Criteria

## Prerequisites

- [ ] All code merged and tests passing
- [ ] `RUNTIME_MODE=paper` configured
- [ ] `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_PASSPHRASE` set (real credentials, read-only for paper)
- [ ] Selection rules seeded for `paper` profile (`GET /selection-rules?profileId=paper`)
- [ ] Algo rules seeded (`GET /config/algo-rules?profile=paper`)
- [ ] Database path configured and writable
- [ ] Web dashboard accessible

## Steps

1. Start runtime with `RUNTIME_MODE=paper`
2. Let run for at least 2 hours
3. Monitor web dashboard:
   - Verify signals are being produced
   - Verify orders are being placed (simulated execution)
   - Verify fills are being processed
   - Verify selection-status admits/excludes markets as configured
   - Verify reconciliation runs cleanly
4. Check logs for any ERROR-level entries
5. Verify market data is FRESH (not stale)
6. Confirm at least one full reconciliation cycle completes

## Success Criteria

- [ ] Signals flow on admitted markets
- [ ] Simulated fills create/update positions
- [ ] Exposure aggregates (balance, open value) update correctly
- [ ] Reconciliation completes without critical drift
- [ ] No unexpected ERROR-level log entries
- [ ] Market data remains fresh throughout
- [ ] Web dashboard displays accurate state

## Failure Criteria

- Any unhandled exception or crash
- Market data stuck in STALE for >5 minutes
- Reconciliation reports unrecoverable drift
- No signals produced after 30 minutes
- Position inconsistencies (negative sizes, impossible states)

## Artifacts to Save

- [ ] `bot_run_id` from this session
- [ ] Timestamp/session window (start → end)
- [ ] Active selection-rules set + caps
- [ ] Screenshot of Overview page
- [ ] Screenshot of Selection Rules + Risk pages
- [ ] Relevant log excerpt (errors, warnings)
- [ ] Final `/api/v1/status` JSON snapshot
