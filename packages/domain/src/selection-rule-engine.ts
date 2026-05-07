import type { SelectionRule, SelectionDecision } from "./types.js";

export function normalizeSelectionPattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}

export class SelectionRuleEngine {
  private readonly rules: readonly SelectionRule[];

  constructor(rules: readonly SelectionRule[]) {
    this.rules = rules.filter((r) => r.enabled);
  }

  resolve(eventSlug: string | null, marketSlug: string): SelectionDecision {
    const normSlug = normalizeSelectionPattern(marketSlug);

    const exactHits = this.rules.filter(
      (r) => r.ruleType === "exclude_slug" && r.pattern === normSlug,
    );

    if (exactHits.length > 0) {
      return { status: "exclude", winningRuleId: exactHits[0]!.ruleId };
    }

    void eventSlug;
    return { status: "no_match", winningRuleId: null };
  }
}
