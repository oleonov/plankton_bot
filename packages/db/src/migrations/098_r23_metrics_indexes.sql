-- GET /metrics/r23 (apps/api/src/routes/metrics.ts) runs three range-scans per request, each
-- filtering on a rule/event discriminator plus a timestamp window:
--   orders      WHERE decision_rule_id = 'R23_DIP_TRIGGER' AND created_at >= ?
--   fills       WHERE decision_rule_id = 'R23_DIP_TRIGGER' AND filled_at  >= ?
--   risk_events WHERE event_type = 'signal_suppressed' AND created_at >= datetime(?)
--                 AND json_extract(payload, '$.decisionRuleId') = 'R23_DIP_TRIGGER'
-- Migration 041 added `orders.decision_rule_id` / `fills.decision_rule_id` but indexed neither,
-- and ledger.sql carries only the single-column idx_fills_filled_at / idx_risk_events_created_at,
-- none of which can serve a discriminator-led seek.
--
-- All three indexes already exist on the production ledger — added by hand while diagnosing the
-- endpoint — but no migration creates them, so any rebuilt or restored database silently loses
-- them. Same defect and same remedy as migration 094 for idx_decision_signal_log_rule_ts; these
-- three were simply never given that retroactive treatment. The DDL below is transcribed verbatim
-- from the live ledger's sqlite_master so a rebuilt database converges on the identical shape
-- rather than a re-derived approximation.
--
-- IF NOT EXISTS makes this a no-op on production and additive everywhere else.
CREATE INDEX IF NOT EXISTS idx_orders_decision_rule_created_at
  ON orders(decision_rule_id, created_at);

CREATE INDEX IF NOT EXISTS idx_fills_decision_rule_filled_at
  ON fills(decision_rule_id, filled_at);

-- Partial + expression index: `json_extract` is deterministic, so it is legal in both the key and
-- the WHERE clause. The partial predicate pins the two constants the endpoint always supplies, so
-- the index covers only the suppressed-R23 slice rather than the whole risk_events table.
CREATE INDEX IF NOT EXISTS idx_risk_events_r23_suppressed_created_reason
  ON risk_events(created_at, json_extract(payload, '$.reasonCode'))
  WHERE event_type = 'signal_suppressed'
    AND json_extract(payload, '$.decisionRuleId') = 'R23_DIP_TRIGGER';
