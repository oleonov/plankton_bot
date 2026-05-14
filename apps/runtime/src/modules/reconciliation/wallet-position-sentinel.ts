import type {
  FillRepository,
  MarketRepository,
  Position,
  PositionRepository,
  TokenId,
} from "@krabs/domain";
import { createTokenId } from "@krabs/domain";
import type { PolymarketDataPosition, PolymarketPositionReader } from "@krabs/exchange";
import type { Logger } from "../../logger.js";
import { resolveOpenPositionStatus } from "../../position-status.js";

const MIN_REMOTE_SIZE = 1e-9;
const MISSING_REMOTE_GRACE_MS = 2 * 60 * 1000;
const ACTIVE_SIZE_DRIFT_GRACE_MS = 2 * 60 * 1000;
// Polymarket data-api returns size with 4 decimals; local DB stores 6.
// 1e-3 is the smallest absolute tolerance that absorbs every legitimate
// rounding gap without masking real shortfalls (a real share-count drift
// at $0.50/token is worth ≥ $0.0005, which is below our minimum order size).
const SIZE_DRIFT_EPSILON = 1e-3;
const MISSING_REMOTE_MICRO_DUST_MAX_SIZE = 0.01 + 1e-9;
const MISSING_REMOTE_MICRO_DUST_MAX_VALUE_USDC = 0.01 + 1e-9;
// Number of consecutive missing-remote observations needed before the
// sentinel will reach out for on-chain confirmation. Two passes (≥5 min apart
// in production) guards against transient data-api lapses without delaying
// the heal indefinitely.
const MISSING_REMOTE_STABILITY_REQUIRED = 2;

export interface WalletPositionSentinelResult {
  driftCount: number;
  details: string[];
  markUpdateCount: number;
  closedLivePositions: ClosedLivePositionDrift[];
  activePositionDrifts: ActivePositionSizeDrift[];
  /**
   * Local has an open/dust position with size > 0, but Polymarket reports
   * either no row for the token or a zero/dust balance — and the market is
   * still live (endDate in the future or unknown). Means we believe we own
   * shares the wallet does not actually hold; root cause stays visible
   * because the sentinel never repairs state.
   */
  missingRemotePositions: MissingRemotePositionDrift[];
  /**
   * Positions auto-closed by the sentinel after two consecutive missing-remote
   * observations were corroborated by an on-chain CTF balance of zero. Empty
   * unless both a CTF balance reader and a stability map are supplied via deps.
   */
  autoClosedMissingRemotePositions: AutoClosedMissingRemotePosition[];
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

export interface ActivePositionSizeDrift {
  tokenId: TokenId;
  positionId: string;
  slug: string | null;
  localSize: number;
  remoteSize: number;
  remoteCurrentValueUsdc: number;
}

export interface MissingRemotePositionDrift {
  tokenId: TokenId;
  positionId: string;
  slug: string | null;
  localStatus: "open" | "dust";
  localSize: number;
  remoteSize: number;
  endDate: string | null;
}

export interface AutoClosedMissingRemotePosition {
  tokenId: TokenId;
  positionId: string;
  slug: string | null;
  prevSize: number;
  prevCurrentValueUsdc: number;
  prevStatus: "open" | "dust";
  consecutiveObservations: number;
}

export interface WalletPositionSentinelDeps {
  reader: PolymarketPositionReader;
  positionRepo: PositionRepository;
  fillRepo?: FillRepository;
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
    markUpdateCount: 0,
    closedLivePositions: [],
    activePositionDrifts: [],
    missingRemotePositions: [],
    autoClosedMissingRemotePositions: [],
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
  const closedDrifts: ClosedLivePositionDrift[] = [];
  const activeDrifts: ActivePositionSizeDrift[] = [];
  const missingRemoteDrifts: MissingRemotePositionDrift[] = [];
  // Reserved for the caller-side auto-close pass that runs after this sentinel
  // returns. The sentinel itself never populates this array — it stays empty
  // here and the caller fills it via mutation of the returned result when a
  // confirmed missing-remote drift crosses the stability threshold.
  const autoClosedMissingRemote: AutoClosedMissingRemotePosition[] = [];
  let markUpdateCount = 0;

  // Tokens for which Polymarket reports a meaningful position. Used below to
  // detect the inverse case (local active/dust but no remote row) without
  // double-counting tokens that already produced an active-size mismatch.
  const remoteTokensWithSize = new Set<string>();

