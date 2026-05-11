-- Polymarket wallet positions count the full share quantity from taker BUY
-- fills. Before 2026-05-11 we incorrectly persisted BUY taker `fills.size`
-- net of the taker fee, which made local positions smaller than the wallet.

UPDATE fills
   SET size = size_usdc / price
 WHERE side = 'buy'
   AND liquidity_role = 'taker'
   AND price > 0
   AND size_usdc > 0
   AND size < (size_usdc / price) - 1e-9;

UPDATE inventory_lots
   SET remaining_size = MAX(0, (
         SELECT f.size
           FROM fills f
          WHERE f.fill_id = inventory_lots.fill_id
       ) - (size - remaining_size)),
       size = (
         SELECT f.size
           FROM fills f
          WHERE f.fill_id = inventory_lots.fill_id
       ),
       entry_price = CASE
         WHEN (
           SELECT f.size
             FROM fills f
            WHERE f.fill_id = inventory_lots.fill_id
         ) > 0 THEN cost_usdc / (
           SELECT f.size
             FROM fills f
            WHERE f.fill_id = inventory_lots.fill_id
         )
         ELSE entry_price
       END
 WHERE fill_id IN (
         SELECT f.fill_id
           FROM fills f
          WHERE f.side = 'buy'
            AND f.liquidity_role = 'taker'
            AND f.price > 0
            AND f.size_usdc > 0
       )
   AND position_id IN (
         SELECT p.position_id
           FROM positions p
          WHERE p.status IN ('open', 'dust')
       );

WITH position_totals AS (
  SELECT p.position_id,
         COALESCE(SUM(l.remaining_size), 0) AS size,
         COALESCE(SUM(l.remaining_size * l.entry_price), 0) AS cost_basis_usdc
    FROM positions p
    JOIN inventory_lots l ON l.position_id = p.position_id
   WHERE p.status IN ('open', 'dust')
   GROUP BY p.position_id
)
UPDATE positions
   SET size = (
         SELECT pt.size
           FROM position_totals pt
          WHERE pt.position_id = positions.position_id
       ),
       cost_basis_usdc = (
         SELECT pt.cost_basis_usdc
           FROM position_totals pt
          WHERE pt.position_id = positions.position_id
       ),
       avg_entry_price = CASE
         WHEN (
           SELECT pt.size
             FROM position_totals pt
            WHERE pt.position_id = positions.position_id
         ) > 0 THEN (
           SELECT pt.cost_basis_usdc / pt.size
             FROM position_totals pt
            WHERE pt.position_id = positions.position_id
         )
         ELSE avg_entry_price
       END,
       updated_at = datetime('now')
 WHERE position_id IN (SELECT position_id FROM position_totals);

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
       ), 0),
       updated_at = datetime('now')
 WHERE EXISTS (
         SELECT 1
           FROM fills f
          WHERE f.token_id = leg_states.token_id
            AND f.side = 'buy'
            AND f.liquidity_role = 'taker'
       );
