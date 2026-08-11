/**
 * #134 P2 — the shared fail-closed guard for dust→open promotion.
 *
 * `position-repository.save()` declares only `ON CONFLICT(position_id)`, so promoting a row to
 * `open` while another open row holds the token surfaces as a raw SQLITE_CONSTRAINT with no
 * indication of which two rows collided. The guard turns that into a diagnosable log plus a
 * per-call-site disposition (throw at the fill writers, skip at the revaluing writers).
 */

import { describe, it, expect, vi } from "vitest";
import { createConditionId, createPositionId, createTokenId } from "@krabs/domain";
import type { Position, PositionRepository } from "@krabs/domain";
import type { Logger } from "../logger.js";
import {
  blockedByConflictingOpenPosition,
  openPositionConflictError,
} from "../open-position-conflict.js";

const TOKEN_ID = createTokenId("tok-conflict");
const COND_ID = createConditionId("cond-conflict");

function makePosition(id: string, status: Position["status"]): Position {
  return {
    positionId: createPositionId(id),
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    side: "buy",
    size: 10,
    avgEntryPrice: 0.4,
    costBasisUsdc: 4,
    currentValueUsdc: 4,
    realizedPnl: 0,
    status,
    entryStyle: "probe",
    openedAt: "2026-08-11T10:00:00.000Z",
    closedAt: null,
    updatedAt: "2026-08-11T10:00:00.000Z",
  };
}

function makeRepo(active: Position[]): Pick<PositionRepository, "findActiveByTokenId"> {
  return { findActiveByTokenId: () => active };
}

function makeLog() {
  return { error: vi.fn() } as unknown as Logger & { error: ReturnType<typeof vi.fn> };
}

describe("blockedByConflictingOpenPosition", () => {
  it("blocks and logs when a different open row already holds the token", () => {
    const incumbent = makePosition("pos-incumbent", "open");
    const next = makePosition("pos-next", "open");
    const log = makeLog();

    expect(blockedByConflictingOpenPosition(makeRepo([incumbent]), log, next, "siteX")).toBe(true);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toMatchObject({
      site: "siteX",
      positionId: next.positionId,
      conflictingPositionId: incumbent.positionId,
    });
  });

  it("allows a demotion to dust — the partial index permits many dust rows", () => {
    const incumbent = makePosition("pos-incumbent", "open");
    const next = makePosition("pos-next", "dust");
    const log = makeLog();

    expect(blockedByConflictingOpenPosition(makeRepo([incumbent]), log, next, "siteX")).toBe(false);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("allows re-saving the SAME open row (ON CONFLICT(position_id) handles it)", () => {
    const next = makePosition("pos-next", "open");
    const log = makeLog();

    expect(blockedByConflictingOpenPosition(makeRepo([next]), log, next, "siteX")).toBe(false);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("allows promotion when only dust rows hold the token", () => {
    const dust = makePosition("pos-dust", "dust");
    const next = makePosition("pos-next", "open");
    const log = makeLog();

    expect(blockedByConflictingOpenPosition(makeRepo([dust]), log, next, "siteX")).toBe(false);
  });

  it("excludes the row named by ignorePositionId from the conflict search", () => {
    const incumbent = makePosition("pos-incumbent", "open");
    const next = makePosition("pos-next", "open");
    const log = makeLog();

    expect(
      blockedByConflictingOpenPosition(
        makeRepo([incumbent]),
        log,
        next,
        "siteX",
        incumbent.positionId,
      ),
    ).toBe(false);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("still blocks on a DIFFERENT open row even when ignorePositionId is set", () => {
    const incumbent = makePosition("pos-incumbent", "open");
    const other = makePosition("pos-other", "open");
    const next = makePosition("pos-next", "open");
    const log = makeLog();

    expect(
      blockedByConflictingOpenPosition(
        makeRepo([incumbent, other]),
        log,
        next,
        "siteX",
        incumbent.positionId,
      ),
    ).toBe(true);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ conflictingPositionId: other.positionId }),
      expect.any(String),
    );
  });

  it("openPositionConflictError names the site, position and token", () => {
    const err = openPositionConflictError(makePosition("pos-next", "open"), "siteX");
    expect(err.message).toContain("siteX");
    expect(err.message).toContain("pos-next");
    expect(err.message).toContain(String(TOKEN_ID));
  });
});
