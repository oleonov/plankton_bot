/**
 * Universe Migration — detects and closes positions whose underlying market
 * no longer matches the family's current slug pattern or horizon.
 *
 * This happens when the family config changes (e.g., slug_pattern updated,
 * horizon filter added). Without cleanup, orphaned positions continue to
 * consume family caps (openValueUsdc, openPositionCount, activeMarketCount)
 * and block new entries in the correct universe.
 *
 * Runs once at startup, before any modules start.
 */

import type {
  PositionRepository,
  MarketRepository,
  FamilyStateRepository,
  FamilyIdentity,
  Position,
} from "@plankton/domain";
import { slugPatternToRegex, matchesHorizon } from "@plankton/domain";
import type { Logger } from "./logger.js";

export interface UniverseMigrationDeps {
  positionRepo: PositionRepository;
  marketRepo: MarketRepository;
  familyStateRepo: FamilyStateRepository;
  families: FamilyIdentity[];
  log: Logger;
}

export interface MigrationResult {
  closedCount: number;
  closedPositionIds: string[];
}

export function migrateOrphanedPositions(deps: UniverseMigrationDeps): MigrationResult {
  const { positionRepo, marketRepo, familyStateRepo, families, log } = deps;
  const now = new Date();
  const nowIso = now.toISOString();
  const closed: string[] = [];

  for (const family of families) {
    if (!family.slugPattern) continue;

    let regex: RegExp;
    try {
      regex = slugPatternToRegex(family.slugPattern);
    } catch {
      continue;
    }

    const positions = positionRepo.findByFamily(family.familyId);
    const openPositions = positions.filter(
      (p) => p.status === "open" || p.status === "dust",
    );

    for (const pos of openPositions) {
      const market = marketRepo.findByTokenId(pos.tokenId);
      if (!market) {
        closePosition(positionRepo, pos, nowIso);
        closed.push(String(pos.positionId));
        continue;
      }

      const slugMatches = regex.test(market.slug);
      const horizonMatches = matchesHorizon(family.horizon, market.endDate, now);

      if (!slugMatches || !horizonMatches) {
        log.info(
          {
            positionId: String(pos.positionId),
            tokenId: String(pos.tokenId),
            slug: market.slug,
            familyId: String(family.familyId),
            slugMatches,
            horizonMatches,
          },
          "closing orphaned position — market no longer in family universe",
        );
        closePosition(positionRepo, pos, nowIso);
        closed.push(String(pos.positionId));
      }
    }

    // Recompute family state after closing orphans
    if (closed.length > 0) {
      const remaining = positionRepo.findByFamily(family.familyId);
      let openValueUsdc = 0;
      let openPositionCount = 0;
      let openDustCount = 0;
      const activeTokens = new Set<string>();

      for (const p of remaining) {
        if (p.status === "open") {
          openPositionCount++;
          openValueUsdc += p.costBasisUsdc;
          activeTokens.add(String(p.tokenId));
        } else if (p.status === "dust") {
          openDustCount++;
          openValueUsdc += p.costBasisUsdc;
          activeTokens.add(String(p.tokenId));
        }
      }

      const existing = familyStateRepo.get(family.familyId);
      if (existing) {
        familyStateRepo.save({
          ...existing,
          openValueUsdc,
          openPositionCount,
          openDustCount,
          activeMarketCount: activeTokens.size,
          updatedAt: nowIso,
        });
      }
    }
  }

  if (closed.length > 0) {
    log.info(
      { closedCount: closed.length, positionIds: closed },
      "universe migration complete — orphaned positions closed",
    );
  }

  return { closedCount: closed.length, closedPositionIds: closed };
}

function closePosition(
  repo: PositionRepository,
  pos: Position,
  nowIso: string,
): void {
  repo.save({
    ...pos,
    status: "closed",
    closedAt: nowIso,
    updatedAt: nowIso,
  });
}
