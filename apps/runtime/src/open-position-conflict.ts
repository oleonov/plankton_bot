import type { Position, PositionRepository } from "@krabs/domain";
import type { Logger } from "./logger.js";

/**
 * Migration 032 guards `positions(token_id) WHERE status = 'open'` with a PARTIAL unique index, and
 * `position-repository.save()` only declares `ON CONFLICT(position_id)` — so a writer that promotes
 * a row to `open` while another `open` row already exists for the token gets a raw
 * SQLITE_CONSTRAINT with no context about which two rows collided.
 *
 * This is a best-effort read, not a guarantee: only the writers inside an IMMEDIATE transaction see
 * an atomic check-then-write. Elsewhere a concurrent process can still create the conflicting row
 * between this read and the save, and the index — not this function — remains the authority. What
 * the guard buys is a diagnosable log and a sane per-site disposition for the sequential case.
 *
 * `ignorePositionId` covers a narrower staleness than the above: a row the caller has ALREADY
 * queued for demotion out of `open` earlier in the SAME transaction. This function only ever reads
 * persisted state, so it cannot see that queued write — without the exclusion it would treat the
 * about-to-be-demoted row as a live conflict and wrongly decline the promotion it is making room
 * for. Default `undefined` preserves today's behaviour for every other caller.
 */
export function blockedByConflictingOpenPosition(
  positionRepo: Pick<PositionRepository, "findActiveByTokenId">,
  log: Pick<Logger, "error">,
  next: Position,
  site: string,
  ignorePositionId?: string | null,
): boolean {
  if (next.status !== "open") return false;

  const conflicting = positionRepo
    .findActiveByTokenId(next.tokenId)
    .find(
      (row) =>
        row.status === "open" &&
        row.positionId !== next.positionId &&
        (ignorePositionId == null || String(row.positionId) !== String(ignorePositionId)),
    );
  if (!conflicting) return false;

  log.error(
    {
      site,
      tokenId: next.tokenId,
      positionId: next.positionId,
      conflictingPositionId: conflicting.positionId,
    },
    "refusing to promote position to open — token already has a different open position",
  );
  return true;
}

export function resolveDustPromotion(
  positionRepo: Pick<PositionRepository, "findActiveByTokenId" | "findByTokenId">,
  log: Pick<Logger, "error" | "warn">,
  pos: Position,
  updated: Position,
  site: string,
  ignorePositionId?: string | null,
): Position | null {
  if (updated.status !== "open") return updated;
  let declined = blockedByConflictingOpenPosition(
    positionRepo,
    log,
    updated,
    site,
    ignorePositionId,
  );
  if (!declined && pos.status === "dust") {
    const winner = positionRepo.findByTokenId?.(pos.tokenId) ?? pos;
    if (winner?.positionId !== pos.positionId) {
      declined = true;
      log.warn(
        {
          site,
          tokenId: pos.tokenId,
          positionId: pos.positionId,
          winnerPositionId: winner?.positionId ?? null,
        },
        "declined dust promotion — not the findByTokenId winner for this token",
      );
    }
  }
  if (!declined) return updated;
  return pos.status === "dust" ? { ...updated, status: "dust" } : null;
}

export function openPositionConflictError(next: Position, site: string): Error {
  return new Error(
    `${site}: refusing to promote position ${next.positionId} to open — ` +
      `token ${next.tokenId} already has a different open position`,
  );
}
