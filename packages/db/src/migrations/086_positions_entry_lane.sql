-- Add entry_lane provenance marker to the positions table.
--
-- docs/plans/2026-07-15-gate-bounce-live-experiment.md, Phase 3: durable
-- first-entry lane, set once from the position's first fill decisionRuleId
-- ("GATE" when GATE_ENTRY_RULE_ID, "R23" when R23_DIP_TRIGGER_RULE_ID, else
-- NULL) and never changed afterward. Scopes the bounce-exit SELL rule to
-- entry_lane = 'GATE' only; all existing/legacy positions get NULL (safe —
-- NULL is treated as non-GATE, so D8/D9 keep owning them unchanged).
SELECT safe_add_column('positions', 'entry_lane', 'TEXT');
