/**
 * ReloadableFamilyRulesManager — wraps a FamilyRulesProvider with reload capability.
 *
 * Merges YAML-defined families with DB-stored families on each build.
 * DB entries overwrite YAML entries with the same familyId key.
 */

import type {
  FamilyRulesProvider,
  FamilyRuleBundle,
  FamilyIdentity,
  FamilyId,
  Regime,
} from "@plankton/domain";
import { createFamilyRulesProvider } from "@plankton/family-rules";
import type { FamilyConfig } from "@plankton/config";

/**
 * Abstraction over the DB layer to avoid coupling to SqliteFamilyRulesDbRepository.
 * Uses `unknown` identity/rules shapes because the DB repo cannot depend on @plankton/config types.
 * The returned objects are structurally identical to FamilyConfig at runtime.
 */
export interface DbFamilyRulesReader {
  loadAll(): Array<{ identity: Record<string, unknown>; rules: Record<string, unknown> }>;
}

export class ReloadableFamilyRulesManager implements FamilyRulesProvider {
  private inner: FamilyRulesProvider;

  constructor(
    private readonly yamlConfigs: FamilyConfig[],
    private readonly dbReader: DbFamilyRulesReader,
  ) {
    this.inner = this.build();
  }

  reload(): void {
    this.inner = this.build();
  }

  getRule(familyId: FamilyId): FamilyRuleBundle | null {
    return this.inner.getRule(familyId);
  }

  isEnabled(familyId: FamilyId): boolean {
    return this.inner.isEnabled(familyId);
  }

  getAllFamilies(): FamilyIdentity[] {
    return this.inner.getAllFamilies();
  }

  getRulesForRegime(regime: Regime): FamilyRuleBundle[] {
    return this.inner.getRulesForRegime(regime);
  }

  /** DB families overwrite YAML families with the same familyId. */
  private build(): FamilyRulesProvider {
    const dbFamilies = this.dbReader.loadAll() as FamilyConfig[];
    return createFamilyRulesProvider([...this.yamlConfigs, ...dbFamilies]);
  }
}
