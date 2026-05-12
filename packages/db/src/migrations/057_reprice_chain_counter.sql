-- CHANGE C: per-token 24h reprice chain cap per R65 p90 = 13.
-- True sliding window: stores ISO timestamps of recent reprice events as a
-- JSON-text array. On evaluation older-than-windowMs entries are filtered out
-- (in code), so the cap is enforced against a true rolling 24h count, not a
-- fixed window that resets at the 24h boundary.
--
-- Note: `reprice_chain_count_24h` / `reprice_chain_window_start_ts` are kept
-- for backwards compat with already-applied DBs (idempotent migration), but
-- they are no longer the source of truth. New code reads
-- `reprice_chain_events_24h_json` instead.
SELECT safe_add_column('leg_states', 'reprice_chain_count_24h', 'INTEGER NOT NULL DEFAULT 0');
SELECT safe_add_column('leg_states', 'reprice_chain_window_start_ts', 'TEXT');
SELECT safe_add_column('leg_states', 'reprice_chain_events_24h_json', 'TEXT');
