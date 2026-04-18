-- Phase 7.3: Drop all family_ tables from the control DB.
--
-- Dropped in reverse FK order so foreign-key constraints are not violated.
-- All tables are IF EXISTS — safe on fresh installs that were bootstrapped
-- from an already-trimmed control.sql.

-- Leaf tables (referencing family_catalog or family_validation_scorecards)
DROP TABLE IF EXISTS family_evidence;
DROP TABLE IF EXISTS family_validation_latest;
DROP TABLE IF EXISTS family_validation_scorecards;
DROP TABLE IF EXISTS family_profile_rollups;
DROP TABLE IF EXISTS family_config_meta;
DROP TABLE IF EXISTS family_rules_snapshot;
DROP TABLE IF EXISTS family_rule_defaults;
DROP TABLE IF EXISTS family_rules;
DROP TABLE IF EXISTS family_deployments;

-- Base table
DROP TABLE IF EXISTS family_catalog;
