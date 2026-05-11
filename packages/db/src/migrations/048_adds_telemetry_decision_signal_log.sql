-- ADR-026 §D-B: §11.1 position-add telemetry on decision_signal_log.
-- is_add: 1 when the BUY signal lands on an existing leg (buyCount >= 1),
--   0 for first-entry BUYs; null for SELL/REDEEM signals (adds telemetry is
--   BUY-only).
-- add_age_ms: signalTs - legState.firstTradeAt for adds; null otherwise.
-- add_age_bucket: §11.1.2 nine-bucket label, populated alongside add_age_ms.
-- add_price_change_pct: (signalPrice - firstTradePrice) / firstTradePrice;
--   raw signed fraction including <60s adds (filter at query time per §11.1.3).
-- add_price_change_bucket: §11.1.3 eight-bucket label.
-- nth_buy_at_emit: buyCount + 1 at signal-emit time, denormalized for
--   §11.1.4 per-leg n_adds distribution consistency.
SELECT safe_add_column('decision_signal_log', 'is_add', 'INTEGER');
SELECT safe_add_column('decision_signal_log', 'add_age_ms', 'INTEGER');
SELECT safe_add_column('decision_signal_log', 'add_age_bucket', 'TEXT');
SELECT safe_add_column('decision_signal_log', 'add_price_change_pct', 'REAL');
SELECT safe_add_column('decision_signal_log', 'add_price_change_bucket', 'TEXT');
SELECT safe_add_column('decision_signal_log', 'nth_buy_at_emit', 'INTEGER');
