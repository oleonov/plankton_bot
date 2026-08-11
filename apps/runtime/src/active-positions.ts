import type { Position, PositionRepository } from "@krabs/domain";
import { parseLedgerInstantMs } from "@krabs/db";

/**
 * Negative when `a` outranks `b` — Array.prototype.sort order, best row first.
 *
 * Migration 032's unique index is PARTIAL — `ON positions(token_id) WHERE status = 'open'` — so one
 * `open` row may legally coexist with any number of `dust` rows for a token. When it does, the
 * winner must be the `open` row: that is the live tradable position the exit machinery drives and
 * the one the index protects. Revaluing it is safe in both directions (it either stays open and
 * writes no new row, or demotes to dust, which the partial index allows). Revaluing a dust row
 * instead is what promotes it to a *second* open row and raises SQLITE_CONSTRAINT.
 *
 * The status rank is not enough on its own: `findOpen()` / `findDust()` are unordered, so two dust
 * rows on a token (a state invariant I4 treats as reachable) would otherwise resolve to whichever
 * row SQLite happened to return last. Ranking newest-`openedAt`-first with a `positionId`
 * tie-break matches how `findByTokenId` / `findActiveByTokenId` pick their winner, so the next
 * writer that reaches for the token cannot disagree with this one.
 */
export function compareActivePositions(a: Position, b: Position): number {
  const aIsOpen = a.status === "open";
  const bIsOpen = b.status === "open";
  if (aIsOpen !== bIsOpen) return aIsOpen ? -1 : 1;

  // `parseLedgerInstantMs` returns NaN for an unparseable/absent `openedAt`, and every comparison
  // against NaN is false — so a bare `>` would neither rank a valid instant above an invalid one
  // nor fall through to the `positionId` tie-break, leaving the winner order-dependent again. Rank
  // finiteness first, matching the repository's SQL ordering where real `julianday` values sort
  // ahead of NULL and IDs break the remaining ties.
  const aMs = parseLedgerInstantMs(a.openedAt);
  const bMs = parseLedgerInstantMs(b.openedAt);
  const aHasInstant = Number.isFinite(aMs);
  const bHasInstant = Number.isFinite(bMs);
  if (aHasInstant !== bHasInstant) return aHasInstant ? -1 : 1;
  if (aHasInstant && aMs !== bMs) return bMs - aMs;

  const aId = String(a.positionId);
  const bId = String(b.positionId);
  if (aId !== bId) return aId > bId ? -1 : 1;
  return 0;
}

function betterCandidate(candidate: Position, incumbent: Position): boolean {
  return compareActivePositions(candidate, incumbent) < 0;
}

/**
 * EVERY non-closed row, with no per-token dedup.
 *
 * This is the right read for a consumer that AGGREGATES (capital at risk is the sum over all rows a
 * token holds, not the largest one) or that must TOUCH every row (a revaluation loop that only ever
 * sees the winner leaves the other rows' `current_value_usdc` stale forever). `findActivePositions`
 * below is the read for a consumer that needs the single live tradable position for a token.
 */
export function findActivePositionRows(positionRepo: PositionRepository): Position[] {
  const dust = typeof positionRepo.findDust === "function" ? positionRepo.findDust() : [];
  return [...positionRepo.findOpen(), ...dust];
}

export function findActivePositions(positionRepo: PositionRepository): Position[] {
  const byToken = new Map<string, Position>();
  for (const position of findActivePositionRows(positionRepo)) {
    const key = String(position.tokenId);
    const incumbent = byToken.get(key);
    if (!incumbent || betterCandidate(position, incumbent)) byToken.set(key, position);
  }
  return [...byToken.values()];
}
