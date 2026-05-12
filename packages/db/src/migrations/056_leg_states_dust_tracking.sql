-- CHANGE B: dust abandonment with auto-recovery per R67 spec 11.5.
-- consecutive_sell_residual_rejects: counts SELL emissions suppressed by
--   shouldSuppressSellResidualBelowMinSize (position size < minOrderSize).
--   Reset to 0 on any BUY fill. Crossing maxConsecutiveRejects (default 10)
--   marks the leg as abandoned.
-- abandoned_at_price / abandoned_at_ts: snapshot of price + ISO timestamp
--   at the moment we declared the token abandoned. Used to detect
--   price-move-based auto-recovery (currentPrice / abandoned_at_price >=
--   priceRecoveryRatio). Both columns are NULL when the leg is healthy.
-- All three columns are nullable defaults (0 / NULL) so legacy rows
-- behave as never-rejected on first read.
SELECT safe_add_column('leg_states', 'consecutive_sell_residual_rejects', 'INTEGER NOT NULL DEFAULT 0');
SELECT safe_add_column('leg_states', 'abandoned_at_price', 'REAL');
SELECT safe_add_column('leg_states', 'abandoned_at_ts', 'TEXT');
