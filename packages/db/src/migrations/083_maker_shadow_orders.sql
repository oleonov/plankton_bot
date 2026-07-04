-- Create maker_shadow_orders table for Phase 3 shadow projection of maker-R23.
-- Each row tracks a hypothetical post-only BUY limit order through its lifecycle:
-- pending → filled (trade_through|touch) → harvested|marked, or pending → expired.
-- shadow_order_id is a deterministic sha256 prefix of (token_id + posted_at) so
-- repeated R23 attempts for the same token at different times produce distinct rows.

CREATE TABLE IF NOT EXISTS maker_shadow_orders (
  shadow_order_id  TEXT PRIMARY KEY,
  token_id         TEXT NOT NULL,
  condition_id     TEXT NOT NULL,
  buy_px           REAL NOT NULL,
  harvest_px       REAL NOT NULL,
  posted_at        TEXT NOT NULL,
  fill_deadline    TEXT NOT NULL,
  stage            TEXT NOT NULL DEFAULT 'pending'
    CHECK (stage IN ('pending', 'filled', 'harvested', 'marked', 'expired')),
  fill_kind        TEXT
    CHECK (fill_kind IS NULL OR fill_kind IN ('trade_through', 'touch')),
  fill_px          REAL,
  mark_px          REAL,
  net_mark         REAL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_maker_shadow_orders_stage_token
  ON maker_shadow_orders (stage, token_id);
