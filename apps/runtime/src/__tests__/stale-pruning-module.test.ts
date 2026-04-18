import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createPositionId,
  createConditionId,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import type {
  Position,
  PositionRepository,
  MarketRepository,
} from "@plankton/domain";
import { StalePruningModule } from "../modules/pruning/stale-pruning-module.js";

const TOK_ID = createTokenId("tok-yes");

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function makePosition(overrides?: Partial<Position>): Position {
  return {
    positionId: createPositionId("pos-1"),
    tokenId: TOK_ID,
    conditionId: createConditionId("cond-1"),
    side: "buy",
    size: 100,
    avgEntryPrice: 0.02, // cheap — below default maxPrunableEntryPrice (0.15)
    costBasisUsdc: 2,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: hoursAgo(100), // old enough to prune (default 69h)
    closedAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

function createMockPositionRepo(positions: Position[]): PositionRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue(positions),
    findDust: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue(positions),
    findOpenByEntryStyle: vi.fn().mockReturnValue([]),
  };
}

function createMockMarketRepo(active = true, conditionId = "cond-test"): MarketRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue({ active, conditionId }),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
  };
}

describe("StalePruningModule", () => {
  let bus: InProcessEventBus;

  beforeEach(() => {
    bus = new InProcessEventBus();
  });

  it("emits stale-prune signal for old cheap position", async () => {
    const pos = makePosition(); // 100 hours old, avgEntryPrice 0.02 < default maxPrunableEntryPrice (0.15)
    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const signals: any[] = [];
    bus.subscribe("SignalProduced", async (p) => {
      signals.push(p);
    });

    const pruned = await mod.runCheck();

    expect(pruned).toBe(1);
    expect(signals).toHaveLength(1);
    expect(signals[0].signal.reason).toBe("stale-prune");
    expect(signals[0].signal.side).toBe("sell");
    expect(signals[0].signal.tokenId).toBe(TOK_ID);

    await mod.stop();
  });

  it("skips position not old enough", async () => {
    const pos = makePosition({ openedAt: hoursAgo(1) }); // only 1 hour old

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(0);

    await mod.stop();
  });

  it("skips position with entry price above maxPrunableEntryPrice", async () => {
    const pos = makePosition({ avgEntryPrice: 0.5 }); // well above default 0.15

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
      maxPrunableEntryPrice: 0.03,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(0);

    await mod.stop();
  });

  it("respects custom maxTailHoldMs parameter", async () => {
    // Position is only 10 hours old — won't be pruned with a 48h hold
    const pos = makePosition({ openedAt: hoursAgo(10) });

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
      maxTailHoldMs: 48 * 60 * 60 * 1000, // 48h
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(0);

    await mod.stop();
  });

  it("prunes dust positions too", async () => {
    const pos = makePosition({ status: "dust" });

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(1);

    await mod.stop();
  });

  it("does not prune closed positions", async () => {
    const pos = makePosition({ status: "closed" });

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(0);

    await mod.stop();
  });

  it("prunes dust position with avgEntryPrice above maxPrunableEntryPrice when old enough", async () => {
    // Dust positions are pruned by age alone, regardless of entry price
    const pos = makePosition({
      status: "dust",
      avgEntryPrice: 0.5, // above default 0.15
      openedAt: hoursAgo(100),
    });

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(1);

    await mod.stop();
  });

  it("does NOT prune open (non-dust) position with avgEntryPrice above maxPrunableEntryPrice", async () => {
    const pos = makePosition({
      status: "open",
      avgEntryPrice: 0.5, // above default 0.15
      openedAt: hoursAgo(100),
    });

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(0);

    await mod.stop();
  });

  it("skips positions on inactive/resolved markets", async () => {
    const pos = makePosition(); // would normally be pruned

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(false), // inactive market
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(0);

    await mod.stop();
  });
});
