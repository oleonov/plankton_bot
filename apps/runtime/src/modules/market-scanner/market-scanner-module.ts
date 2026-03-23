/**
 * Market Scanner Module -- slow-cadence discovery of markets via Gamma API.
 *
 * Responsibilities:
 *  - Discover candidate markets from the exchange catalog
 *  - Match discovered markets against family slug patterns
 *  - Upsert matched markets into the DB as tracked markets
 *  - Run on startup (non-blocking) and on a configurable periodic interval
 *
 * Does NOT provide pricing -- that is MarketDataModule's job.
 */

import type {
  RuntimeModule,
  EventBus,
  MarketDiscoveryGateway,
  MarketRepository,
  FamilyRulesProvider,
  FamilyIdentity,
  Market,
  ClobMarket,
} from "@plankton/domain";
import { slugPatternToRegex, matchesHorizon, createTokenId, createFamilyId } from "@plankton/domain";
import type { Logger } from "../../logger.js";

export interface MarketScannerModuleDeps {
  discoveryGateway: MarketDiscoveryGateway;
  familyRules: FamilyRulesProvider;
  marketRepo: MarketRepository;
  bus: EventBus;
  log: Logger;
  scanIntervalMs: number;
}

interface CompiledFamily {
  identity: FamilyIdentity;
  regex: RegExp;
}

export class MarketScannerModule implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private lastSuccessfulScanMs = 0;
  private readonly log: Logger;

  constructor(private readonly deps: MarketScannerModuleDeps) {
    this.log = deps.log.child({ module: "market-scanner" });
  }

  async start(): Promise<void> {
    this.log.info(
      { intervalMs: this.deps.scanIntervalMs },
      "starting market-scanner module",
    );
    // Fire first scan without blocking startup
    this.scan().catch((err) => this.log.error({ err }, "initial scan failed"));
    this.timer = setInterval(() => {
      this.scan().catch((err) => this.log.error({ err }, "scan cycle error"));
    }, this.deps.scanIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info("market-scanner module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (this.lastSuccessfulScanMs === 0) {
      return { ok: false, detail: "no successful scan yet" };
    }
    const ageMs = Date.now() - this.lastSuccessfulScanMs;
    // Consider unhealthy if last scan was more than 3x the interval ago
    const stale = ageMs > this.deps.scanIntervalMs * 3;
    return {
      ok: !stale,
      detail: stale
        ? `stale: last scan ${Math.round(ageMs / 1000)}s ago`
        : `fresh: last scan ${Math.round(ageMs / 1000)}s ago`,
    };
  }

  /** Exposed for testing -- in production driven by the interval timer. */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    const startMs = Date.now();

    try {
      this.log.debug("scan cycle starting");

      const discovered = await this.deps.discoveryGateway.discoverMarkets();
      const families = this.deps.familyRules.getAllFamilies();
      const compiled = this.compileFamilyPatterns(families);

      let matchedCount = 0;
      const now = new Date().toISOString();
      const discoveredTokenIds = new Set<string>();

      for (const clobMarket of discovered) {
        const family = this.matchFamily(clobMarket.slug, clobMarket.endDate, compiled);
        if (!family) continue;

        for (const token of clobMarket.tokens) {
          const tokenId = createTokenId(token.tokenId);
          discoveredTokenIds.add(String(tokenId));
          const market: Market = {
            tokenId,
            conditionId: clobMarket.conditionId,
            slug: clobMarket.slug,
            eventSlug: clobMarket.eventSlug ?? null,
            question: clobMarket.question,
            outcome: token.outcome.toUpperCase() === "YES" ? "YES" : "NO",
            familyId: family.familyId,
            familyKey: family.familyKey,
            regime: family.regime,
            horizon: family.horizon,
            endDate: clobMarket.endDate || null,
            active: clobMarket.active,
            tickSize: clobMarket.tickSize,
            negRisk: clobMarket.negRisk,
            createdAt: now,
            updatedAt: now,
          };
          this.deps.marketRepo.save(market);
          matchedCount++;
        }
      }

      // Deactivate tracked markets that were not in the latest discovery result
      let deactivatedCount = 0;
      const previouslyActive = this.deps.marketRepo.findActive();
      for (const existing of previouslyActive) {
        if (!discoveredTokenIds.has(String(existing.tokenId))) {
          this.deps.marketRepo.save({ ...existing, active: false, updatedAt: now });
          deactivatedCount++;
        }
      }

      this.lastSuccessfulScanMs = Date.now();
      const durationMs = this.lastSuccessfulScanMs - startMs;

      this.log.info(
        {
          discovered: discovered.length,
          matched: matchedCount,
          deactivated: deactivatedCount,
          families: families.length,
          durationMs,
        },
        "scan cycle complete",
      );
    } catch (err) {
      this.log.error({ err }, "scan cycle failed");
    } finally {
      this.scanning = false;
    }
  }

  private compileFamilyPatterns(families: FamilyIdentity[]): CompiledFamily[] {
    const result: CompiledFamily[] = [];
    for (const identity of families) {
      if (!identity.slugPattern) continue;
      result.push({
        identity,
        regex: slugPatternToRegex(identity.slugPattern),
      });
    }
    return result;
  }

  private matchFamily(
    slug: string,
    endDate: string | null,
    compiled: CompiledFamily[],
  ): FamilyIdentity | null {
    for (const { identity, regex } of compiled) {
      if (regex.test(slug) && matchesHorizon(identity.horizon, endDate, new Date())) {
        return identity;
      }
    }
    return null;
  }
}
