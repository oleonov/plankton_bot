/**
 * ResolutionDetector — finds open/dust positions on markets past their endDate,
 * then queries Gamma API to confirm resolution status.
 */

import {
  createTokenId,
  type PositionRepository,
  type MarketRepository,
  type MarketResolutionRepository,
  type TokenId,
  type PositionId,
} from "@plankton/domain";
import type { GammaResolutionClient } from "@plankton/exchange";
import type { Logger } from "../../logger.js";

export interface ResolutionCandidate {
  tokenId: TokenId;
  conditionId: string;
  slug: string;
  outcome: string;
  endDate: string;
  positionId: PositionId;
}

export interface DetectedResolution {
  conditionId: string;
  resolution: string;
  winnerTokenId: TokenId | null;
  resolvedAt: string;
  source: "gamma-api" | "gamma-delisted";
  rawResponse: string | null;
  candidates: ResolutionCandidate[];
}

function parseOutcomes(rawPayload: Record<string, unknown>): string[] {
  const rawOutcomes = rawPayload.outcomes;
  if (!rawOutcomes) return [];
  try {
    const outcomes = typeof rawOutcomes === "string" ? JSON.parse(rawOutcomes) : rawOutcomes;
    return Array.isArray(outcomes) ? outcomes.map(String) : [];
  } catch {
    return [];
  }
}

/** Exported for use by resolution recovery path. */
export function inferResolution(
  umaStatus: string | null,
  rawPayload: Record<string, unknown>,
): { outcome: string; winnerIndex: number; winnerTokenId: string | null } | "unknown" {
  // 1. tokens array with winner flag (some Gamma endpoints)
  const tokens = rawPayload.tokens as Array<Record<string, unknown>> | undefined;
  if (tokens && Array.isArray(tokens)) {
    const outcomes = parseOutcomes(rawPayload);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]!.winner === true) {
        const directOutcome =
          typeof tokens[i]!.outcome === "string" && String(tokens[i]!.outcome).trim() !== ""
            ? String(tokens[i]!.outcome)
            : null;
        return {
          outcome: directOutcome ?? outcomes[i] ?? "",
          winnerIndex: i,
          winnerTokenId:
            typeof tokens[i]!.token_id === "string" ? String(tokens[i]!.token_id) : null,
        };
      }
    }
  }

  // 2. outcomePrices + outcomes (Gamma /markets/slug/ endpoint).
  const result = inferFromOutcomePrices(rawPayload);
  if (result) return result;

  // 3. Fallback: uma resolved but winner not determinable from above
  if (umaStatus === "resolved") {
    const outcome = (rawPayload.resolutionOutcome ?? rawPayload.resolution_outcome) as
      | string
      | undefined;
    if (outcome) return { outcome: String(outcome), winnerIndex: -1, winnerTokenId: null };
  }

  return "unknown";
}

function inferFromOutcomePrices(
  rawPayload: Record<string, unknown>,
): { outcome: string; winnerIndex: number; winnerTokenId: string | null } | null {
  const rawOutcomes = rawPayload.outcomes;
  const rawPrices = rawPayload.outcomePrices;
  if (!rawOutcomes || !rawPrices) return null;

  try {
    const outcomes: unknown[] =
      typeof rawOutcomes === "string" ? JSON.parse(rawOutcomes) : rawOutcomes;
    const prices: unknown[] = typeof rawPrices === "string" ? JSON.parse(rawPrices) : rawPrices;

    if (!Array.isArray(outcomes) || !Array.isArray(prices)) return null;
    if (outcomes.length !== prices.length) return null;

    for (let i = 0; i < outcomes.length; i++) {
      if (Number(prices[i]) === 1) {
        return { outcome: String(outcomes[i]), winnerIndex: i, winnerTokenId: null };
      }
    }
  } catch {
    return null;
  }

  return null;
}

/** Parse clobTokenIds from a Gamma API payload. Exported for resolution-module recovery. */
export function parseTokenIds(rawPayload: Record<string, unknown>): string[] {
  const raw = rawPayload.clobTokenIds;
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/** Map inferResolution result + Gamma payload into a DetectedResolution. */
function buildGammaResolution(
  conditionId: string,
  info: {
    closedTime?: string | null;
    umaResolutionStatus: string | null;
    rawPayload: Record<string, unknown>;
  },
  candidates: ResolutionCandidate[],
): DetectedResolution {
  const inferred = inferResolution(info.umaResolutionStatus, info.rawPayload);
  const clobTokenIds = parseTokenIds(info.rawPayload);
  const outcomes = parseOutcomes(info.rawPayload);
  const winnerTokenId =
    inferred !== "unknown" && inferred.winnerTokenId
      ? createTokenId(inferred.winnerTokenId)
      : inferred !== "unknown" && inferred.winnerIndex >= 0 && clobTokenIds[inferred.winnerIndex]
        ? createTokenId(clobTokenIds[inferred.winnerIndex]!)
        : null;
  const resolutionOutcome =
    inferred === "unknown"
      ? "unknown"
      : inferred.outcome.trim() !== ""
        ? inferred.outcome
        : winnerTokenId
          ? (candidates.find((candidate) => String(candidate.tokenId) === String(winnerTokenId))
              ?.outcome ??
            (inferred.winnerIndex >= 0 ? (outcomes[inferred.winnerIndex] ?? "unknown") : "unknown"))
          : inferred.winnerIndex >= 0
            ? (outcomes[inferred.winnerIndex] ?? "unknown")
            : "unknown";

  return {
    conditionId,
    resolution: resolutionOutcome,
    winnerTokenId,
    resolvedAt: info.closedTime ?? new Date().toISOString(),
    source: "gamma-api",
    rawResponse: JSON.stringify(info.rawPayload),
    candidates,
  };
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

  async detectCondition(conditionId: string): Promise<DetectedResolution | null> {
    const markets = this.marketRepo.findByConditionId(conditionId);
    if (markets.length === 0) return null;

    const tokenIds = new Set(markets.map((market) => String(market.tokenId)));
    const openPositions = this.positionRepo.findOpen();
    const dustPositions = this.positionRepo.findDust();
    const positions = [...openPositions, ...dustPositions].filter((position) =>
      tokenIds.has(String(position.tokenId)),
    );
    if (positions.length === 0) return null;

    const marketByToken = new Map(markets.map((market) => [String(market.tokenId), market]));
    const candidates: ResolutionCandidate[] = [];
    for (const position of positions) {
      const market = marketByToken.get(String(position.tokenId));
      if (!market) continue;
      candidates.push({
        tokenId: position.tokenId,
        conditionId: market.conditionId,
        slug: market.slug,
        outcome: market.outcome,
        endDate: market.endDate ?? new Date().toISOString(),
        positionId: position.positionId,
      });
    }
    if (candidates.length === 0) return null;
    return this.queryResolution(conditionId, markets[0]!.slug, candidates);
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

      return buildGammaResolution(conditionId, info, candidates);
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

      return buildGammaResolution(conditionId, idInfo, candidates);
    }

    // Both slug and ID lookups returned not-found — market genuinely delisted.
    this.log.info(
      { conditionId, slug },
      "market not found on Gamma by slug or ID — treating as delisted",
    );

    return {
      conditionId,
      resolution: "unknown",
      winnerTokenId: null,
      resolvedAt: candidates[0]!.endDate,
      source: "gamma-delisted",
      rawResponse: null,
      candidates,
    };
  }
}
