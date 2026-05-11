-- ADR-023 D-F: pricing telemetry on execution_policy_observations.
-- pricing_delta_ticks: signed distance from the order's natural edge in ticks
--   (BUY: selected - bestBid; SELL: bestAsk - selected).
-- round_level_hit: round-level taxonomy bucket from R29 evidence
--   (min_tick > 0.05x > 0.01x > 0.005x > off-round, mutually exclusive).
SELECT safe_add_column('execution_policy_observations', 'pricing_delta_ticks', 'REAL');
SELECT safe_add_column('execution_policy_observations', 'round_level_hit', 'TEXT');
