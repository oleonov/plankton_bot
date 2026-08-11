/**
 * #134 P1 — findActivePositions must pick a DETERMINISTIC winner per token.
 *
 * Migration 032's unique index is partial (`positions(token_id) WHERE status = 'open'`), so one
 * `open` row legally coexists with any number of `dust` rows on a token. Handing a dust row to a
 * revaluing writer while an open row exists is what promotes it to a *second* open row and raises
 * SQLITE_CONSTRAINT (the #133 crash class).
 *
 * These tests pin the ranking itself: status first, then newest `openedAt`, then `positionId`.
 * They fail against the pre-fix implementation, which returned whichever row came last out of the
 * unordered `findOpen()` / `findDust()` reads.
 */

import { describe, it, expect } from "vitest";
import { createConditionId, createPositionId, createTokenId } from "@krabs/domain";
import type { Position, PositionRepository } from "@krabs/domain";
import {
  compareActivePositions,
  findActivePositionRows,
  findActivePositions,
} from "../active-positions.js";

const TOKEN_ID = createTokenId("tok-active-positions");
const COND_ID = createConditionId("cond-active-positions");

function makePosition(
  id: string,
  status: Position["status"],
  openedAt: string,
  tokenId = TOKEN_ID,
): Position {
  return {
    positionId: createPositionId(id),
    tokenId,
    conditionId: COND_ID,
    side: "buy",
    size: 10,
    avgEntryPrice: 0.4,
    costBasisUsdc: 4,
    currentValueUsdc: 4,
    realizedPnl: 0,
    status,
    entryStyle: "probe",
    openedAt,
    closedAt: null,
    updatedAt: openedAt,
  };
}

function makeRepo(open: Position[], dust: Position[]): PositionRepository {
  return {
    findOpen: () => open,
    findDust: () => dust,
  } as unknown as PositionRepository;
}

describe("compareActivePositions — ranking tiers (negative = a outranks b)", () => {
  it("tier 1 — status: open outranks dust regardless of the other tiers", () => {
    const open = makePosition("pos-open", "open", "2026-08-11T10:00:00.000Z");
    // Every tier below status favors the dust row (newer, higher id) to prove status wins anyway.
    const dust = makePosition("pos-zzz", "dust", "2026-08-11T12:00:00.000Z");

    expect(compareActivePositions(open, dust)).toBeLessThan(0);
    expect(compareActivePositions(dust, open)).toBeGreaterThan(0);
  });

  it("tier 2 — finiteness: a parseable openedAt outranks an unparseable one when status ties", () => {
    const valid = makePosition("pos-a", "dust", "2026-08-11T10:00:00.000Z");
    // Older instant and lower id than `valid` to prove finiteness, not those tiers, decides.
    const broken = makePosition("pos-z", "dust", "not-a-timestamp");

    expect(compareActivePositions(valid, broken)).toBeLessThan(0);
    expect(compareActivePositions(broken, valid)).toBeGreaterThan(0);
  });

  it("tier 3 — instant: the newer openedAt outranks the older one when status and finiteness tie", () => {
    const newer = makePosition("pos-a", "dust", "2026-08-11T12:00:00.000Z");
    // Lower id than `newer` to prove the instant tier, not positionId, decides.
    const older = makePosition("pos-z", "dust", "2026-08-11T10:00:00.000Z");

    expect(compareActivePositions(newer, older)).toBeLessThan(0);
    expect(compareActivePositions(older, newer)).toBeGreaterThan(0);
  });

  it("tier 4 — positionId: the greater id outranks the lower one when every prior tier ties", () => {
    const sameInstant = "2026-08-11T10:00:00.000Z";
    const higher = makePosition("pos-b", "dust", sameInstant);
    const lower = makePosition("pos-a", "dust", sameInstant);

    expect(compareActivePositions(higher, lower)).toBeLessThan(0);
    expect(compareActivePositions(lower, higher)).toBeGreaterThan(0);
  });

  it("returns 0 for a row compared against itself (every tier ties)", () => {
    const position = makePosition("pos-a", "dust", "2026-08-11T10:00:00.000Z");

    expect(compareActivePositions(position, position)).toBe(0);
  });
});

