import type Database from "better-sqlite3";

const POLYMARKET_POSITIONS_URL = "https://data-api.polymarket.com/positions";
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

interface PolymarketPositionAggregate {
  positionValueUsdc: number;
  positionCount: number;
  costBasisUsdc: number;
  capturedAt: string;
}

interface CachedAggregate {
  expiresAtMs: number;
  value: PolymarketPositionAggregate;
}

type RawPolymarketPosition = Record<string, unknown>;

function numericField(raw: RawPolymarketPosition, field: string): number {
  const value = raw[field];
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function aggregatePositions(
  positions: RawPolymarketPosition[],
  capturedAt: string,
): PolymarketPositionAggregate {
  return positions.reduce<PolymarketPositionAggregate>(
    (acc, position) => {
      const size = numericField(position, "size");
      if (size <= 0) return acc;
      acc.positionCount += 1;
      acc.positionValueUsdc += numericField(position, "currentValue");
      acc.costBasisUsdc += numericField(position, "initialValue");
      return acc;
    },
    { positionValueUsdc: 0, positionCount: 0, costBasisUsdc: 0, capturedAt },
  );
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
    const url = new URL(POLYMARKET_POSITIONS_URL);
    url.searchParams.set("user", funderAddress);
    url.searchParams.set("sizeThreshold", "0");

    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "poly-plankton/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }

      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) return null;
      return aggregatePositions(data as RawPolymarketPosition[], capturedAt);
    } catch {
      return null;
    }
  }
}
