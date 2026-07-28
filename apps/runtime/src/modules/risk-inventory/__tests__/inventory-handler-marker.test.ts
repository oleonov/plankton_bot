/**
 * Phase 2 — Maker provenance marker plumbing tests.
 *
 * Verifies that FillEvent.entryStyle is carried end-to-end into
 * Position.entryStyle by InventoryHandler.applyFill().
 *
 * Nothing in Phase 2 sets "maker" at runtime — tests exercise the
 * plumbing directly by passing entryStyle in the FillEvent.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createConditionId,
  createFillId,
  createPositionId,
  createTokenId,
  GATE_ENTRY_RULE_ID,
  R23_DIP_TRIGGER_RULE_ID,
} from "@krabs/domain";
import type { InventoryLotRepository, Position, PositionRepository } from "@krabs/domain";
import type { Logger } from "../../../logger.js";
import { InventoryHandler, type FillEvent } from "../inventory-handler.js";

const TOKEN_ID = createTokenId("tok-marker-test");
const COND_ID = createConditionId("cond-marker-test");

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

function makePositionRepo(existingPosition: Position | null = null): PositionRepository {
  const positions = new Map<string, Position>();
  if (existingPosition) {
    positions.set(String(existingPosition.tokenId), existingPosition);
  }
  return {
    save: vi.fn((pos: Position) => {
      positions.set(String(pos.tokenId), pos);
    }),
    findByTokenId: vi.fn((tokenId) => positions.get(String(tokenId)) ?? null),
    findOpen: vi.fn(() => []),
    findDust: vi.fn(() => []),
    findAll: vi.fn(() => []),
    findOpenByEntryStyle: vi.fn(() => []),
    findById: vi.fn(() => null),
    findActiveByTokenId: vi.fn(() => []),
  } as unknown as PositionRepository;
}

function makeLotRepo(): InventoryLotRepository {
  return {
    save: vi.fn(),
    findByPositionId: vi.fn(() => []),
    findByTokenId: vi.fn(() => []),
    consumeFifo: vi.fn(() => []),
    settleAll: vi.fn(),
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

function makeHandler(existingPosition: Position | null = null) {
  const positionRepo = makePositionRepo(existingPosition);
  const lotRepo = makeLotRepo();
  const db = makeMockDb();
  const handler = new InventoryHandler(positionRepo, lotRepo, silentLog, db);
  return { handler, positionRepo, lotRepo };
}

describe("InventoryHandler — maker provenance marker (Phase 2 plumbing)", () => {
  it("stamps 'maker' on a new position when entryStyle='maker'", () => {
    const { handler, positionRepo } = makeHandler();

    handler.applyFill(makeFill({ fillId: createFillId("fill-maker"), entryStyle: "maker" }));

    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.entryStyle).toBe("maker");
  });

  it("stamps 'probe' on a new position when entryStyle is absent (byte-identical default path)", () => {
    const { handler, positionRepo } = makeHandler();

    handler.applyFill(makeFill({ fillId: createFillId("fill-probe") }));

    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.entryStyle).toBe("probe");
  });

  it("stamps 'probe' on a new position when entryStyle is null", () => {
    const { handler, positionRepo } = makeHandler();

    handler.applyFill(makeFill({ fillId: createFillId("fill-null"), entryStyle: null }));

    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.entryStyle).toBe("probe");
  });

  it("Release A Phase 2: assigns exit_owner from the injected resolver; NULL when no resolver", () => {
    // With a resolver → exit_owner is set on the new position.
    const positionRepo = makePositionRepo(null);
    const lotRepo = makeLotRepo();
    const db = makeMockDb();
    const handler = new InventoryHandler(
      positionRepo,
      lotRepo,
      silentLog,
      db,
      undefined,
      () => "bounce",
    );
    handler.applyFill(makeFill({ fillId: createFillId("fill-eo") }));
    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.exitOwner).toBe("bounce");

    // Without a resolver (e.g. startup adoption) → exit_owner stays NULL.
    const { handler: h2, positionRepo: repo2 } = makeHandler();
    h2.applyFill(makeFill({ fillId: createFillId("fill-eo2") }));
    const saved2 = (repo2.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved2.exitOwner ?? null).toBeNull();
  });

  it("preserves existing position's 'maker' entryStyle on scale-in (addToPosition spreads existing)", () => {
    const existing: Position = {
      positionId: createPositionId("pos-existing"),
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 4,
      realizedPnl: 0,
      status: "open",
      entryStyle: "maker",
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };

    const { handler, positionRepo } = makeHandler(existing);

    // Scale-in fill with no entryStyle — addToPosition spreads existing, marker must survive
    handler.applyFill(makeFill({ fillId: createFillId("fill-scalein"), size: 5, sizeUsdc: 2 }));

    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.entryStyle).toBe("maker");
    expect(saved.size).toBe(15);
  });

  it("preserves 'probe' entryStyle on scale-in (non-maker path byte-identical)", () => {
    const existing: Position = {
      positionId: createPositionId("pos-probe"),
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 4,
      realizedPnl: 0,
      status: "open",
      entryStyle: "probe",
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };

    const { handler, positionRepo } = makeHandler(existing);

    handler.applyFill(makeFill({ fillId: createFillId("fill-probe-scale"), size: 5, sizeUsdc: 2 }));

    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.entryStyle).toBe("probe");
  });
});

describe("InventoryHandler — entry lane provenance (Phase 3 plumbing)", () => {
  it("stamps entryLane='GATE' on a new position when the first fill's decisionRuleId is GATE_ENTRY_RULE_ID", () => {
    const { handler, positionRepo } = makeHandler();

    handler.applyFill(
      makeFill({ fillId: createFillId("fill-gate"), decisionRuleId: GATE_ENTRY_RULE_ID }),
    );

    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.entryLane).toBe("GATE");
  });

  it("stamps entryLane='R23' on a new position when the first fill's decisionRuleId is R23_DIP_TRIGGER_RULE_ID", () => {
    const { handler, positionRepo } = makeHandler();

    handler.applyFill(
      makeFill({ fillId: createFillId("fill-r23"), decisionRuleId: R23_DIP_TRIGGER_RULE_ID }),
    );

    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.entryLane).toBe("R23");
  });

  it("stamps entryLane=null on a new position when decisionRuleId is unknown/legacy/absent", () => {
    const { handler, positionRepo } = makeHandler();

    handler.applyFill(makeFill({ fillId: createFillId("fill-legacy"), decisionRuleId: "D5" }));
    const savedKnownRule = (positionRepo.save as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Position;
    expect(savedKnownRule.entryLane).toBeNull();

    const { handler: handler2, positionRepo: positionRepo2 } = makeHandler();
    handler2.applyFill(makeFill({ fillId: createFillId("fill-absent") }));
    const savedAbsent = (positionRepo2.save as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Position;
    expect(savedAbsent.entryLane).toBeNull();
  });

  it("preserves the first fill's entryLane='GATE' on scale-in even when the second fill's decisionRuleId differs", () => {
    const existing: Position = {
      positionId: createPositionId("pos-gate-existing"),
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 4,
      realizedPnl: 0,
      status: "open",
      entryStyle: "probe",
      entryLane: "GATE",
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };

    const { handler, positionRepo } = makeHandler(existing);

    // Scale-in fill carries a different (or absent) decisionRuleId — addToPosition
    // spreads the existing position, so the durable first-fill lane must survive.
    handler.applyFill(
      makeFill({
        fillId: createFillId("fill-gate-scalein"),
        size: 5,
        sizeUsdc: 2,
        decisionRuleId: null,
      }),
    );

    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.entryLane).toBe("GATE");
    expect(saved.size).toBe(15);
  });
});
