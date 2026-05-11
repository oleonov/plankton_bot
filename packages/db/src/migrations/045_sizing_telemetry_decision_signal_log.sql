-- ADR-024 D-C: sizing telemetry on decision_signal_log.
-- sizing_rule_id: rule id (B1..B7, S1..S7, FALLBACK) returned by evaluateSize
--   at signal-emission time; carries the rule attribution alongside
--   decision_rule_id.
-- notional_bucket: §4.6 USDC bucket for Signal.suggestedSizeUsdc, mutually
--   exclusive over the ten canonical buckets at 06_algorithm_spec.md:454-467.
SELECT safe_add_column('decision_signal_log', 'sizing_rule_id', 'TEXT');
SELECT safe_add_column('decision_signal_log', 'notional_bucket', 'TEXT');
