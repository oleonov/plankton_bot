/**
 * ResolutionDetector — finds open/dust positions on markets past their endDate,
 * then queries Gamma API to confirm resolution status.
 */

import type {
  PositionRepository,
  MarketRepository,
  MarketResolutionRepository,
  TokenId,
  FamilyId,
  PositionId,
} from "@plankton/domain";
import type { GammaResolutionClient } from "@plankton/exchange";
import type { Logger } from "../../logger.js";

export interface ResolutionCandidate {
  tokenId: TokenId;
  conditionId: string;
  slug: string;
  outcome: "YES" | "NO";
  endDate: string;
  positionId: PositionId;
  familyId: FamilyId;
}

export interface DetectedResolution {
  conditionId: string;
  resolution: "YES" | "NO" | "unknown";
  resolvedAt: string;
  source: "gamma-api" | "gamma-delisted";
  rawResponse: string | null;
  candidates: ResolutionCandidate[];
}

export class ResolutionDetector {
  constructor(
    private readonly positionRepo: PositionRepository,
    private readonly marketRepo: MarketRepository,
    private readonly resolutionRepo: MarketResolutionRepository,
    private readonly gammaClient: GammaResolutionClient,
    private readonly log: Logger,
  ) {}

  async detect(graceMinutes: number): Promise<DetectedResolution[]> {
    // 1. Get all non-closed positions (open + dust)
    const openPositions = this.positionRepo.findOpen();
    const dustPositions = this.positionRepo.findDust();
    const allPositions = [...openPositions, ...dustPositions];

    if (allPositions.length === 0) return [];

    // 2. Join with market data to get endDate, conditionId, slug
    const tokenIds = allPositions.map((p) => p.tokenId);
    const markets = this.marketRepo.findByTokenIds(tokenIds);
    const marketByToken = new Map(markets.map((m) => [String(m.tokenId), m]));

    // 3. Filter for expired markets (endDate < now - graceMinutes)
    const now = Date.now();
    const graceMs = graceMinutes * 60_000;
    const candidates: ResolutionCandidate[] = [];

    for (const pos of allPositions) {
      const market = marketByToken.get(String(pos.tokenId));
      if (!market?.endDate) continue;

      const endMs = new Date(market.endDate).getTime();
      if (isNaN(endMs) || endMs > now - graceMs) continue;

      candidates.push({
        tokenId: pos.tokenId,
        conditionId: market.conditionId,
        slug: market.slug,
        outcome: market.outcome,
        endDate: market.endDate,
        positionId: pos.positionId,
        familyId: pos.familyId,
      });
    }

    if (candidates.length === 0) return [];

    // 4. Group by conditionId and skip already-resolved
    const byCondition = new Map<string, ResolutionCandidate[]>();
    for (const c of candidates) {
      const existing = this.resolutionRepo.findByConditionId(c.conditionId);
      if (existing && existing.status === "settled") continue;
      const group = byCondition.get(c.conditionId) ?? [];
      group.push(c);
      byCondition.set(c.conditionId, group);
    }

    // 5. Query Gamma API for each unique conditionId
    const results: DetectedResolution[] = [];

    for (const [conditionId, group] of byCondition) {
      const slug = group[0]!.slug;
      const detected = await this.queryResolution(conditionId, slug, group);
      if (detected) results.push(detected);
    }

    return results;
  }

