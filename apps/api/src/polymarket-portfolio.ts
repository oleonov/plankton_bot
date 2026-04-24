import type Database from "better-sqlite3";
import {
  aggregatePolymarketPositions,
  fetchPolymarketPositions,
  type PolymarketPositionAggregate,
} from "@plankton/exchange";

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export interface PolymarketPositionPortfolio {
  portfolioUsdc: number;
  availableUsdc: number;
  positionValueUsdc: number;
  positionCount: number;
  costBasisUsdc: number;
  source: "polymarket";
  capturedAt: string;
}

interface CachedAggregate {
  expiresAtMs: number;
  value: PolymarketPositionAggregate;
}

export function resolveLiveLiteFunderAddress(
  controlDb: Database.Database | undefined,
  profileId: string,
): string | null {
  if (!controlDb) return null;
  try {
    const row = controlDb
      .prepare("SELECT relayer_json FROM profile_settings WHERE profile_id = ?")
      .get(profileId) as { relayer_json: string | null } | undefined;
    if (!row?.relayer_json) return null;
    const parsed = JSON.parse(row.relayer_json) as Record<string, unknown>;
    const funder = parsed["funderAddress"] ?? parsed["funder"] ?? parsed["profileAddress"] ?? null;
    return typeof funder === "string" && EVM_ADDRESS_RE.test(funder) ? funder : null;
  } catch {
    return null;
  }
}

export class PolymarketPortfolioReader {
  private readonly cache = new Map<string, CachedAggregate>();

  constructor(private readonly cacheTtlMs = 30_000) {}

  async read(
    funderAddress: string,
    availableUsdc: number,
  ): Promise<PolymarketPositionPortfolio | null> {
    const now = Date.now();
    const aggregate = await this.fetchAggregate(funderAddress, now);
    if (!aggregate) return null;

    return {
      portfolioUsdc: availableUsdc + aggregate.positionValueUsdc,
      availableUsdc,
      positionValueUsdc: aggregate.positionValueUsdc,
      positionCount: aggregate.positionCount,
      costBasisUsdc: aggregate.costBasisUsdc,
      source: "polymarket",
      capturedAt: aggregate.capturedAt,
    };
  }

  private async fetchAggregate(
    funderAddress: string,
    nowMs: number,
  ): Promise<PolymarketPositionAggregate | null> {
    const cacheKey = funderAddress.toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs) return cached.value;

    const aggregate = await this.fetchFreshAggregate(funderAddress, new Date(nowMs).toISOString());
    if (!aggregate) return null;

    this.cache.set(cacheKey, { value: aggregate, expiresAtMs: nowMs + this.cacheTtlMs });
    return aggregate;
  }

  private async fetchFreshAggregate(
    funderAddress: string,
    capturedAt: string,
  ): Promise<PolymarketPositionAggregate | null> {
    const positions = await fetchPolymarketPositions(funderAddress);
    if (!positions) return null;
    return aggregatePolymarketPositions(positions, capturedAt);
  }
}
