import type {
  EventBus,
  FillRepository,
  MarketRepository,
  Position,
  PositionRepository,
  TokenId,
} from "@krabs/domain";
import { createTokenId } from "@krabs/domain";
import { parseLedgerInstantMs } from "@krabs/db";
import type { PolymarketDataPosition, PolymarketPositionReader } from "@krabs/exchange";
import type { Logger } from "../../logger.js";
import type { LatestUsablePriceLookup } from "../../market-snapshot-pricing.js";
import {
  blockedByConflictingOpenPosition,
  resolveDustPromotion,
} from "../../open-position-conflict.js";
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
export interface WalletPositionSentinelResult {
  driftCount: number;
  details: string[];
  markUpdateCount: number;
  skippedInvalidInputTokens: number;
  missingRemoteRevaluedCount?: number;
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

export interface WalletPositionSentinelDeps {
  reader: PolymarketPositionReader;
  positionRepo: PositionRepository;
  fillRepo?: FillRepository;
  marketRepo: MarketRepository;
  log: Logger;
  bus?: Pick<EventBus, "publish"> | undefined;
  latestUsablePriceLookup?: Pick<LatestUsablePriceLookup, "findUsablePrice"> | undefined;
  latestMinOrderSize?: ((tokenId: TokenId) => number | null) | undefined;
}

export async function runWalletPositionSentinel(
  deps: WalletPositionSentinelDeps,
  nowMs = Date.now(),
  preloadedRemotePositions?: readonly PolymarketDataPosition[] | null,
): Promise<WalletPositionSentinelResult> {
  const empty: WalletPositionSentinelResult = {
    driftCount: 0,
    details: [],
    markUpdateCount: 0,
    skippedInvalidInputTokens: 0,
    missingRemoteRevaluedCount: 0,
    closedLivePositions: [],
    activePositionDrifts: [],
    missingRemotePositions: [],
  };

  let remotePositions: readonly PolymarketDataPosition[] | null;
  if (preloadedRemotePositions !== undefined) {
    remotePositions = preloadedRemotePositions;
  } else {
    try {
      remotePositions = await deps.reader.read();
    } catch (err) {
      deps.log.warn({ err }, "wallet position sentinel read failed");
      return empty;
    }
  }
  if (!remotePositions) return empty;

  const localByToken = groupPositionsByToken(deps.positionRepo.findAll());
  const closedDrifts: ClosedLivePositionDrift[] = [];
  const activeDrifts: ActivePositionSizeDrift[] = [];
  const missingRemoteDrifts: MissingRemotePositionDrift[] = [];
  let markUpdateCount = 0;
  let missingRemoteRevaluedCount = 0;
  let skippedInvalidInputTokens = 0;

  // Tokens for which Polymarket reports a meaningful position. Used below to
  // detect the inverse case (local active/dust but no remote row) without
  // double-counting tokens that already produced an active-size mismatch.
  const remoteTokensWithSize = new Set<string>();

  for (const remote of remotePositions) {
    const localPositions = localByToken.get(remote.tokenId) ?? [];
    const activeRows = localPositions.filter((position) => position.status !== "closed");
    const invalidReason = validateTokenInputs(remote, activeRows);
    if (invalidReason) {
      remoteTokensWithSize.add(remote.tokenId);
      skippedInvalidInputTokens++;
      deps.log.warn(
        { tokenId: remote.tokenId, reason: invalidReason },
        "wallet sentinel: skipping token — invalid valuation input",
      );
      continue;
    }
    if (remote.size <= MIN_REMOTE_SIZE) continue;
    remoteTokensWithSize.add(remote.tokenId);
    if (localPositions.length === 0) continue;

    const active = latestActivePosition(localPositions);
    if (active) {
      const pricePerShare = remote.currentValueUsdc / remote.size;
      for (const row of activeRows) {
        const updated = applyRemoteMark(deps, row, pricePerShare, nowMs);
        if (updated) {
          markUpdateCount++;
          await publishOpenToDustTransition(deps, row, updated);
        }
      }
      const aggregateLocalSize = activeRows.reduce((sum, row) => sum + row.size, 0);
      if (Math.abs(aggregateLocalSize - remote.size) > SIZE_DRIFT_EPSILON) {
        if (isWithinRecentFillGrace(deps.fillRepo, active.tokenId, nowMs)) continue;
        const market = deps.marketRepo.findByTokenId(createTokenId(remote.tokenId));
        activeDrifts.push({
          tokenId: createTokenId(remote.tokenId),
          positionId: String(active.positionId),
          slug: market?.slug ?? remote.slug ?? remote.marketSlug,
          localSize: aggregateLocalSize,
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

    const revalued = applyMissingRemoteRevaluation(deps, active, nowMs);
    if (revalued) {
      missingRemoteRevaluedCount++;
      await publishOpenToDustTransition(deps, active, revalued);
    }

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
    skippedInvalidInputTokens,
    missingRemoteRevaluedCount,
    details: [
      ...closedDrifts.map(formatClosedDriftDetail),
      ...activeDrifts.map(formatActiveDriftDetail),
      ...missingRemoteDrifts.map(formatMissingRemoteDriftDetail),
    ],
    closedLivePositions: closedDrifts,
    activePositionDrifts: activeDrifts,
    missingRemotePositions: missingRemoteDrifts,
  };
}

function applyMissingRemoteRevaluation(
  deps: WalletPositionSentinelDeps,
  active: Position,
  nowMs: number,
): Position | null {
  const lookup = deps.latestUsablePriceLookup;
  if (!lookup) return null;

  const fallbackPrice = lookup.findUsablePrice(active.tokenId, nowMs);
  const newValue =
    fallbackPrice !== null && Number.isFinite(fallbackPrice) ? active.size * fallbackPrice : null;
  const nextStatus: Position["status"] =
    active.status === "closed"
      ? "closed"
      : newValue !== null
        ? resolveOpenPositionStatus(newValue, {
            size: active.size,
            minOrderSize: deps.latestMinOrderSize?.(active.tokenId) ?? null,
          })
        : active.status;
  const stored = active.currentValueUsdc;
  const valueChanged =
    (stored === null) !== (newValue === null) ||
    (newValue !== null && stored !== null && Math.abs(newValue - stored) >= 0.001);
  const statusChanged = active.status !== nextStatus;

  if (!valueChanged && !statusChanged) return null;

  const updated: Position = {
    ...active,
    currentValueUsdc: newValue,
    status: nextStatus,
    updatedAt: new Date(nowMs).toISOString(),
  };
  if (
    blockedByConflictingOpenPosition(
      deps.positionRepo,
      deps.log,
      updated,
      "applyMissingRemoteRevaluation",
    )
  ) {
    return null;
  }
  deps.positionRepo.save(updated);
  return updated;
}

function applyRemoteMark(
  deps: WalletPositionSentinelDeps,
  position: Position,
  pricePerShare: number,
  nowMs: number,
): Position | null {
  if (!Number.isFinite(pricePerShare)) return null;
  // Defence against upstream bug: Polymarket prices are bounded to [0,1].
  // Any remote.currentValueUsdc > position.size implies price > $1, which
  // is impossible. Drop the update; W4 fallback will recompute.
  if (pricePerShare > 1 + 1e-9) {
    return null;
  }
  if (!Number.isFinite(position.size) || position.size < 0) return null;
  const rowValueUsdc = position.size * pricePerShare;

  const nextStatus = resolveOpenPositionStatus(rowValueUsdc, {
    size: position.size,
    minOrderSize: deps.latestMinOrderSize?.(position.tokenId) ?? null,
  });
  if (
    position.currentValueUsdc !== null &&
    Math.abs(position.currentValueUsdc - rowValueUsdc) < 0.001 &&
    position.status === nextStatus
  ) {
    return null;
  }

  const updated: Position = {
    ...position,
    currentValueUsdc: rowValueUsdc,
    status: nextStatus,
    updatedAt: new Date(nowMs).toISOString(),
  };
  const toSave = resolveDustPromotion(
    deps.positionRepo,
    deps.log,
    position,
    updated,
    "applyRemoteMark",
  );
  if (!toSave) return null;
  deps.positionRepo.save(toSave);
  return toSave;
}

function validateTokenInputs(
  remote: PolymarketDataPosition,
  activeRows: readonly Position[],
): string | null {
  if (!Number.isFinite(remote.currentValueUsdc) || remote.currentValueUsdc < 0) {
    return "invalid_remote_current_value";
  }
  if (!Number.isFinite(remote.size) || remote.size < 0) return "invalid_remote_size";
  if (activeRows.some((row) => !Number.isFinite(row.size) || row.size < 0)) {
    return "invalid_local_size";
  }
  return null;
}

async function publishOpenToDustTransition(
  deps: WalletPositionSentinelDeps,
  previous: Position,
  next: Position,
): Promise<void> {
  if (!deps.bus) return;
  if (previous.status !== "open" || next.status !== "dust") return;
  try {
    await deps.bus.publish("PositionUpdated", { position: next });
  } catch (err) {
    deps.log.warn({ err, positionId: next.positionId }, "failed to publish open-to-dust update");
  }
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
    if (
      !latest ||
      parseLedgerInstantMs(position.updatedAt) > parseLedgerInstantMs(latest.updatedAt)
    ) {
      latest = position;
    }
  }
  return latest;
}

/**
 * Prefer the `open` row when a token holds several non-closed rows.
 *
 * Migration 032's index is partial, so one `open` row legally coexists with dust rows. Ranking the
 * candidates purely by `updatedAt` can land on a newer dust row — and re-saving that row as `open`
 * is exactly what `blockedByConflictingOpenPosition` refuses, so D/E would return `null`, change
 * nothing, and re-select the same row on the next cycle forever. The `open` row is both the live
 * tradable position and the one the guard always lets through, so the sentinel makes progress.
 *
 * `latestPosition` is deliberately left alone: the closed-position path below relies on its plain
 * newest-wins ordering.
 */
function latestOpenPreferred(positions: readonly Position[]): Position | null {
  const open = positions.filter((position) => position.status === "open");
  return latestPosition(open.length > 0 ? open : positions);
}

function latestActivePosition(positions: readonly Position[]): Position | null {
  return latestOpenPreferred(
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
  return latestOpenPreferred(reportablePositions) ?? latestOpenPreferred(activePositions);
}

function isFutureEndDate(endDate: string, nowMs: number): boolean {
  const endMs = Date.parse(endDate);
  return Number.isFinite(endMs) && endMs > nowMs;
}

function isWithinMissingRemoteGrace(position: Position, nowMs: number): boolean {
  const latestLocalChangeMs = Math.max(
    parseLedgerInstantMs(position.openedAt),
    parseLedgerInstantMs(position.updatedAt),
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
