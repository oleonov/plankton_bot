/**
 * DbFamilyRulesProvider — stubbed in Phase 6 (family system removed).
 *
 * This class is no longer used by the runtime. It is preserved as an empty
 * stub so that the test file (db-family-rules-provider.test.ts) continues to
 * import successfully. Phase 7 will delete both this file and its test.
 */

export class DbFamilyRulesProvider {
  getRule(_familyId: unknown): null {
    return null;
  }

  isEnabled(_familyId: unknown): boolean {
    return false;
  }

  getAllFamilies(): unknown[] {
    return [];
  }

  getRulesForRegime(_regime: unknown): unknown[] {
    return [];
  }
}
