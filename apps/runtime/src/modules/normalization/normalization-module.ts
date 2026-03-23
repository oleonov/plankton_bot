/**
 * Normalization Module — consumes MarketSnapshotReceived events,
 * classifies each market into a family using slug pattern matching,
 * persists to the market catalog, and publishes NormalizedMarketUpdated.
 *
 * Classification rules:
 *  - family + regime + horizon is the selection unit (HR1)
 *  - matching is done via FamilyIdentity.slugPattern (glob → anchored regex)
 *  - unknown / unconfigured markets flow through with null family fields
 *  - unknown markets never crash the pipeline
 */

import type {
  RuntimeModule,
  EventBus,
  FamilyRulesProvider,
  MarketRepository,
  NormalizedMarket,
  FamilyIdentity,
  Market,
} from "@plankton/domain";
import { slugPatternToRegex, matchesHorizon } from "@plankton/domain";
import type { Logger } from "../../logger.js";

export interface NormalizationModuleDeps {
  bus: EventBus;
  rulesProvider: FamilyRulesProvider;
  marketRepo: MarketRepository;
  log: Logger;
}

interface CompiledPattern {
  family: FamilyIdentity;
  regex: RegExp;
}

export class NormalizationModule implements RuntimeModule {
  private unsubscribe: (() => void) | null = null;
  private readonly log: Logger;
  private patterns: CompiledPattern[] = [];

  constructor(private readonly deps: NormalizationModuleDeps) {
    this.log = deps.log.child({ module: "normalization" });
  }

  async start(): Promise<void> {
    this.buildPatternCache();

    this.unsubscribe = this.deps.bus.subscribe(
      "MarketSnapshotReceived",
      async (payload) => { await this.handleSnapshot(payload); },
    );

    this.log.info(
      { patterns: this.patterns.length },
      "normalization module started",
    );
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.log.info("normalization module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: this.unsubscribe !== null,
      detail: this.unsubscribe ? "subscribed" : "not started",
    };
  }

  private buildPatternCache(): void {
    const families = this.deps.rulesProvider.getAllFamilies();
    this.patterns = [];

    for (const family of families) {
      if (!family.slugPattern) continue;
      try {
        this.patterns.push({ family, regex: slugPatternToRegex(family.slugPattern) });
      } catch {
        this.log.warn(
          { familyId: String(family.familyId), pattern: family.slugPattern },
          "invalid slug pattern — skipping",
        );
      }
    }
  }

  private matchFamily(slug: string, endDate: string | null): FamilyIdentity | null {
    for (const { family, regex } of this.patterns) {
      if (regex.test(slug) && matchesHorizon(family.horizon, endDate, new Date())) {
        return family;
      }
    }
    return null;
  }

  private async handleSnapshot(payload: {
    readonly markets: readonly NormalizedMarket[];
    readonly timestamp: number;
  }): Promise<void> {
    const enriched: NormalizedMarket[] = [];
    const now = new Date().toISOString();

    for (const market of payload.markets) {
      const family = this.matchFamily(market.slug, market.endDate);

      enriched.push({
        ...market,
        familyId: family?.familyId ?? null,
        familyKey: family?.familyKey ?? null,
        regime: family?.regime ?? null,
        horizon: family?.horizon ?? null,
      });

      this.deps.marketRepo.save({
        tokenId: market.tokenId,
        conditionId: market.conditionId,
        slug: market.slug,
        eventSlug: market.eventSlug,
        question: market.question,
        outcome: market.outcome,
        familyId: family?.familyId ?? null,
        familyKey: family?.familyKey ?? null,
        regime: family?.regime ?? null,
        horizon: family?.horizon ?? null,
        endDate: market.endDate,
        active: market.active,
        tickSize: market.tickSize,
        negRisk: market.negRisk,
        createdAt: now,
        updatedAt: now,
      });
    }

    this.log.info(
      { total: enriched.length, matched: enriched.filter((m) => m.familyId !== null).length },
      "normalization complete",
    );

    await this.deps.bus.publish("NormalizedMarketUpdated", {
      markets: enriched,
      timestamp: Date.now(),
    });
  }
}
