ALTER TABLE markets ADD COLUMN event_market_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE markets ADD COLUMN selection_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (selection_status IN
    ('unknown','matched_include','matched_exclude','step2_fallback_include','fallback_exclude'));
ALTER TABLE markets ADD COLUMN selection_winning_rule_id TEXT;

CREATE INDEX IF NOT EXISTS idx_markets_selection_status ON markets(selection_status);
CREATE INDEX IF NOT EXISTS idx_orders_token_status ON orders(token_id, status);