describe("findActivePositions — one deterministic winner per token", () => {
  it("prefers the open row over a dust row on the same token", () => {
    // The dust row is NEWER on purpose: status must outrank recency, because the open row is the
    // one the partial unique index protects and the one the exit machinery drives.
    const open = makePosition("pos-open", "open", "2026-08-11T10:00:00.000Z");
    const dust = makePosition("pos-dust", "dust", "2026-08-11T12:00:00.000Z");

    expect(findActivePositions(makeRepo([open], [dust]))).toEqual([open]);
    // Order of arrival must not matter — the pre-fix map-overwrite was order-dependent.
    expect(findActivePositions(makeRepo([], [dust, open]))).toEqual([open]);
  });

  it("picks the newest openedAt when two dust rows share a token", () => {
    const older = makePosition("pos-a", "dust", "2026-08-11T10:00:00.000Z");
    const newer = makePosition("pos-b", "dust", "2026-08-11T12:00:00.000Z");

    expect(findActivePositions(makeRepo([], [older, newer]))).toEqual([newer]);
    expect(findActivePositions(makeRepo([], [newer, older]))).toEqual([newer]);
  });

  it("breaks an openedAt tie on positionId, matching findByTokenId's ordering", () => {
    const sameInstant = "2026-08-11T10:00:00.000Z";
    const lower = makePosition("pos-a", "dust", sameInstant);
    const higher = makePosition("pos-b", "dust", sameInstant);

    expect(findActivePositions(makeRepo([], [lower, higher]))).toEqual([higher]);
    expect(findActivePositions(makeRepo([], [higher, lower]))).toEqual([higher]);
  });

  it("compares openedAt across the two ledger renderings, not as raw strings", () => {
    // The ledger stores both ISO ("2026-08-11T12:00:00.000Z") and SQLite ("2026-08-11 12:00:00")
    // renderings. A raw string compare would rank " " > "T" and pick the OLDER row.
    const newerIso = makePosition("pos-a", "dust", "2026-08-11T12:00:00.000Z");
    const olderSqlite = makePosition("pos-b", "dust", "2026-08-11 10:00:00");

    expect(findActivePositions(makeRepo([], [newerIso, olderSqlite]))).toEqual([newerIso]);
  });

  it("ranks a parseable openedAt above an unparseable one, whatever the arrival order", () => {
    // parseLedgerInstantMs returns NaN here, and every comparison against NaN is false — so a bare
    // `>` would let whichever row arrived first keep the win.
    const valid = makePosition("pos-a", "dust", "2026-08-11T10:00:00.000Z");
    const broken = makePosition("pos-b", "dust", "not-a-timestamp");

    expect(findActivePositions(makeRepo([], [valid, broken]))).toEqual([valid]);
    expect(findActivePositions(makeRepo([], [broken, valid]))).toEqual([valid]);
  });

  it("falls back to positionId when neither openedAt parses", () => {
    const lower = makePosition("pos-a", "dust", "");
    const higher = makePosition("pos-b", "dust", "not-a-timestamp");

    expect(findActivePositions(makeRepo([], [lower, higher]))).toEqual([higher]);
    expect(findActivePositions(makeRepo([], [higher, lower]))).toEqual([higher]);
  });

  it("keeps one row per token and leaves distinct tokens untouched", () => {
    const otherToken = createTokenId("tok-other");
    const a = makePosition("pos-a", "open", "2026-08-11T10:00:00.000Z");
    const b = makePosition("pos-b", "dust", "2026-08-11T11:00:00.000Z", otherToken);

    const result = findActivePositions(makeRepo([a], [b]));
    expect(result).toHaveLength(2);
    expect(new Set(result.map((p) => String(p.positionId)))).toEqual(new Set(["pos-a", "pos-b"]));
  });

  it("tolerates a repository without findDust (open rows only)", () => {
    const open = makePosition("pos-open", "open", "2026-08-11T10:00:00.000Z");
    const repo = { findOpen: () => [open] } as unknown as PositionRepository;

    expect(findActivePositions(repo)).toEqual([open]);
  });
});

describe("findActivePositionRows — every non-closed row, no dedup", () => {
  it("keeps BOTH rows when a token holds an open and a dust position", () => {
    // The aggregating consumers depend on this: exposure is the sum over all rows a token holds,
    // and a revaluation loop must touch the dust row too or its mark never refreshes again.
    const open = makePosition("pos-open", "open", "2026-08-11T10:00:00.000Z");
    const dust = makePosition("pos-dust", "dust", "2026-08-11T12:00:00.000Z");

    const rows = findActivePositionRows(makeRepo([open], [dust]));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((p) => String(p.positionId)))).toEqual(
      new Set(["pos-open", "pos-dust"]),
    );
    // The deduped read over the same repo still collapses to the open winner.
    expect(findActivePositions(makeRepo([open], [dust]))).toEqual([open]);
  });

  it("tolerates a repository without findDust", () => {
    const open = makePosition("pos-open", "open", "2026-08-11T10:00:00.000Z");
    const repo = { findOpen: () => [open] } as unknown as PositionRepository;

    expect(findActivePositionRows(repo)).toEqual([open]);
  });
});