  for (const remote of remotePositions) {
    if (remote.size <= MIN_REMOTE_SIZE) continue;
    remoteTokensWithSize.add(remote.tokenId);

    const localPositions = localByToken.get(remote.tokenId);
    if (!localPositions) continue;

    const active = latestActivePosition(localPositions);
    if (active) {
      if (applyRemoteMark(deps.positionRepo, active, remote, nowMs)) {
        markUpdateCount++;
      }
      if (Math.abs(active.size - remote.size) > SIZE_DRIFT_EPSILON) {
        if (isWithinRecentFillGrace(deps.fillRepo, active.tokenId, nowMs)) continue;
        const market = deps.marketRepo.findByTokenId(createTokenId(remote.tokenId));
        activeDrifts.push({
          tokenId: createTokenId(remote.tokenId),
          positionId: String(active.positionId),
          slug: market?.slug ?? remote.slug ?? remote.marketSlug,
          localSize: active.size,
          remoteSize: remote.size,
          remoteCurrentValueUsdc: remote.currentValueUsdc,
        });
      }
      continue;
    }

    const closed = latestPosition(localPositions);
    if (!closed || closed.status !== "closed") continue;

    const market = deps.marketRepo.findByTokenId(createTokenId(remote.tokenId));
    if (!market?.endDate || !isFutureEndDate(market.endDate, nowMs)) continue;
    if (isWithinRecentFillGrace(deps.fillRepo, createTokenId(remote.tokenId), nowMs)) continue;

    closedDrifts.push({
      tokenId: createTokenId(remote.tokenId),
      positionId: String(closed.positionId),
      slug: market.slug ?? remote.slug ?? remote.marketSlug,
      localStatus: "closed",
      remoteSize: remote.size,
      remoteCurrentValueUsdc: remote.currentValueUsdc,
      endDate: market.endDate,
    });
  }

  // Inverse direction: local DB still believes we own shares, but the wallet
  // does not. Skipped for closed/already-resolved local rows (those go through
  // the closed-vs-live branch above) and for markets past endDate (a redeem
  // path will collapse them; no useful drift signal there).
  for (const [tokenIdStr, localPositions] of localByToken) {
    if (remoteTokensWithSize.has(tokenIdStr)) continue;
    const active = latestMissingRemoteDriftPosition(localPositions);
    if (!active) continue;
    if (active.status !== "open" && active.status !== "dust") continue;
    // Same data-api 4-decimal rounding gap that gated the direct-mismatch path:
    // a sub-epsilon local balance can read as zero remotely without that being
    // a real drift. Skipping here keeps the inverse-direction branch from
    // re-introducing the v138 false-positive class for tiny dust rows.
    if (active.size <= SIZE_DRIFT_EPSILON) continue;
    if (isMissingRemoteMicroDust(active)) continue;
    if (isWithinMissingRemoteGrace(active, nowMs)) continue;

    const market = deps.marketRepo.findByTokenId(createTokenId(tokenIdStr));
    // Skip markets that have already ended — redemption is the legitimate
    // sink for those local rows; non-zero balance there is handled by the
    // settlement-ledger drift detector, not the wallet sentinel.
    if (market?.endDate && !isFutureEndDate(market.endDate, nowMs)) continue;

    missingRemoteDrifts.push({
      tokenId: createTokenId(tokenIdStr),
      positionId: String(active.positionId),
      slug: market?.slug ?? null,
      localStatus: active.status,
      localSize: active.size,
      remoteSize: 0,
      endDate: market?.endDate ?? null,
    });
  }