  private async queryResolution(
    conditionId: string,
    slug: string,
    candidates: ResolutionCandidate[],
  ): Promise<DetectedResolution | null> {
    // Try slug lookup first (more readable in logs).
    // Gamma client returns null for genuine not-found and throws on errors.
    let info;
    try {
      info = await this.gammaClient.getMarketBySlug(slug);
    } catch (err) {
      this.log.warn(
        { conditionId, slug, err },
        "Gamma slug lookup failed (transport error) — skipping",
      );
      return null;
    }

    if (info) {
      if (!info.closed) {
        this.log.debug({ conditionId, slug }, "market not yet closed on Gamma");
        return null;
      }

      const resolution = this.inferResolution(info.umaResolutionStatus, info.rawPayload);
      return {
        conditionId,
        resolution,
        resolvedAt: info.closedTime ?? new Date().toISOString(),
        source: "gamma-api",
        rawResponse: JSON.stringify(info.rawPayload),
        candidates,
      };
    }

    // Slug not found — try conditionId as fallback before declaring delisted.
    // Note: /markets/{id} doesn't accept conditionId (returns 422, treated as not-found).
    // Kept as a defensive fallback; if both return null, market is declared delisted.
    let idInfo;
    try {
      idInfo = await this.gammaClient.getMarketById(conditionId);
    } catch (err) {
      this.log.warn({ conditionId, err }, "Gamma ID lookup failed (transport error) — skipping");
      return null;
    }

    if (idInfo) {
      if (!idInfo.closed) {
        this.log.debug({ conditionId, slug }, "market found by ID but not yet closed on Gamma");
        return null;
      }

      const resolution = this.inferResolution(idInfo.umaResolutionStatus, idInfo.rawPayload);
      return {
        conditionId,
        resolution,
        resolvedAt: idInfo.closedTime ?? new Date().toISOString(),
        source: "gamma-api",
        rawResponse: JSON.stringify(idInfo.rawPayload),
        candidates,
      };
    }

    // Both slug and ID lookups returned not-found — market genuinely delisted.
    this.log.info(
      { conditionId, slug },
      "market not found on Gamma by slug or ID — treating as delisted",
    );

    return {
      conditionId,
      resolution: "unknown",
      resolvedAt: candidates[0]!.endDate,
      source: "gamma-delisted",
      rawResponse: null,
      candidates,
    };
  }

  private inferResolution(
    umaStatus: string | null,
    rawPayload: Record<string, unknown>,
  ): "YES" | "NO" | "unknown" {
    // 1. tokens array with winner flag (some Gamma endpoints)
    const tokens = rawPayload.tokens as Array<Record<string, unknown>> | undefined;
    if (tokens && Array.isArray(tokens)) {
      for (const t of tokens) {
        if (t.winner === true) {
          return (t.outcome as string)?.toUpperCase() === "YES" ? "YES" : "NO";
        }
      }
    }

    // 2. outcomePrices + outcomes (Gamma /markets/slug/ endpoint).
    //    Both are stringified JSON arrays: outcomes '["Yes","No"]', outcomePrices '["1","0"]'.
    //    The outcome with price "1" is the winner.
    const winner = this.inferFromOutcomePrices(rawPayload);
    if (winner) return winner;

    // 3. Fallback: uma resolved but winner not determinable from above
    if (umaStatus === "resolved") {
      const outcome = (rawPayload.resolutionOutcome ?? rawPayload.resolution_outcome) as
        | string
        | undefined;
      if (outcome) return outcome.toUpperCase() === "YES" ? "YES" : "NO";
    }

    return "unknown";
  }

  private inferFromOutcomePrices(
    rawPayload: Record<string, unknown>,
  ): "YES" | "NO" | null {
    const rawOutcomes = rawPayload.outcomes;
    const rawPrices = rawPayload.outcomePrices;
    if (!rawOutcomes || !rawPrices) return null;

    try {
      const outcomes: unknown[] =
        typeof rawOutcomes === "string" ? JSON.parse(rawOutcomes) : rawOutcomes;
      const prices: unknown[] =
        typeof rawPrices === "string" ? JSON.parse(rawPrices) : rawPrices;

      if (!Array.isArray(outcomes) || !Array.isArray(prices)) return null;
      if (outcomes.length !== prices.length) return null;

      for (let i = 0; i < outcomes.length; i++) {
        if (Number(prices[i]) === 1) {
          return String(outcomes[i]).toUpperCase() === "YES" ? "YES" : "NO";
        }
      }
    } catch {
      return null;
    }

    return null;
  }
}
