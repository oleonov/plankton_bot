SELECT safe_add_column('positions', 'liquidation_value_usdc', 'REAL');
SELECT safe_add_column('positions', 'liquidation_price', 'REAL');
SELECT safe_add_column('positions', 'liquidation_depth_exhausted', 'INTEGER DEFAULT 0');
SELECT safe_add_column('positions', 'liquidation_value_updated_at', 'TEXT');

SELECT safe_add_column('portfolio_snapshots', 'liquidation_value_usdc', 'REAL');
SELECT safe_add_column('portfolio_snapshots', 'unrealized_pnl_mid_usdc', 'REAL');
SELECT safe_add_column('portfolio_snapshots', 'unrealized_pnl_liquidation_usdc', 'REAL');
SELECT safe_add_column('portfolio_snapshots', 'total_equity_liquidation_usdc', 'REAL');
