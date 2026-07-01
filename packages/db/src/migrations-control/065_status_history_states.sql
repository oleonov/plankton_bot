-- Status-history maintenance/pause states. Deploy warm-up and operator pauses are
-- recorded as distinct, uptime-excluded states instead of `crit`, so a planned
-- restart or an intentional pause no longer paints the day red. Two accumulators
-- alongside crit_secs/down_secs; the day's bar color still comes from real
-- ok/warn/crit time, and uptime % excludes maintenance + paused seconds.
SELECT safe_add_column('status_history', 'maintenance_secs', 'INTEGER NOT NULL DEFAULT 0');
SELECT safe_add_column('status_history', 'paused_secs', 'INTEGER NOT NULL DEFAULT 0');
