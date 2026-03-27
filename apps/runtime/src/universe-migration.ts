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
  InventoryLotRepository,
  FamilyIdentity,
  Position,
} from "@plankton/domain";
import { slugPatternToRegex, matchesHorizon } from "@plankton/domain";
import type { Logger } from "./logger.js";

export interface UniverseMigrationDeps {
  positionRepo: PositionRepository;
  marketRepo: MarketRepository;
  lotRepo: InventoryLotRepository;
  families: FamilyIdentity[];
  log: Logger;
}

export interface MigrationResult {
  closedCount: number;
  closedPositionIds: string[];
}

export function migrateOrphanedPositions(deps: UniverseMigrationDeps): MigrationResult {
  const { positionRepo, marketRepo, families, log } = deps;
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
    const openPositions = positions.filter((p) => p.status === "open" || p.status === "dust");

    for (const pos of openPositions) {
      const market = marketRepo.findByTokenId(pos.tokenId);
      if (!market) {
        if (needsSettlementBeforeClose(deps.lotRepo, pos)) {
          log.warn(
            { positionId: String(pos.positionId), familyId: String(pos.familyId) },
            "skipping close — no market found but position has open lots, needs recovery",
          );
        } else {
          closePosition(positionRepo, pos, nowIso);
          closed.push(String(pos.positionId));
        }
        continue;
      }

      const slugMatches = regex.test(market.slug);
      const horizonMatches = matchesHorizon(family.horizon, market.endDate, now);

      if (!slugMatches || !horizonMatches) {
        if (needsSettlementBeforeClose(deps.lotRepo, pos)) {
          log.warn(
            {
              positionId: String(pos.positionId),
              familyId: String(pos.familyId),
              slug: market.slug,
            },
            "skipping close — market no longer in universe but position has open lots, needs recovery",
          );
        } else {
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

function needsSettlementBeforeClose(lotRepo: InventoryLotRepository, pos: Position): boolean {
  if (pos.size > 0) return true;
  const lots = lotRepo.findOpen(pos.positionId);
  return lots.length > 0;
}

function closePosition(repo: PositionRepository, pos: Position, nowIso: string): void {
  repo.save({
    ...pos,
    status: "closed",
    closedAt: nowIso,
    updatedAt: nowIso,
  });
}
