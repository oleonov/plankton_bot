import { describe, it, expect, vi } from "vitest";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  createTokenId,
  type MarketResolution,
  type MarketResolutionRepository,
} from "@plankton/domain";
import { MarketResolutionTracker } from "../modules/resolution/market-resolution-tracker.js";

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

function createTestLogger() {
  return mockLog as any;
}

function makeRepo(rows: MarketResolution[] = []): MarketResolutionRepository {
  return {
    save: vi.fn(),
    findByConditionId: vi.fn().mockReturnValue(null),
    findAll: vi.fn().mockReturnValue(rows),
    updateResolution: vi.fn(),
    markSettled: vi.fn(),
  };
}

function makeRow(conditionId: string): MarketResolution {
  return {
    conditionId,
    resolution: "YES",
    resolvedAt: "2026-01-01T00:00:00Z",
    detectedAt: "2026-01-01T00:00:00Z",
    source: "gamma-api",
    rawResponse: null,
    status: "detected",
  };
}

describe("MarketResolutionTracker", () => {
  it("seeds resolved conditions from repo on init()", () => {
    const repo = makeRepo([makeRow("cond-1"), makeRow("cond-2")]);
    const tracker = new MarketResolutionTracker(repo, createTestLogger());

    tracker.init();

    expect(tracker.healthy()).toBe(true);
    expect(tracker.isResolved("cond-1")).toBe(true);
    expect(tracker.isResolved("cond-2")).toBe(true);
    expect(tracker.isResolved("cond-3")).toBe(false);
    expect(tracker.size()).toBe(2);
  });

  it("starts unhealthy before init()", () => {
    const tracker = new MarketResolutionTracker(makeRepo(), createTestLogger());
    expect(tracker.healthy()).toBe(false);
  });

  it("becomes unhealthy and rethrows when init() fails — fail-closed semantics", () => {
    const repo = makeRepo();
    (repo.findAll as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("disk i/o failure");
    });
    const tracker = new MarketResolutionTracker(repo, createTestLogger());

    expect(() => tracker.init()).toThrow(/disk i\/o failure/);
    expect(tracker.healthy()).toBe(false);
    // isResolved must remain false-but-non-throwing so callers can fail-closed
    // via healthy() rather than catching exceptions on the hot path.
    expect(tracker.isResolved("anything")).toBe(false);
  });

  it("adds conditions on MarketResolved events", async () => {
    const tracker = new MarketResolutionTracker(makeRepo(), createTestLogger());
    tracker.init();
    const bus = new InProcessEventBus();
    tracker.subscribe(bus);

    await bus.publish("MarketResolved", {
      conditionId: "cond-live",
      tokenIds: [createTokenId("tok-live")],
      resolution: "YES",
      resolvedAt: "2026-04-25T12:00:00Z",
      source: "gamma-api",
      timestamp: Date.now(),
    });

    expect(tracker.isResolved("cond-live")).toBe(true);
  });

  it("adds conditions on MarketResolvedHint events (fast-path before settlement)", async () => {
    const tracker = new MarketResolutionTracker(makeRepo(), createTestLogger());
    tracker.init();
    const bus = new InProcessEventBus();
    tracker.subscribe(bus);

    await bus.publish("MarketResolvedHint", {
      conditionId: "cond-hint",
      marketId: null,
      slug: null,
      tokenIds: [createTokenId("tok-hint")],
      winningTokenId: null,
      timestamp: Date.now(),
    });

    expect(tracker.isResolved("cond-hint")).toBe(true);
  });

  it("is idempotent on repeat events for the same condition", async () => {
    const tracker = new MarketResolutionTracker(makeRepo(), createTestLogger());
    tracker.init();
    const bus = new InProcessEventBus();
    tracker.subscribe(bus);

    const payload = {
      conditionId: "cond-dup",
      tokenIds: [],
      resolution: "YES",
      resolvedAt: "2026-04-25T12:00:00Z",
      source: "gamma-api",
      timestamp: Date.now(),
    };
    await bus.publish("MarketResolved", payload);
    await bus.publish("MarketResolved", payload);

    expect(tracker.size()).toBe(1);
  });

  it("unsubscribe stops accepting further events", async () => {
    const tracker = new MarketResolutionTracker(makeRepo(), createTestLogger());
    tracker.init();
    const bus = new InProcessEventBus();
    tracker.subscribe(bus);
    tracker.unsubscribe();

    await bus.publish("MarketResolved", {
      conditionId: "cond-after-unsub",
      tokenIds: [],
      resolution: "YES",
      resolvedAt: "2026-04-25T12:00:00Z",
      source: "gamma-api",
      timestamp: Date.now(),
    });

    expect(tracker.isResolved("cond-after-unsub")).toBe(false);
  });
});
