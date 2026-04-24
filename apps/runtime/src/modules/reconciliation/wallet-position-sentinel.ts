import type { MarketRepository, Position, PositionRepository, TokenId } from "@plankton/domain";
import { createTokenId } from "@plankton/domain";
import type { PolymarketDataPosition, PolymarketPositionReader } from "@plankton/exchange";
import type { Logger } from "../../logger.js";

const MIN_REMOTE_SIZE = 1e-9;

export interface WalletPositionSentinelResult {
  driftCount: number;
  details: string[];
  closedLivePositions: ClosedLivePositionDrift[];
}

export interface ClosedLivePositionDrift {
  tokenId: TokenId;
  positionId: string;
  slug: string | null;
  localStatus: "closed";
  remoteSize: number;
  remoteCurrentValueUsdc: number;
  endDate: string;
}

export interface WalletPositionSentinelDeps {
  reader: PolymarketPositionReader;
  positionRepo: PositionRepository;
  marketRepo: MarketRepository;
  log: Logger;
}

export async function runWalletPositionSentinel(
  deps: WalletPositionSentinelDeps,
  nowMs = Date.now(),
): Promise<WalletPositionSentinelResult> {
  const empty: WalletPositionSentinelResult = {
    driftCount: 0,
    details: [],
    closedLivePositions: [],
  };

  let remotePositions: PolymarketDataPosition[] | null;
  try {
    remotePositions = await deps.reader.read();
  } catch (err) {
    deps.log.warn({ err }, "wallet position sentinel read failed");
    return empty;
  }
  if (!remotePositions) return empty;

  const localByToken = groupPositionsByToken(deps.positionRepo.findAll());
  const drifts: ClosedLivePositionDrift[] = [];

  for (const remote of remotePositions) {
    if (remote.size <= MIN_REMOTE_SIZE) continue;

    const localPositions = localByToken.get(remote.tokenId);
    if (!localPositions || hasActivePosition(localPositions)) continue;

    const closed = latestPosition(localPositions);
    if (!closed || closed.status !== "closed") continue;

    const market = deps.marketRepo.findByTokenId(createTokenId(remote.tokenId));
    if (!market?.endDate || !isFutureEndDate(market.endDate, nowMs)) continue;

    drifts.push({
      tokenId: createTokenId(remote.tokenId),
      positionId: String(closed.positionId),
      slug: market.slug ?? remote.slug ?? remote.marketSlug,
      localStatus: "closed",
      remoteSize: remote.size,
      remoteCurrentValueUsdc: remote.currentValueUsdc,
      endDate: market.endDate,
    });
  }

  return {
    driftCount: drifts.length,
    details: drifts.map(formatDriftDetail),
    closedLivePositions: drifts,
  };
}

function groupPositionsByToken(positions: readonly Position[]): Map<string, Position[]> {
  const byToken = new Map<string, Position[]>();
  for (const position of positions) {
    const key = String(position.tokenId);
    const existing = byToken.get(key);
    if (existing) {
      existing.push(position);
    } else {
      byToken.set(key, [position]);
    }
  }
  return byToken;
}

function hasActivePosition(positions: readonly Position[]): boolean {
  return positions.some((position) => position.status !== "closed" && position.size > 0);
}

function latestPosition(positions: readonly Position[]): Position | null {
  let latest: Position | null = null;
  for (const position of positions) {
    if (!latest || Date.parse(position.updatedAt) > Date.parse(latest.updatedAt)) {
      latest = position;
    }
  }
  return latest;
}

function isFutureEndDate(endDate: string, nowMs: number): boolean {
  const endMs = Date.parse(endDate);
  return Number.isFinite(endMs) && endMs > nowMs;
}

function formatDriftDetail(drift: ClosedLivePositionDrift): string {
  return [
    "wallet-live-position-closed-locally",
    `token=${String(drift.tokenId)}`,
    `position=${drift.positionId}`,
    `slug=${drift.slug ?? "unknown"}`,
    `remoteSize=${drift.remoteSize}`,
    `remoteValue=${drift.remoteCurrentValueUsdc}`,
    `endDate=${drift.endDate}`,
  ].join(" ");
}
