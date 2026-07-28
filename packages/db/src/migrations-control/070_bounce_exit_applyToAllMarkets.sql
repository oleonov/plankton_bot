-- Release A Phase 5 — bounce-for-all broadening flag
-- (docs/plans/2026-07-24-release-a-phase3-owner-servicing.md, Phase 5).
--
-- ADDS the default-false `$.bounceExit.applyToAllMarkets` field onto the existing
-- $.bounceExit block via a single json_set — it does NOT replace $.bounceExit
-- wholesale, so every other bounceExit field (enabled/mode/whitelistConditionIds/
-- ladder scaffolding/microMaxOrderUsdc) seeded by migrations 068/069 (or customized
-- by an operator) is preserved untouched. Every other execution_policy_json key is
-- likewise untouched.
--
-- Default false ⇒ byte-identical assignment to today (whitelist-only ownership).
-- Broadening to true is a deliberate, separately-gated operator PATCH (the API
-- refuses false→true while the target ledger still holds active/dust NULL-owner
-- positions — you must run the census first).
--
-- Targets rows with an existing (object) $.bounceExit block that is still missing
-- applyToAllMarkets — idempotent, and does not clobber a row that already has the
-- field (operator-customized). Rows without a $.bounceExit object are left alone;
-- migration 068 (which runs first) guarantees every valid row already has one.

CREATE TEMP TABLE _bounce_apply_all_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _bounce_apply_all_targets(profile_id)
SELECT profile_id
FROM profile_settings
WHERE execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND json_type(execution_policy_json, '$.bounceExit') = 'object'
  AND json_type(execution_policy_json, '$.bounceExit.applyToAllMarkets') IS NULL;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.bounceExit.applyToAllMarkets',
         json('false')
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _bounce_apply_all_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _bounce_apply_all_targets);

DROP TABLE _bounce_apply_all_targets;
