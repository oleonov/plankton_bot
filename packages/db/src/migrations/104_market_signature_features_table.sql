-- Keep high-churn Gamma signature features out of the wide markets row. The
-- scanner still persists every exact feature change; this table only reduces
-- SQLite row/index write amplification.
CREATE TABLE IF NOT EXISTS market_signature_features (
  token_id        TEXT PRIMARY KEY,
  sig_mid         REAL,
  sig_cheap_mid   REAL,
  sig_liquidity   REAL,
  sig_vol24h      REAL,
  sig_features_at TEXT,
  updated_at      TEXT NOT NULL
) WITHOUT ROWID;

-- OR IGNORE makes recovery/replay preserve a side row that is already newer
-- than the legacy markets tuple.
INSERT OR IGNORE INTO market_signature_features
  (token_id, sig_mid, sig_cheap_mid, sig_liquidity, sig_vol24h, sig_features_at, updated_at)
SELECT token_id, sig_mid, sig_cheap_mid, sig_liquidity, sig_vol24h, sig_features_at, updated_at
  FROM markets;
