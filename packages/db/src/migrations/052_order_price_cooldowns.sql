CREATE TABLE IF NOT EXISTS order_price_cooldowns (
  token_id                  TEXT NOT NULL,
  side                      TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  price_x10000              INTEGER NOT NULL,
  stale_cancel_count        INTEGER NOT NULL DEFAULT 0,
  cooldown_until_ts_utc     INTEGER NOT NULL DEFAULT 0,
  last_event_ts_utc         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_id, side, price_x10000)
);

CREATE INDEX IF NOT EXISTS idx_order_price_cooldowns_until
  ON order_price_cooldowns(cooldown_until_ts_utc);
