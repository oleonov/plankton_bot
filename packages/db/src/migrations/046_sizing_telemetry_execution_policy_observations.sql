-- ADR-024 D-D: sizing telemetry on execution_policy_observations.
-- sizing_rule_id: rule id (B1..B7, S1..S7, FALLBACK) carried via
--   Signal.sizingRuleId from emitted-signal time onto the bridge/order
--   observation row. Joinable with decision_signal_log.sizing_rule_id.
-- notional_bucket: §4.6 USDC bucket for Signal.suggestedSizeUsdc; lets
--   emitted-vs-placed sizing distributions be A/B'd in dashboards.
SELECT safe_add_column('execution_policy_observations', 'sizing_rule_id', 'TEXT');
SELECT safe_add_column('execution_policy_observations', 'notional_bucket', 'TEXT');
