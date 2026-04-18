/**
 * Stub — family_rule_defaults table was dropped in Phase 7.
 * readFamilyRuleDefaults is kept for API compatibility until Phase 8 cleans up apps/api.
 */
import type Database from "better-sqlite3";
import type { FamilyRuleDefaultsConfig } from "@plankton/config";

export function readFamilyRuleDefaults(_db: Database.Database): FamilyRuleDefaultsConfig {
  return { entry: null };
}