  return {
    driftCount: closedDrifts.length + activeDrifts.length + missingRemoteDrifts.length,
    markUpdateCount,
    details: [
      ...closedDrifts.map(formatClosedDriftDetail),
      ...activeDrifts.map(formatActiveDriftDetail),
      ...missingRemoteDrifts.map(formatMissingRemoteDriftDetail),
    ],
    closedLivePositions: closedDrifts,
    activePositionDrifts: activeDrifts,
    missingRemotePositions: missingRemoteDrifts,
    autoClosedMissingRemotePositions: autoClosedMissingRemote,
  };
}

function applyRemoteMark(
  positionRepo: PositionRepository,
  position: Position,
  remote: PolymarketDataPosition,
  nowMs: number,
): boolean {
  if (!Number.isFinite(remote.currentValueUsdc)) return false;
  // Defence against upstream bug: Polymarket prices are bounded to [0,1].
  // Any remote.currentValueUsdc > position.size implies price > $1, which
  // is impossible. Drop the update; W4 fallback will recompute.
  if (
    Number.isFinite(position.size) &&
    position.size > 0 &&
    remote.currentValueUsdc > position.size + 1e-9
  ) {
    return false;
  }

  const nextStatus = resolveOpenPositionStatus(remote.currentValueUsdc);
  if (
    position.currentValueUsdc !== null &&
    Math.abs(position.currentValueUsdc - remote.currentValueUsdc) < 0.001 &&
    position.status === nextStatus
  ) {
    return false;
  }

  positionRepo.save({
    ...position,
    currentValueUsdc: remote.currentValueUsdc,
    status: nextStatus,
    updatedAt: new Date(nowMs).toISOString(),
  });
  return true;
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

function latestPosition(positions: readonly Position[]): Position | null {
  let latest: Position | null = null;
  for (const position of positions) {
    if (!latest || Date.parse(position.updatedAt) > Date.parse(latest.updatedAt)) {
      latest = position;
    }
  }
  return latest;
}

function latestActivePosition(positions: readonly Position[]): Position | null {
  return latestPosition(
    positions.filter((position) => position.status !== "closed" && position.size > 0),
  );
}

function latestMissingRemoteDriftPosition(positions: readonly Position[]): Position | null {
  const activePositions = positions.filter(
    (position) => position.status !== "closed" && position.size > 0,
  );
  const reportablePositions = activePositions.filter(
    (position) => !isMissingRemoteMicroDust(position),
  );
  return latestPosition(reportablePositions) ?? latestPosition(activePositions);
}

function isFutureEndDate(endDate: string, nowMs: number): boolean {
  const endMs = Date.parse(endDate);
  return Number.isFinite(endMs) && endMs > nowMs;
}

function isWithinMissingRemoteGrace(position: Position, nowMs: number): boolean {
  const latestLocalChangeMs = Math.max(
    Date.parse(position.openedAt),
    Date.parse(position.updatedAt),
  );
  return (
    Number.isFinite(latestLocalChangeMs) && nowMs - latestLocalChangeMs < MISSING_REMOTE_GRACE_MS
  );
}

function isWithinRecentFillGrace(
  fillRepo: FillRepository | undefined,
  tokenId: TokenId,
  nowMs: number,
): boolean {
  if (!fillRepo) return false;
  const latestFill = getLatestFillForToken(fillRepo, tokenId);
  if (!latestFill) return false;
  const latestFillMs = Date.parse(latestFill.filledAt);
  return Number.isFinite(latestFillMs) && nowMs - latestFillMs < ACTIVE_SIZE_DRIFT_GRACE_MS;
}

function getLatestFillForToken(fillRepo: FillRepository, tokenId: TokenId) {
  const recent = fillRepo.findRecentByTokenId?.(tokenId, 1);
  if (recent && recent.length > 0) return recent[0] ?? null;

  let latest = null as ReturnType<FillRepository["findByTokenId"]>[number] | null;
  for (const fill of fillRepo.findByTokenId(tokenId)) {
    if (!latest || Date.parse(fill.filledAt) > Date.parse(latest.filledAt)) {
      latest = fill;
    }
  }
  return latest;
}

function isMissingRemoteMicroDust(position: Position): boolean {
  if (position.status !== "dust") return false;
  if (position.size > MISSING_REMOTE_MICRO_DUST_MAX_SIZE) return false;

  const currentValue =
    position.currentValueUsdc === null || !Number.isFinite(position.currentValueUsdc)
      ? 0
      : position.currentValueUsdc;
  const maxRemainingValue = Math.max(currentValue, position.costBasisUsdc);
  return maxRemainingValue <= MISSING_REMOTE_MICRO_DUST_MAX_VALUE_USDC;
}

function formatClosedDriftDetail(drift: ClosedLivePositionDrift): string {
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

function formatActiveDriftDetail(drift: ActivePositionSizeDrift): string {
  return [
    "wallet-live-position-size-mismatch",
    `token=${String(drift.tokenId)}`,
    `position=${drift.positionId}`,
    `slug=${drift.slug ?? "unknown"}`,
    `localSize=${drift.localSize}`,
    `remoteSize=${drift.remoteSize}`,
    `remoteValue=${drift.remoteCurrentValueUsdc}`,
  ].join(" ");
}

function formatMissingRemoteDriftDetail(drift: MissingRemotePositionDrift): string {
  return [
    "wallet-local-position-missing-remote",
    `token=${String(drift.tokenId)}`,
    `position=${drift.positionId}`,
    `slug=${drift.slug ?? "unknown"}`,
    `localStatus=${drift.localStatus}`,
    `localSize=${drift.localSize}`,
    `remoteSize=${drift.remoteSize}`,
    `endDate=${drift.endDate ?? "unknown"}`,
  ].join(" ");
}

export function formatAutoClosedMissingRemoteDetail(
  entry: AutoClosedMissingRemotePosition,
): string {
  return [
    "wallet-local-position-auto-closed",
    `token=${String(entry.tokenId)}`,
    `position=${entry.positionId}`,
    `slug=${entry.slug ?? "unknown"}`,
    `prevStatus=${entry.prevStatus}`,
    `prevSize=${entry.prevSize}`,
    `prevValueUsdc=${entry.prevCurrentValueUsdc}`,
    `observations=${entry.consecutiveObservations}`,
    "crossCheck=onchain-zero",
  ].join(" ");
}

export const MISSING_REMOTE_AUTO_CLOSE_STABILITY_REQUIRED = MISSING_REMOTE_STABILITY_REQUIRED;
