-- ADR-027 §D-B: §11.2 / §11.3 position-exit telemetry on decision_signal_log.
-- is_exit: 1 when the SELL signal lands on an existing leg, 0 for non-SELL
--   signals; null for SELL on missing leg (defensive — should not occur since
--   SELL-without-leg is rejected upstream).
-- is_first_sell: 1 when is_exit=1 AND legState.sellCount === 0; 0 for
--   subsequent SELLs on the same leg; null for non-SELL signals. Imperfect-
--   but-pragmatic per ADR-027 §D-B (fill-not-signal precise).
-- holding_time_ms: signalTs - legState.firstTradeAt for SELLs; null otherwise.
--   Negative deltas (clock skew) collapse to null per ADR-026 add_age_ms
--   convention.
-- holding_time_bucket: §11.2 six-bucket label, populated alongside
--   holding_time_ms.
-- exit_pnl_pct: (signalPrice - costBasis) / costBasis where costBasis comes
--   from positions.avg_entry_price (FIFO-recomputed by the inventory engine
--   after each SELL fill). Falls back to the lifetime BUY-VWAP
--   legState.cumulative_buy_notional / legState.cumulative_buy_size when
--   positionRepo is unavailable (test stubs / control-only deployments) — note
--   the lifetime VWAP only matches avg_entry_price on the first SELL,
--   afterwards FIFO deductions diverge it. Raw signed fraction; null when
--   costBasis <= 0 or non-SELL.
-- exit_pnl_bucket: §11.2 nine-bucket label.
-- sold_bought_ratio: legState.cumulative_sell_size / legState.cumulative_buy_size
--   at SELL emit time (pre-this-SELL state).
-- sold_bought_ratio_bucket: §11.2 six-bucket label.
-- Runtime ledger DBs upgrade via bootstrapLedgerDb safeAddColumn calls; this
-- file exists for non-runtime DB consumers iterating the migrations directory.
ALTER TABLE decision_signal_log ADD COLUMN is_exit INTEGER;
ALTER TABLE decision_signal_log ADD COLUMN is_first_sell INTEGER;
ALTER TABLE decision_signal_log ADD COLUMN holding_time_ms INTEGER;
ALTER TABLE decision_signal_log ADD COLUMN holding_time_bucket TEXT;
ALTER TABLE decision_signal_log ADD COLUMN exit_pnl_pct REAL;
ALTER TABLE decision_signal_log ADD COLUMN exit_pnl_bucket TEXT;
ALTER TABLE decision_signal_log ADD COLUMN sold_bought_ratio REAL;
ALTER TABLE decision_signal_log ADD COLUMN sold_bought_ratio_bucket TEXT;
