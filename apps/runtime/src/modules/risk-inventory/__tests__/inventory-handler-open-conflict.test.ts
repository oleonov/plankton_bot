/**
 * Open-position-conflict guard — call-site tests for InventoryHandler.
 *
 * Migration 032 guards `positions(token_id) WHERE status = 'open'` with a
 * partial unique index: exactly one `open` row per token, any number of
 * `dust` rows may coexist alongside it. Both InventoryHandler sites that can
 * promote a row to `open` — addToPosition (BUY fills, site A) and
 * saveSellOutcome (SELL fills whose remaining size recomputes back above
 * minOrderSize, site F) — call blockedByConflictingOpenPosition before
 * saving. A hit throws (rather than silently skipping) because the fill
 * already executed on the exchange; the surrounding IMMEDIATE transaction
 * rolls back the lot with it, leaving the fill unreconciled for replay.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createConditionId,
  createFillId,
  createLotId,
  createPositionId,
  createTokenId,
} from "@krabs/domain";
import type {
  InventoryLot,
  InventoryLotRepository,
  Position,
  PositionRepository,
} from "@krabs/domain";
import type { Logger } from "../../../logger.js";
import { InventoryHandler, type FillEvent } from "../inventory-handler.js";

const TOKEN_ID = createTokenId("tok-conflict-test");
const COND_ID = createConditionId("cond-conflict-test");

const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  silent: () => {},
  level: "silent",
  child: () => silentLog,
} as unknown as Logger;

/** Mock DB that satisfies InventoryHandler's pnl-ledger prepared statement. */
function makeMockDb() {
  return {
    prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
    transaction: vi.fn((fn: (...args: unknown[]) => unknown) => {
      const tx = (...args: unknown[]) => fn(...args);
      (tx as any).immediate = tx;
      return tx;
    }),
  } as any;
}

/**
 * Mock position repository that stores MULTIPLE rows per token — needed to model the exact state
 * migration 032 permits: one `open` row coexisting with any number of `dust` rows for the same
 * token. Mirrors SqlitePositionRepository's real semantics
 * (packages/db/src/repositories/position-repository.ts):
 *   - findByTokenId: the newest non-closed row, ordered by openedAt DESC then positionId DESC,
 *     status-blind (may return a dust row while an older open row still exists)
 *   - findActiveByTokenId: ALL non-closed rows in the same order
 *   - save: upsert by positionId
 */
function makePositionRepo(...initialPositions: Position[]): PositionRepository {
  const byId = new Map<string, Position>();
  for (const position of initialPositions) {
    byId.set(String(position.positionId), position);
  }

  function rowsForToken(tokenId: unknown): Position[] {
    return [...byId.values()]
      .filter((p) => String(p.tokenId) === String(tokenId))
      .sort(compareByOpenedAtThenPositionIdDesc);
  }

  return {
    save: vi.fn((pos: Position) => {
      byId.set(String(pos.positionId), pos);
    }),
    findByTokenId: vi.fn(
      (tokenId) => rowsForToken(tokenId).find((p) => p.status !== "closed") ?? null,
    ),
    findActiveByTokenId: vi.fn((tokenId) =>
      rowsForToken(tokenId).filter((p) => p.status !== "closed"),
    ),
    findOpen: vi.fn(() => []),
    findDust: vi.fn(() => []),
    findAll: vi.fn(() => [...byId.values()]),
    findOpenByEntryStyle: vi.fn(() => []),
    findById: vi.fn((id) => byId.get(String(id)) ?? null),
  } as unknown as PositionRepository;
}

/** `openedAt` DESC, `positionId` DESC — matches SqlitePositionRepository's ORDER BY. */
function compareByOpenedAtThenPositionIdDesc(a: Position, b: Position): number {
  const diff = Date.parse(b.openedAt) - Date.parse(a.openedAt);
  if (diff !== 0) return diff;
  return String(b.positionId).localeCompare(String(a.positionId));
}

function makeLot(overrides?: Partial<InventoryLot>): InventoryLot {
  const now = new Date().toISOString();
  return {
    lotId: createLotId("lot-seed"),
    positionId: createPositionId("pos-dust-existing"),
    tokenId: TOKEN_ID,
    side: "buy",
    size: 20,
    remainingSize: 20,
    entryPrice: 0.1,
    costUsdc: 2,
    fillId: createFillId("fill-seed"),
    createdAt: now,
    ...overrides,
  };
}

function makeLotRepo(overrides?: Partial<InventoryLotRepository>): InventoryLotRepository {
  return {
    save: vi.fn(),
    findByPositionId: vi.fn(() => []),
    findByTokenId: vi.fn(() => []),
    consumeFifo: vi.fn(() => []),
    findOpen: vi.fn(() => []),
    settleAll: vi.fn(),
    ...overrides,
  } as unknown as InventoryLotRepository;
}

