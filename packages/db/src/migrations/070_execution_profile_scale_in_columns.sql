SELECT safe_add_column('execution_profile_state', 'add_count', 'INTEGER NOT NULL DEFAULT 0');
SELECT safe_add_column('execution_profile_state', 'last_buy_at_ms', 'INTEGER NULL');
SELECT safe_add_column('execution_profile_state', 'initial_probe_size_usd', 'REAL NULL');
