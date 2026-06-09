-- Observe-only entry fresh-edge diagnostics.
-- Detailed fields live in payload JSON to keep the schema additive and compact;
-- kind/class columns provide cheap filtering without changing trading behavior.

SELECT safe_add_column('decision_signal_log', 'entry_fresh_edge_kind', 'TEXT');
SELECT safe_add_column('decision_signal_log', 'entry_fresh_edge_shadow_class', 'TEXT');
SELECT safe_add_column('decision_signal_log', 'entry_fresh_edge_payload_json', 'TEXT');
