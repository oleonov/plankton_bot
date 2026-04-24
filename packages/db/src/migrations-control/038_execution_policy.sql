-- ADR-015: DB-backed execution policy. Move dead-side guard + pricing knobs
-- (ADR-013 entry ceiling, ADR-014 bounded-midpoint + shadow canary) out of
-- env and into profile_settings.execution_policy_json. Version column drives
-- hot-reload in the runtime (bump on any write; follows selection_rules
-- pattern from migration 037).

ALTER TABLE profile_settings ADD COLUMN execution_policy_json TEXT;

ALTER TABLE runtime_control_state ADD COLUMN execution_policy_version INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1);

-- Seed the live-lite policy at the safe canary defaults:
--   deadSideGuard.mode=enforce  — aligns with last-3-days prod audit (12 fills
--                                 rejected, 0 long-dated probes clipped)
--   pricing.mode=edge           — keep ADR-006 D1 placement; shadow-compute
--                                 bounded-midpoint for a 48-72h canary before flip.
UPDATE profile_settings
SET execution_policy_json =
      '{"version":1,"entryPriceCeiling":0.75,"exitOrderTtlMs":300000,' ||
      '"deadSideGuard":{"mode":"enforce","askCeiling":0.02,"maxTimeToEndMs":120000},' ||
      '"pricing":{"mode":"edge","maxEntrySpreadTicks":20,"maxExitSpreadTicks":40,' ||
      '"maxImprovementTicks":10,"wideSpreadPolicy":"edge","oneSidedPolicy":"edge"},' ||
      '"telemetry":{"deadSideCanary":true,"pricingShadow":true}}',
    updated_at = datetime('now')
WHERE profile_id = 'live-lite'
  AND execution_policy_json IS NULL;

-- Paper/simulation default to observe so canary telemetry still runs but
-- never rejects. Keeps dev/CI runs clean.
UPDATE profile_settings
SET execution_policy_json =
      '{"version":1,"entryPriceCeiling":0.75,"exitOrderTtlMs":300000,' ||
      '"deadSideGuard":{"mode":"observe","askCeiling":0.02,"maxTimeToEndMs":120000},' ||
      '"pricing":{"mode":"edge","maxEntrySpreadTicks":20,"maxExitSpreadTicks":40,' ||
      '"maxImprovementTicks":10,"wideSpreadPolicy":"edge","oneSidedPolicy":"edge"},' ||
      '"telemetry":{"deadSideCanary":true,"pricingShadow":true}}',
    updated_at = datetime('now')
WHERE profile_id IN ('paper','simulation')
  AND execution_policy_json IS NULL;

UPDATE runtime_control_state
SET execution_policy_version = 1,
    updated_at = datetime('now')
WHERE id = 1;
