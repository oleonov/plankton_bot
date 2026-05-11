-- ADR-027 §D-C: cumulative buy/sell sizes on leg_states for §11.2 cost basis
-- and sold/bought-ratio computation at SELL signal-emit time.
-- cumulative_buy_size: running sum of every BUY fill's `size` (shares).
-- cumulative_buy_notional: running sum of every BUY fill's `price * size`
--   (USDC at fill price). Numerator of rolling per-share cost basis VWAP.
-- cumulative_sell_size: running sum of every SELL fill's `size` (shares).
--   Denominator stays cumulative_buy_size per §11.2 sold/bought framing
--   (legs that sold more than bought are the spec's >=100% bucket).
-- Backfill in-place from the ledger so existing leg_states rows pick up
-- cumulative_* without waiting on a fresh fill. runStartupPositionAdoption's
-- replay path only seeds rows for tokens that lack a leg_states entry, so
-- pre-existing rows would otherwise stay at the column DEFAULT 0 forever.
-- BUY notional uses fills.size_usdc (cash delivered) to mirror
-- inventory-handler.ts's `unitCost = sizeUsdc / size`, falling back to
-- price * size for legacy fills missing size_usdc.
-- Filter by filled_at >= leg_states.first_trade_at so prior, closed-out
-- legs on the same token don't leak into the active leg's aggregates.
SELECT safe_add_column('leg_states', 'cumulative_buy_size', 'REAL NOT NULL DEFAULT 0');
SELECT safe_add_column('leg_states', 'cumulative_buy_notional', 'REAL NOT NULL DEFAULT 0');
SELECT safe_add_column('leg_states', 'cumulative_sell_size', 'REAL NOT NULL DEFAULT 0');

-- Idempotency guard mirrors backfillLegStateCumulativeFromFills in bootstrap.ts:
-- a leg row only exists after a BUY fill, and the live path always sets
-- cumulative_buy_size to fillSize on first BUY, so post-migration legs are
-- non-zero. Restricting to cumulative_buy_size = 0 means re-applying this
-- migration (or running it after legs have started accumulating) is safe.
UPDATE leg_states
   SET cumulative_buy_size = COALESCE((
         SELECT SUM(COALESCE(f.size, 0))
           FROM fills f
          WHERE f.token_id = leg_states.token_id
            AND f.side = 'buy'
            AND f.filled_at >= leg_states.first_trade_at
       ), 0),
       cumulative_buy_notional = COALESCE((
         SELECT SUM(
                  CASE
                    WHEN f.size_usdc IS NOT NULL THEN f.size_usdc
                    ELSE COALESCE(f.price, 0) * COALESCE(f.size, 0)
                  END
                )
           FROM fills f
          WHERE f.token_id = leg_states.token_id
            AND f.side = 'buy'
            AND f.filled_at >= leg_states.first_trade_at
       ), 0),
       cumulative_sell_size = COALESCE((
         SELECT SUM(COALESCE(f.size, 0))
           FROM fills f
          WHERE f.token_id = leg_states.token_id
            AND f.side = 'sell'
            AND f.filled_at >= leg_states.first_trade_at
       ), 0)
 WHERE cumulative_buy_size = 0;
