import pino from "pino";
import { bootstrapDatabase } from "@plankton/db";
import {
  SqliteFamilyCandidateRepository,
  SqliteCandidateObservationRepository,
  SqliteFamilyCatalogRepository,
} from "@plankton/db";
import { GammaMarketDiscoveryGateway } from "@plankton/exchange";
import { createFamilyId } from "@plankton/domain";
import type { FamilyCandidate, CandidateObservationMarket } from "@plankton/domain";
import { clusterMarkets } from "./candidate-clusterer.js";
import { inferCategory, inferStrategyProfile } from "./category-inference.js";

const logger = pino({
  transport: { target: "pino-pretty", options: { colorize: true } },
});

const PRUNE_DAYS = 90;
const COOLDOWN_DAYS = 7;

async function scan(): Promise<void> {
  const dbPath = process.env["PLANKTON_DB_PATH"] ?? "data/plankton-sim.db";
  logger.info({ dbPath }, "Bootstrapping database");
  const conn = bootstrapDatabase(dbPath);

  const candidateRepo = new SqliteFamilyCandidateRepository(conn.db);
  const observationRepo = new SqliteCandidateObservationRepository(conn.db);
  const catalogRepo = new SqliteFamilyCatalogRepository(conn.db);

  // Fetch all active markets from Gamma API
  logger.info("Fetching markets from Gamma API");
  const gateway = new GammaMarketDiscoveryGateway();
  const markets = await gateway.discoverMarkets();
  logger.info({ marketCount: markets.length }, "Fetched markets");

  // Cluster markets into candidate families
  const clusters = clusterMarkets(markets);
  logger.info({ clusterCount: clusters.length }, "Clustered markets into candidates");

  // Load existing family catalog for matching
  const existingFamilies = catalogRepo.findAll();
  const familyIdSet = new Set(existingFamilies.map((f) => f.familyId));

  const now = new Date().toISOString();
  let upserted = 0;
  let matched = 0;

  // Process each cluster as a transaction
  for (const cluster of clusters) {
    const category = inferCategory(
      cluster.markets.map((m) => m.slug),
      [], // questions not available from slug-only clustering
    );
    const strategyProfile = inferStrategyProfile(cluster.regime, cluster.cadence);

    // Check if candidate matches an existing family
    const matchedFamilyId = familyIdSet.has(createFamilyId(cluster.candidateId))
      ? createFamilyId(cluster.candidateId)
      : null;

    if (matchedFamilyId) matched++;

    const endDates = cluster.markets
      .map((m) => m.endDate)
      .filter((d): d is string => d !== null);
    const nearestEndDate = endDates.length > 0
      ? endDates.sort()[0]!
      : null;

    const totalVolume = cluster.markets.reduce(
      (sum, m) => sum + (m.volume24h ?? 0),
      0,
    );

    const candidate: FamilyCandidate = {
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

    // Upsert candidate (preserve firstSeenAt if already exists)
    const existing = candidateRepo.findById(cluster.candidateId);
    if (existing) {
      candidate.firstSeenAt = existing.firstSeenAt;
      candidate.status = existing.status;
      candidate.reviewedAt = existing.reviewedAt;
      candidate.materializedAt = existing.materializedAt;
    }
    candidateRepo.upsert(candidate);
    upserted++;

    // Insert observation summary
    observationRepo.insertObservation({
      candidateId: cluster.candidateId,
      activeMarketCount: cluster.markets.length,
      clusterVolume24h: totalVolume,
      nearestEndDate,
      observedAt: now,
    });

    // Insert observation markets
    const obsMarkets: CandidateObservationMarket[] = cluster.markets.map((m) => ({
      candidateId: cluster.candidateId,
      observedAt: now,
      conditionId: m.conditionId,
      slug: m.slug,
      endDate: m.endDate,
      volume24h: m.volume24h ?? null,
    }));
    observationRepo.insertMarkets(obsMarkets);
  }

  logger.info(
    { upserted, matched, total: clusters.length },
    "Candidate upsert complete",
  );

  // ─── Pruning & cooldown (Task 6.5) ─────────────────────────────────────

  const pruneDate = new Date(Date.now() - PRUNE_DAYS * 86_400_000).toISOString();

  // Prune old observations
  const pruned = observationRepo.prune(pruneDate);
  if (pruned > 0) {
    logger.info({ pruned, olderThan: pruneDate }, "Pruned old observations");
  }

  // Delete stale discovered candidates not seen in 90 days
  const staleDeleted = conn.db
    .prepare(
      `DELETE FROM family_candidates
       WHERE last_seen_at < ? AND status = 'discovered'`,
    )
    .run(pruneDate);
  if (staleDeleted.changes > 0) {
    logger.info(
      { deleted: staleDeleted.changes },
      "Deleted stale discovered candidates",
    );
  }

  // Re-entry for rejected candidates: reset to discovered if
  // last_seen_at is more than 7 days after reviewed_at
  const cooldownResult = conn.db
    .prepare(
      `UPDATE family_candidates
       SET status = 'discovered'
       WHERE status = 'rejected'
         AND last_seen_at > datetime(reviewed_at, '+${COOLDOWN_DAYS} days')`,
    )
    .run();
  if (cooldownResult.changes > 0) {
    logger.info(
      { reEntered: cooldownResult.changes },
      "Re-entered rejected candidates past cooldown",
    );
  }

  conn.db.close();
  logger.info("Discovery scan complete");
}

scan().catch((err) => {
  logger.error(err, "Discovery scan failed");
  process.exitCode = 1;
});