function makeFill(overrides?: Partial<FillEvent>): FillEvent {
  return {
    fillId: createFillId("fill-1"),
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    side: "buy",
    price: 0.4,
    size: 10,
    sizeUsdc: 4,
    fee: 0,
    signalReason: "probe-entry",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeDustPosition(overrides?: Partial<Position>): Position {
  const now = new Date().toISOString();
  return {
    positionId: createPositionId("pos-dust-existing"),
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    side: "buy",
    size: 2,
    avgEntryPrice: 0.4,
    costBasisUsdc: 0.8,
    currentValueUsdc: 0.8,
    realizedPnl: 0,
    status: "dust",
    entryStyle: "probe",
    openedAt: now,
    closedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

/** A different open position for the same token — the conflict findActiveByTokenId surfaces. */
function makeConflictingOpenPosition(overrides?: Partial<Position>): Position {
  return {
    ...makeDustPosition(),
    positionId: createPositionId("pos-open-conflict"),
    status: "open",
    ...overrides,
  };
}

describe("InventoryHandler — open-position-conflict guard (BUY: addToPosition, site A)", () => {
  it("throws and does not save when the token already has a different open position", () => {
    const existing = makeDustPosition();
    const positionRepo = makePositionRepo(existing);
    const conflicting = makeConflictingOpenPosition();
    (positionRepo.findActiveByTokenId as ReturnType<typeof vi.fn>).mockReturnValue([conflicting]);
    const handler = new InventoryHandler(positionRepo, makeLotRepo(), silentLog, makeMockDb());

    expect(() => handler.applyFill(makeFill({ fillId: createFillId("fill-conflict") }))).toThrow(
      /refusing to promote/,
    );
    expect(positionRepo.save).not.toHaveBeenCalled();
  });

  it("saves normally when no conflicting open position exists for the token", () => {
    const existing = makeDustPosition();
    const positionRepo = makePositionRepo(existing);
    const handler = new InventoryHandler(positionRepo, makeLotRepo(), silentLog, makeMockDb());

    handler.applyFill(makeFill({ fillId: createFillId("fill-no-conflict") }));

    expect(positionRepo.save).toHaveBeenCalledTimes(1);
    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.status).toBe("open");
  });

  it("throws when the token has an older open row and a newer dust row that the BUY resolves to", () => {
    // The exact state the guard exists for: findByTokenId (status-blind, newest-first) hands the
    // BUY handler the newer dust row, not the older open row that still holds the token. A mock
    // storing one row per token can't represent this — a real multi-row mock is required.
    const olderOpen = makeConflictingOpenPosition({
      positionId: createPositionId("pos-open-older"),
      openedAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    const newerDust = makeDustPosition({
      positionId: createPositionId("pos-dust-newer"),
      openedAt: "2020-01-02T00:00:00.000Z",
      updatedAt: "2020-01-02T00:00:00.000Z",
    });
    const positionRepo = makePositionRepo(olderOpen, newerDust);
    const handler = new InventoryHandler(positionRepo, makeLotRepo(), silentLog, makeMockDb());

    expect(() =>
      handler.applyFill(makeFill({ fillId: createFillId("fill-realistic-conflict") })),
    ).toThrow(/refusing to promote/);
    expect(positionRepo.save).not.toHaveBeenCalled();
  });
});

describe("InventoryHandler — open-position-conflict guard (SELL: saveSellOutcome, site F)", () => {
  /**
   * A partial SELL off a dust position whose remaining size (15) is still
   * >= minOrderSize (5) — resolveOpenPositionStatus recomputes the outcome
   * back to "open", which is exactly the promotion the guard must catch.
   */
  function makeSellScenario() {
    const existing = makeDustPosition({ size: 20, costBasisUsdc: 2, currentValueUsdc: 2 });
    const positionRepo = makePositionRepo(existing);
    const lotRepo = makeLotRepo({
      consumeFifo: vi.fn(() => [{ lot: makeLot({ remainingSize: 15 }), consumed: 5 }]),
      findOpen: vi.fn(() => [makeLot({ remainingSize: 15 })]),
    });
    const handler = new InventoryHandler(
      positionRepo,
      lotRepo,
      silentLog,
      makeMockDb(),
      () => 5, // latestMinOrderSize
    );
    const sellFill = makeFill({
      fillId: createFillId("fill-sell"),
      side: "sell",
      size: 5,
      sizeUsdc: 0.5,
    });
    return { positionRepo, handler, sellFill };
  }

  it("throws and does not save when the partial SELL recomputes status back to open while a different open position exists", () => {
    const { positionRepo, handler, sellFill } = makeSellScenario();
    const conflicting = makeConflictingOpenPosition();
    (positionRepo.findActiveByTokenId as ReturnType<typeof vi.fn>).mockReturnValue([conflicting]);

    expect(() => handler.applyFill(sellFill)).toThrow(/refusing to promote/);
    expect(positionRepo.save).not.toHaveBeenCalled();
  });

  it("saves normally when no conflicting open position exists for the token", () => {
    const { positionRepo, handler, sellFill } = makeSellScenario();

    handler.applyFill(sellFill);

    expect(positionRepo.save).toHaveBeenCalledTimes(1);
    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.status).toBe("open");
    expect(saved.size).toBe(15);
  });
});
