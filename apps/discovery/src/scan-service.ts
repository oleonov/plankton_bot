import type { Logger } from "pino";
import type { DbConnection } from "@plankton/db";
import type { MarketDiscoveryGateway, DiscoveryScanStats, FamilyCandidate, CandidateObservationMarket } from "@plankton/domain";
import {
  SqliteFamilyCandidateRepository,
  SqliteCandidateObservationRepository,
  SqliteFamilyCatalogRepository,
} from "@plankton/db";
import { GammaMarketDiscoveryGateway } from "@plankton/exchange";
import { createFamilyId } from "@plankton/domain";
import { clusterMarkets } from "./candidate-clusterer.js";
import { inferCategory, inferStrategyProfile } from "./category-inference.js";

const PRUNE_DAYS = 90;
const COOLDOWN_DAYS = 7;

export interface ScanServiceDeps {
  db: DbConnection["db"];
  log: Logger;
  gateway?: MarketDiscoveryGateway;
  onProgress?: () => void;
}

export class ScanService {
  constructor(private readonly deps: ScanServiceDeps) {}

  async run(): Promise<DiscoveryScanStats> {
    const { db, log, onProgress } = this.deps;
    const gateway = this.deps.gateway ?? new GammaMarketDiscoveryGateway();

    const candidateRepo = new SqliteFamilyCandidateRepository(db);
    const observationRepo = new SqliteCandidateObservationRepository(db);
    const catalogRepo = new SqliteFamilyCatalogRepository(db);

    // Fetch all active markets
    log.info("Fetching markets from Gamma API");
    const markets = await gateway.discoverMarkets();
    log.info({ marketCount: markets.length }, "Fetched markets");
    onProgress?.();

    // Cluster markets into candidate families
    const clusters = clusterMarkets(markets);
    log.info({ clusterCount: clusters.length }, "Clustered markets into candidates");
    onProgress?.();

    // Load existing family catalog for matching
    const existingFamilies = catalogRepo.findAll();
    const familyIdSet = new Set(existingFamilies.map((f) => f.familyId));

    const now = new Date().toISOString();
    let upserted = 0;
    let matched = 0;

    for (const cluster of clusters) {
      const candidate = this.buildCandidate(cluster, familyIdSet, now);
      if (candidate.matchedFamilyId) matched++;

      // Preserve fields from existing record
      const existing = candidateRepo.findById(cluster.candidateId);
      if (existing) {
        candidate.firstSeenAt = existing.firstSeenAt;
        candidate.status = existing.status;
        candidate.reviewedAt = existing.reviewedAt;
        candidate.materializedAt = existing.materializedAt;
      }
      candidateRepo.upsert(candidate);
      upserted++;

      // Insert observation summary + markets
      const totalVolume = cluster.markets.reduce((sum, m) => sum + (m.volume24h ?? 0), 0);
      const endDates = cluster.markets.map((m) => m.endDate).filter((d): d is string => d !== null);
      const nearestEndDate = endDates.length > 0 ? endDates.sort()[0]! : null;

      observationRepo.insertObservation({
        candidateId: cluster.candidateId,
        activeMarketCount: cluster.markets.length,
        clusterVolume24h: totalVolume,
        nearestEndDate,
        observedAt: now,
      });

      const obsMarkets: CandidateObservationMarket[] = cluster.markets.map((m) => ({
        candidateId: cluster.candidateId,
        observedAt: now,
        conditionId: m.conditionId,
        slug: m.slug,
        endDate: m.endDate,
        volume24h: m.volume24h ?? null,
      }));
      observationRepo.insertMarkets(obsMarkets);

      if (upserted % 10 === 0) onProgress?.();
    }

    log.info({ upserted, matched, total: clusters.length }, "Candidate upsert complete");

    // Pruning & cooldown
    const pruned = this.pruneAndCooldown(db, observationRepo, log);

    return {
      marketsFound: markets.length,
      clustersCreated: clusters.length,
      candidatesUpserted: upserted,
      matched,
      pruned,
    };
  }

  private buildCandidate(
    cluster: ReturnType<typeof clusterMarkets>[number],
    familyIdSet: Set<string>,
    now: string,
  ): FamilyCandidate {
    const category = inferCategory(cluster.markets.map((m) => m.slug), []);
    const strategyProfile = inferStrategyProfile(cluster.regime, cluster.cadence);
    const matchedFamilyId = familyIdSet.has(createFamilyId(cluster.candidateId))
      ? createFamilyId(cluster.candidateId)
      : null;

    const endDates = cluster.markets.map((m) => m.endDate).filter((d): d is string => d !== null);
    const nearestEndDate = endDates.length > 0 ? endDates.sort()[0]! : null;
    const totalVolume = cluster.markets.reduce((sum, m) => sum + (m.volume24h ?? 0), 0);

    return {
      candidateId: cluster.candidateId,
      familyKey: cluster.familyKey,
      regime: cluster.regime as FamilyCandidate["regime"],
      horizon: cluster.horizon,
      cadence: cluster.cadence,
      patternConfidence: cluster.patternConfidence,
      primaryCategory: category,
      strategyProfile: strategyProfile as FamilyCandidate["strategyProfile"],
      slugPattern: cluster.slugPattern,
      matchedFamilyId,
      activeMarketCount: cluster.markets.length,
      nearestEndDate,
      clusterVolume24h: totalVolume,
      recurrenceScore: null,
      recycleScore: null,
      liveViabilityScore: null,
      toxicityPenalty: null,
      gateRecommendation: "pending",
      recommendationReason: null,
      scoresUpdatedAt: null,
      status: "discovered",
      firstSeenAt: now,
      lastSeenAt: now,
      reviewedAt: null,
      materializedAt: null,
    };
  }

  private pruneAndCooldown(
    db: DbConnection["db"],
    observationRepo: InstanceType<typeof SqliteCandidateObservationRepository>,
    log: Logger,
  ): number {
    const pruneDate = new Date(Date.now() - PRUNE_DAYS * 86_400_000).toISOString();

    const pruned = observationRepo.prune(pruneDate);
    if (pruned > 0) log.info({ pruned, olderThan: pruneDate }, "Pruned old observations");

    const staleDeleted = db
      .prepare("DELETE FROM family_candidates WHERE last_seen_at < ? AND status = 'discovered'")
      .run(pruneDate);
    if (staleDeleted.changes > 0) {
      log.info({ deleted: staleDeleted.changes }, "Deleted stale discovered candidates");
    }

    const cooldownResult = db
      .prepare(
        `UPDATE family_candidates SET status = 'discovered'
         WHERE status = 'rejected' AND last_seen_at > datetime(reviewed_at, '+${COOLDOWN_DAYS} days')`,
      )
      .run();
    if (cooldownResult.changes > 0) {
      log.info({ reEntered: cooldownResult.changes }, "Re-entered rejected candidates past cooldown");
    }

    return pruned + staleDeleted.changes;
  }
}
