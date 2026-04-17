-- Phase 7h — Drop the discovery-workflow control plane
--
-- The family-candidate / promotion-proposal pipeline (apps/discovery,
-- routes/discovery.ts, the /review → /accept → /reject UI) constituted a
-- second operator control plane parallel to config/family_rules.yaml and
-- family_deployments. Canonical spec §6 defines no such workflow. Operators
-- add families exclusively via YAML imports or direct DB edits now.
--
-- Archive first for rollback safety; promotion_proposals may still hold
-- historical operator decisions.

CREATE TABLE IF NOT EXISTS archive_family_candidates_034 AS
  SELECT * FROM family_candidates;

CREATE TABLE IF NOT EXISTS archive_candidate_observations_034 AS
  SELECT * FROM candidate_observations;

CREATE TABLE IF NOT EXISTS archive_candidate_observation_markets_034 AS
  SELECT * FROM candidate_observation_markets;

CREATE TABLE IF NOT EXISTS archive_discovery_runs_034 AS
  SELECT * FROM discovery_runs;

CREATE TABLE IF NOT EXISTS archive_promotion_proposals_034 AS
  SELECT * FROM promotion_proposals;

DROP INDEX IF EXISTS idx_proposals_status;
DROP INDEX IF EXISTS idx_proposals_family;
DROP INDEX IF EXISTS idx_proposals_one_pending_per_family_profile;
DROP INDEX IF EXISTS idx_proposals_one_pending_per_family_null_profile;
DROP TABLE IF EXISTS promotion_proposals;

DROP INDEX IF EXISTS idx_com_candidate_ts;
DROP INDEX IF EXISTS idx_com_slug;
DROP TABLE IF EXISTS candidate_observation_markets;

DROP INDEX IF EXISTS idx_candidate_obs_id_ts;
DROP TABLE IF EXISTS candidate_observations;

DROP INDEX IF EXISTS idx_candidates_status;
DROP INDEX IF EXISTS idx_candidates_recommendation;
DROP TABLE IF EXISTS family_candidates;

DROP INDEX IF EXISTS idx_discovery_runs_status;
DROP TABLE IF EXISTS discovery_runs;
