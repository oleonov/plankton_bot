-- Plankton-signature ranking features persisted from the Gamma scanner.
--
-- findTrackedForPricingTiered ranks the WS tier from latest market_snapshots,
-- which do not exist for fresh untracked markets — so plankton-style cheap
-- markets never rank up in time and their early dip is missed. These columns
-- carry the Gamma-at-discovery features onto the markets row so the signature
-- tier can rank fresh markets immediately. All nullable; scanner backfills on
-- the next scan. tick_size/end_date already exist and are NOT duplicated.
SELECT safe_add_column('markets', 'sig_mid', 'REAL');
SELECT safe_add_column('markets', 'sig_cheap_mid', 'REAL');
SELECT safe_add_column('markets', 'sig_liquidity', 'REAL');
SELECT safe_add_column('markets', 'sig_vol24h', 'REAL');
SELECT safe_add_column('markets', 'sig_features_at', 'TEXT');

-- idx_markets_signature filters on tradable, but bootstrapDatabase() only adds that
-- column via an ad-hoc safeAddColumn() call that runs AFTER runMigrations() — so a
-- bare migration run (e.g. this migration's own test) never sees it otherwise. Add it
-- here too via the same idempotent macro; bootstrap's later call is a no-op once this
-- has already run.
SELECT safe_add_column('markets', 'tradable', 'INTEGER NOT NULL DEFAULT 1');

CREATE INDEX IF NOT EXISTS idx_markets_signature
  ON markets(tradable, selection_status, sig_liquidity, tick_size);
