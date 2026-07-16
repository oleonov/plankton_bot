-- Bounce-exit ladder redesign (Phase 1 config) —
-- docs/plans/2026-07-16-bounce-exit-ladder-redesign.md.
--
-- ADDS the new ladder-scaffolding fields (targetTiers, ladderFractions,
-- ladderStepPct, backstopTtcHours) onto the existing $.bounceExit block via
-- individual json_set calls — it does NOT replace $.bounceExit wholesale, so
-- the legacy targetGainPct/timeoutMs/enabled/mode/whitelistConditionIds/
-- microMaxOrderUsdc fields already seeded by migration 068 (or customized by
-- an operator) are preserved untouched. Every other execution_policy_json
-- key (gateEntry, makerEntry, etc.) is likewise untouched.
--
-- FAIL-CLOSED (Phase 2 Codex fix, docs/plans/2026-07-16-bounce-exit-ladder-
-- redesign.md): the ladder is now the ACTIVE bounce-exit path, and this
-- migration is precisely what makes a row's ladder fields "legitimately
-- present" for the first time. Forcing enabled/mode to their pre-migration
-- values here would silently convert an old flat `enabled:true` block into
-- an ACTIVE ladder running on unreviewed scaffold defaults the moment this
-- migration lands — so every row this migration touches also has
-- enabled/mode forced to false/'off'. A row that was already `enabled:false`
-- or `mode:'off'` is unaffected (no behavior change); a row that was
-- `enabled:true` stays effectively disabled until an operator explicitly
-- re-enables it with reviewed ladder params.
--
-- Research-backed params (fixed, do not tune here): targetTiers scale with
-- entry price (≤0.02→+36% … 0.35+→+8%, see the plan doc), ladderFractions
-- [0.30,0.40,0.30] (median 3-tranche scale-out), ladderStepPct 0.22 (~+22%
-- between rungs), backstopTtcHours 24 (near-resolution taker backstop —
-- will replace the old 4h hold-time timeout once Phase 2/3 wires it in).
--
-- Targets rows with an existing (object) $.bounceExit block that is still
-- missing targetTiers — idempotent, and does not clobber a row that has
-- already migrated (or been operator-customized) to include the ladder
-- fields. Rows without a $.bounceExit object at all are left alone here;
-- migration 068 (which runs first) guarantees every valid row already has
-- one.

CREATE TEMP TABLE _bounce_exit_ladder_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _bounce_exit_ladder_targets(profile_id)
SELECT profile_id
FROM profile_settings
WHERE execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND json_type(execution_policy_json, '$.bounceExit') = 'object'
  AND json_type(execution_policy_json, '$.bounceExit.targetTiers') IS NULL;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.bounceExit.targetTiers',
         json('[{"maxPrice":0.02,"gainPct":0.36},{"maxPrice":0.03,"gainPct":0.27},{"maxPrice":0.05,"gainPct":0.19},{"maxPrice":0.08,"gainPct":0.15},{"maxPrice":0.15,"gainPct":0.15},{"maxPrice":0.35,"gainPct":0.12},{"maxPrice":1.0,"gainPct":0.08}]'),
         '$.bounceExit.ladderFractions',
         json('[0.3,0.4,0.3]'),
         '$.bounceExit.ladderStepPct',
         0.22,
         '$.bounceExit.backstopTtcHours',
         24,
         '$.bounceExit.enabled',
         json('false'),
         '$.bounceExit.mode',
         'off'
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _bounce_exit_ladder_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _bounce_exit_ladder_targets);

DROP TABLE _bounce_exit_ladder_targets;
