-- Observe-only entry category-gate diagnostics.
-- Detailed fields live in payload JSON to keep the schema additive and compact;
-- category/gate-class columns provide cheap filtering without changing trading behavior.

SELECT safe_add_column('decision_signal_log', 'entry_category', 'TEXT');
SELECT safe_add_column('decision_signal_log', 'entry_category_gate_class', 'TEXT');
SELECT safe_add_column('decision_signal_log', 'entry_category_payload_json', 'TEXT');
