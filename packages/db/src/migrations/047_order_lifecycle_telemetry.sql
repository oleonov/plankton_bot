-- ADR-025 §D-B: order lifecycle telemetry on every cancellation.
-- §12.1 same-price-gap bucket distribution, captured at cancel time.
SELECT safe_add_column('orders', 'cancel_age_ms', 'INTEGER');
SELECT safe_add_column('orders', 'cancel_age_bucket', 'TEXT');
SELECT safe_add_column('orders', 'fill_progress_shares', 'NUMERIC');
SELECT safe_add_column('orders', 'market_horizon', 'TEXT');
