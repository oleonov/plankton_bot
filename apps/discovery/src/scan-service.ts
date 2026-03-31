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
import { IncrementalClusterer, type CandidateCluster } from "./candidate-clusterer.js";
import { inferCategory, inferStrategyProfile } from "./category-inference.js";

const PRUNE_DAYS = 90;
const COOLDOWN_DAYS = 7;
const LOW_VALUE_OBS_RETENTION_HOURS = 24;
const LOW_VALUE_CANDIDATE_RETENTION_DAYS = 3;

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

    // Stream markets page-by-page into the clusterer
    log.info("Fetching markets from Gamma API");
    const clusterer = new IncrementalClusterer();
    const { totalMarkets } = await gateway.forEachMarketPage((pageMarkets) => {
      clusterer.addBatch(pageMarkets);
    });
    log.info({ marketCount: totalMarkets }, "Fetched markets");
    onProgress?.();

    const clusters = clusterer.finalize();
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
    const pruned = this.pruneAndCooldown(db, observationRepo, candidateRepo, log);

    return {
      marketsFound: totalMarkets,
      clustersCreated: clusters.length,
      candidatesUpserted: upserted,
      matched,
      pruned,
    };
  }

  private buildCandidate(
    cluster: CandidateCluster,
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
    candidateRepo: InstanceType<typeof SqliteFamilyCandidateRepository>,
    log: Logger,
  ): number {
    // 1. Aggressive prune: low-value tail observation history (24h retention)
    const lowValueObsCutoff = new Date(
      Date.now() - LOW_VALUE_OBS_RETENTION_HOURS * 3_600_000,
    ).toISOString();
    const lowValueObsPruned = observationRepo.pruneLowValueTail(lowValueObsCutoff);
    if (lowValueObsPruned > 0) {
      log.info({ pruned: lowValueObsPruned, olderThan: lowValueObsCutoff }, "Pruned low-value tail observations");
    }

    // 2. Aggressive prune: stale low-value tail candidate rows (3d retention)
    // Must run AFTER observation prune to avoid FK violations
    const lowValueCandCutoff = new Date(
      Date.now() - LOW_VALUE_CANDIDATE_RETENTION_DAYS * 86_400_000,
    ).toISOString();
    const lowValueCandDeleted = candidateRepo.deleteStaleLowValueTail(lowValueCandCutoff);
    if (lowValueCandDeleted > 0) {
      log.info({ deleted: lowValueCandDeleted }, "Deleted stale low-value tail candidates");
    }

    // 3. Global prune: all observations older than 90 days
    const pruneDate = new Date(Date.now() - PRUNE_DAYS * 86_400_000).toISOString();
    const pruned = observationRepo.prune(pruneDate);
    if (pruned > 0) log.info({ pruned, olderThan: pruneDate }, "Pruned old observations");

    // 4. Global prune: stale discovered candidates older than 90 days
    const staleDeleted = db
      .prepare("DELETE FROM family_candidates WHERE last_seen_at < ? AND status = 'discovered'")
      .run(pruneDate);
    if (staleDeleted.changes > 0) {
      log.info({ deleted: staleDeleted.changes }, "Deleted stale discovered candidates");
    }

    // 5. Cooldown: re-enter rejected candidates after 7 days
    const cooldownResult = db
      .prepare(
        `UPDATE family_candidates SET status = 'discovered'
         WHERE status = 'rejected' AND last_seen_at > datetime(reviewed_at, '+${COOLDOWN_DAYS} days')`,
      )
      .run();
    if (cooldownResult.changes > 0) {
      log.info({ reEntered: cooldownResult.changes }, "Re-entered rejected candidates past cooldown");
    }

    return lowValueObsPruned + lowValueCandDeleted + pruned + staleDeleted.changes;
  }
}
