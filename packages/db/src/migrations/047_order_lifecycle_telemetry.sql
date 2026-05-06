-- ADR-025 §D-B: order lifecycle telemetry on every cancellation.
-- §12.1 same-price-gap bucket distribution, captured at cancel time.
ALTER TABLE orders ADD COLUMN cancel_age_ms INTEGER;
ALTER TABLE orders ADD COLUMN cancel_age_bucket TEXT;
ALTER TABLE orders ADD COLUMN fill_progress_shares NUMERIC;
ALTER TABLE orders ADD COLUMN market_horizon TEXT;
