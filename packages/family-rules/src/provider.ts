import {
  createFamilyId,
  type FamilyRulesProvider,
  type FamilyRuleBundle,
  type FamilyIdentity,
  type FamilyEvidence,
  type FamilyRules,
  type FamilyId,
  type Regime,
} from "@plankton/domain";
import type { FamilyConfig } from "@plankton/config";

function toBrandedBundle(config: FamilyConfig): FamilyRuleBundle {
  const familyId = createFamilyId(config.identity.familyId);
  return {
    identity: { ...config.identity, familyId } as FamilyIdentity,
    evidence: { ...config.evidence, familyId } as FamilyEvidence,
    rules: { ...config.rules, familyId } as FamilyRules,
  };
}

class FamilyRulesProviderImpl implements FamilyRulesProvider {
  private readonly bundles: Map<FamilyId, FamilyRuleBundle>;

  constructor(configs: FamilyConfig[]) {
    this.bundles = new Map(
      configs.map((c) => {
        const bundle = toBrandedBundle(c);
        return [bundle.identity.familyId, bundle];
      }),
    );
  }

  getRule(familyId: FamilyId): FamilyRuleBundle | null {
    return this.bundles.get(familyId) ?? null;
  }

  isEnabled(familyId: FamilyId): boolean {
    const bundle = this.bundles.get(familyId);
    if (!bundle) return false;
    if (!bundle.rules.universe.enabled) return false;
    if (bundle.rules.universe.action !== "trade") return false;
    return true;
  }

  getAllFamilies(): FamilyIdentity[] {
    return [...this.bundles.values()].map((b) => b.identity);
  }

  getRulesForRegime(regime: Regime): FamilyRuleBundle[] {
    return [...this.bundles.values()].filter((b) => b.identity.regime === regime);
  }
}

export function createFamilyRulesProvider(configs: FamilyConfig[]): FamilyRulesProvider {
  return new FamilyRulesProviderImpl(configs);
}
