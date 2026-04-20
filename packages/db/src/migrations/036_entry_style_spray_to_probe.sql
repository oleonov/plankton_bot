-- Phase 6.7: Normalize legacy `entry_style='spray'` rows to `'probe'`.
--
-- Spec §3 has no "spray" concept. `SignalReason.SprayEntry` and the
-- matching `entryStyle='spray'` branch were removed in Phase 6.7 because
-- nothing in production (strategy module, risk gate, inventory handler)
-- ever emitted them. Any persisted rows tagged `spray` are stale
-- artifacts of an earlier schema and are indistinguishable from `probe`
-- for downstream code (both map to "open entry on this token").

UPDATE positions SET entry_style = 'probe' WHERE entry_style = 'spray';
