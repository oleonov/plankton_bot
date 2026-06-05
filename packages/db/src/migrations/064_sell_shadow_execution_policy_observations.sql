-- Track SELL pricing observe-only diagnostics.
-- Nullable columns preserve existing rows and keep migration additive.

SELECT safe_add_column('execution_policy_observations', 'sell_shadow_avg_entry', 'REAL');
SELECT safe_add_column('execution_policy_observations', 'sell_shadow_avg_entry_source', 'TEXT');
SELECT safe_add_column('execution_policy_observations', 'sell_shadow_signal_price', 'REAL');
SELECT safe_add_column('execution_policy_observations', 'sell_shadow_execution_price', 'REAL');
SELECT safe_add_column('execution_policy_observations', 'sell_shadow_execution_vs_signal_ratio', 'REAL');
SELECT safe_add_column('execution_policy_observations', 'sell_shadow_execution_vs_avg_entry_ratio', 'REAL');
SELECT safe_add_column('execution_policy_observations', 'sell_shadow_cap5_violation', 'INTEGER');
SELECT safe_add_column('execution_policy_observations', 'sell_shadow_cap10_violation', 'INTEGER');
SELECT safe_add_column('execution_policy_observations', 'sell_shadow_exit_pricing_mode', 'TEXT');
SELECT safe_add_column('execution_policy_observations', 'sell_shadow_exit_anchor_mode', 'TEXT');
