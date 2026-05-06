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
-- Runtime ledger DBs upgrade via bootstrapLedgerDb safeAddColumn calls; this
-- file exists for non-runtime DB consumers iterating the migrations directory.
ALTER TABLE decision_signal_log ADD COLUMN is_add INTEGER;
ALTER TABLE decision_signal_log ADD COLUMN add_age_ms INTEGER;
ALTER TABLE decision_signal_log ADD COLUMN add_age_bucket TEXT;
ALTER TABLE decision_signal_log ADD COLUMN add_price_change_pct REAL;
ALTER TABLE decision_signal_log ADD COLUMN add_price_change_bucket TEXT;
ALTER TABLE decision_signal_log ADD COLUMN nth_buy_at_emit INTEGER;
