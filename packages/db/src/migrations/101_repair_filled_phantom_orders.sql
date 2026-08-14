-- Repair only the stopped-production phantom subset. Legacy taker BUY fills
-- stored net shares, so recover their gross shares exactly as runtime does.
UPDATE orders
   SET status = 'filled'
 WHERE status = 'cancelled'
   AND cancel_reason = 'phantom_missing_on_exchange'
   AND order_id = exchange_order_id
   AND exchange_order_id IS NOT NULL
   AND exchange_order_id <> ''
   AND size > 0
   AND COALESCE((
     SELECT SUM(CASE
                  WHEN f.side = 'buy'
                   AND f.liquidity_role = 'taker'
                   AND f.size_usdc > 0
                   AND f.price > 0 THEN f.size_usdc / f.price
                  ELSE f.size
                END)
       FROM fills AS f
      WHERE f.order_id = orders.order_id
   ), 0) >= size * 0.995;
