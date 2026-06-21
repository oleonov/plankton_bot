const POLYMARKET_POSITIONS_URL = "https://data-api.polymarket.com/positions";
const POSITIONS_PAGE_SIZE = 500;
const MAX_POSITIONS_PAGES = 20;

export interface PolymarketDataPosition {
  tokenId: string;
  conditionId: string | null;
  size: number;
  currentValueUsdc: number;
  initialValueUsdc: number;
  redeemable: boolean;
  slug: string | null;
  marketSlug: string | null;
  outcome: string | null;
  raw: Record<string, unknown>;
}

export interface PolymarketPositionAggregate {
  positionValueUsdc: number;
  positionCount: number;
  costBasisUsdc: number;
  capturedAt: string;
}

export type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

export interface FetchPolymarketPositionsOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  userAgent?: string;
}

export interface PolymarketPositionReader {
  read(): Promise<PolymarketDataPosition[] | null>;
}

interface PolymarketPositionsPage {
  rawCount: number;
  positions: PolymarketDataPosition[];
}

function numericField(raw: Record<string, unknown>, field: string): number {
  const value = raw[field];
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringField(raw: Record<string, unknown>, ...fields: string[]): string | null {
  for (const field of fields) {
    const value = raw[field];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function booleanField(raw: Record<string, unknown>, field: string): boolean {
  const value = raw[field];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.toLowerCase() === "true" || value === "1";
  return false;
}

export function normalizePolymarketPosition(
  raw: Record<string, unknown>,
): PolymarketDataPosition | null {
  const tokenId = stringField(raw, "asset", "asset_id", "token_id", "tokenId");
  if (!tokenId) return null;

  return {
    tokenId,
    conditionId: stringField(raw, "conditionId", "condition_id"),
    size: numericField(raw, "size"),
    currentValueUsdc: numericField(raw, "currentValue"),
    initialValueUsdc: numericField(raw, "initialValue"),
    redeemable: booleanField(raw, "redeemable"),
    slug: stringField(raw, "slug"),
    marketSlug: stringField(raw, "marketSlug", "market_slug"),
    outcome: stringField(raw, "outcome"),
    raw,
  };
}

export function aggregatePolymarketPositions(
  positions: readonly PolymarketDataPosition[],
  capturedAt: string,
): PolymarketPositionAggregate {
  return positions.reduce<PolymarketPositionAggregate>(
    (acc, position) => {
      if (position.size <= 0) return acc;
      acc.positionCount += 1;
      acc.positionValueUsdc += position.currentValueUsdc;
      acc.costBasisUsdc += position.initialValueUsdc;
      return acc;
    },
    { positionValueUsdc: 0, positionCount: 0, costBasisUsdc: 0, capturedAt },
  );
}

export async function fetchPolymarketPositions(
  funderAddress: string,
  options: FetchPolymarketPositionsOptions = {},
): Promise<PolymarketDataPosition[] | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const positions: PolymarketDataPosition[] = [];

  for (let pageIndex = 0; pageIndex < MAX_POSITIONS_PAGES; pageIndex += 1) {
    const offset = pageIndex * POSITIONS_PAGE_SIZE;
    const page = await fetchPolymarketPositionsPage(funderAddress, offset, fetchImpl, options);
    if (page === null) return null;
    positions.push(...page.positions);
    if (page.rawCount < POSITIONS_PAGE_SIZE) return positions;
  }
  return null;
}

async function fetchPolymarketPositionsPage(
  funderAddress: string,
  offset: number,
  fetchImpl: FetchLike,
  options: FetchPolymarketPositionsOptions,
): Promise<PolymarketPositionsPage | null> {
  const url = new URL(POLYMARKET_POSITIONS_URL);
  url.searchParams.set("user", funderAddress);
  url.searchParams.set("sizeThreshold", "0");
  url.searchParams.set("limit", String(POSITIONS_PAGE_SIZE));
  if (offset > 0) url.searchParams.set("offset", String(offset));

  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": options.userAgent ?? "krabs/1.0",
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }

    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return null;
    const positions = data
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
      .map((item) => normalizePolymarketPosition(item))
      .filter((item): item is PolymarketDataPosition => item !== null);
    return { rawCount: data.length, positions };
  } catch {
    return null;
  }
}

export class PolymarketDataPositionReader implements PolymarketPositionReader {
  constructor(
    private readonly funderAddress: string,
    private readonly options: FetchPolymarketPositionsOptions = {},
  ) {}

  read(): Promise<PolymarketDataPosition[] | null> {
    return fetchPolymarketPositions(this.funderAddress, this.options);
  }
}
