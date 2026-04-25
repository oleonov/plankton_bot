-- Drop one-shot rollback archives left by family/discovery removal migrations.
-- These tables are not runtime state and have dominated control.db size in
-- production since the migration window closed.

DROP TABLE IF EXISTS archive_candidate_observation_markets_034;
DROP TABLE IF EXISTS archive_candidate_observations_034;
DROP TABLE IF EXISTS archive_family_candidates_034;
DROP TABLE IF EXISTS archive_discovery_runs_034;
DROP TABLE IF EXISTS archive_promotion_proposals_034;

DROP TABLE IF EXISTS archive_family_deployments_031;
DROP TABLE IF EXISTS archive_family_deployments_033;
