import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@krabs/event-bus";
import { createTokenId } from "@krabs/domain";
import { PlanktonEntryShadowModule } from "../plankton-entry-shadow-module.js";
import {
  ActivitySourceSaturatedError,
  ShadowStore,
  fetchActivityWindow,
} from "../plankton-entry-shadow-worker.js";

const buy = (tx: string, timestamp: number, tokenId = "token-a") => ({
  transactionHash: tx,
  type: "TRADE",
  side: "BUY",
  timestamp,
  conditionId: "condition-a",
  asset: tokenId,
  outcome: "Yes",
  outcomeIndex: 0,
  price: 0.01,
  size: 100,
  usdcSize: 1,
});

describe("plankton entry shadow worker", () => {
  it("commits activity and cursor atomically and recovers timestamp ties and late rows", async () => {
    const store = new ShadowStore(":memory:");
    const baselineTs = 300_000 - 48 * 3_600;
    const first = await fetchActivityWindow(
      vi.fn(async () => [buy("tx-1", baselineTs)]),
      null,
      300_000,
    );
    const baseline = store.commitActivity(first, true, 300_000_000);
    expect(baseline).toMatchObject([
      { generation: 1, baseline: true, detectionLagMs: 48 * 3_600_000 },
    ]);
    const nextFetch = vi
      .fn()
      .mockResolvedValueOnce([
        buy("tx-1", baselineTs),
        buy("tx-tie", baselineTs),
        buy("tx-late", baselineTs - 100),
      ]);
    const next = await fetchActivityWindow(nextFetch, store.readCursor(), 300_100);
    const inserted = store.commitActivity(next, false, 300_100_000);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ generation: 2, baseline: false });
    expect(store.readCursor()).toBe(baselineTs);
    const current = store.readTargets()[0]!;
    expect(current.generation).toBe(2);
    store.recordObservation({
      ...baseline[0]!,
      stage: "scanner",
      result: "include",
      observedAt: 2_300_000,
      payload: {},
    });
    expect(store.readObservation(current, "scanner")).toBeNull();
    store.close();
  });

  it("does not advance the cursor when any eligible row is malformed", async () => {
    const store = new ShadowStore(":memory:");
    store.commitActivity([buy("tx-ok", 1_000)], false, 1_000_000);
    await expect(
      fetchActivityWindow(
        vi.fn(async () => [buy("tx-new", 1_100), { ...buy("tx-bad", 1_099), asset: "" }]),
        1_000,
        1_200,
      ),
    ).rejects.toThrow("invalid BUY activity row");
    expect(store.readCursor()).toBe(1_000);
    store.close();
  });

  it("fail-stops instead of skipping a timestamp saturated beyond the API offset cap", async () => {
    const fetchPage = vi.fn(async (_url: URL) =>
      Array.from({ length: 500 }, (_, index) =>
        buy(`tx-${fetchPage.mock.calls.length}-${index}`, 5_000),
      ),
    );
    await expect(fetchActivityWindow(fetchPage, 4_000, 5_100)).rejects.toBeInstanceOf(
      ActivitySourceSaturatedError,
    );
    expect(fetchPage).toHaveBeenCalledTimes(13);
  });

  it("drains the exact boundary second before continuing below it", async () => {
    let page = 0;
    const fetchPage = vi.fn(async (url: URL) => {
      if (url.searchParams.has("start")) return [buy("boundary-late", 5_000)];
      if (url.searchParams.get("end") === "4999") return [buy("older", 4_999)];
      const timestamp = 10_000 - page++ * 1_000;
      return Array.from({ length: 500 }, (_, index) =>
        buy(`page-${page}-${index}`, timestamp + (page === 6 && index === 0 ? 1 : 0)),
      );
    });
    const rows = await fetchActivityWindow(fetchPage, 4_000, 10_100);
    expect(rows.map((row) => row.transactionHash)).toEqual(
      expect.arrayContaining(["boundary-late", "older"]),
    );
  });

  it("assigns bounded telemetry gaps without claiming a missing one-time signal", () => {
    const store = new ShadowStore(":memory:");
    store.commitActivity([buy("tx-target", 1_000)], false, 1_000_000);
    const target = store.readTargets()[0]!;
    store.recordObservation({
      ...target,
      stage: "scanner",
      result: "include",
      observedAt: 1_010_000,
      payload: {},
    });
    store.recordTimeouts(1_030_001, { scannerMs: 10_000, trackingMs: 20_000, algoMs: 30_000 });
    expect(store.readObservation(target, "tracking")?.outcome).toBe("telemetry_gap");
    store.close();
  });
});

class FakeWorker extends EventEmitter {
  readonly posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
    if ((message as { type?: string }).type === "shutdown")
      this.emit("message", { type: "stopped" });
  }
  terminate = vi.fn(async () => 0);
}
function shadowModule(workerFactory: () => FakeWorker, bus = new InProcessEventBus()) {
  return new PlanktonEntryShadowModule({
    bus,
    dbPath: ":memory:",
    log: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as never,
    scanIntervalMs: 900_000,
    marketDataPollIntervalMs: 5_000,
    strategyScanIntervalMs: 12_000,
    workerFactory: workerFactory as never,
  });
}

describe("PlanktonEntryShadowModule routing", () => {
  it("subscribes to market routing events and posts only exact targets synchronously", async () => {
    const bus = new InProcessEventBus();
    const worker = new FakeWorker();
    const mod = shadowModule(() => worker, bus);
    await mod.start();
    const target = {
      tokenId: "token-a",
      conditionId: "condition-a",
      outcome: "Yes",
      outcomeIndex: 0,
      generation: 1,
      baseline: true,
      detectionLagMs: 0,
    };
    worker.emit("message", {
      type: "ready",
      targets: [target],
    });
    worker.emit("message", { type: "target_added", target: { ...target, generation: 2 } });
    worker.emit("message", { type: "target_added", target });
    worker.emit("message", { type: "health", source: "unavailable", cursor: 1 });
    await expect(mod.healthCheck()).resolves.toMatchObject({ ok: true });

    await bus.publish("TrackedMarketsChanged", {
      addedTokenIds: [createTokenId("token-a"), createTokenId("other")],
      removedTokenIds: [],
      activeTokenIds: [createTokenId("token-a"), createTokenId("other")],
      timestamp: 1,
    });
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        { tokenId: createTokenId("token-a"), conditionId: "condition-a" },
        { tokenId: createTokenId("other"), conditionId: "condition-other" },
      ] as never,
      timestamp: 2,
    });
    await bus.drain();
    expect(worker.posted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "observation", stage: "tracking", tokenId: "token-a" }),
        expect.objectContaining({
          type: "observation",
          stage: "normalized",
          tokenId: "token-a",
          generation: 2,
        }),
      ]),
    );
    expect(JSON.stringify(worker.posted)).not.toContain("condition-other");
    await mod.stop();
  });

  it("serializes DB-open, error, and exit restarts and never restarts after stop", async () => {
    vi.useFakeTimers();
    const workers = [new FakeWorker(), new FakeWorker(), new FakeWorker()];
    const factory = vi
      .fn<() => FakeWorker>()
      .mockImplementationOnce(() => {
        throw new Error("db open failed");
      })
      .mockImplementation(() => workers.shift()!);
    const mod = shadowModule(factory);
    await mod.start();
    await vi.advanceTimersByTimeAsync(1_000);
    factory.mock.results[1]!.value.emit("error", new Error("failed"));
    factory.mock.results[1]!.value.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    factory.mock.results[2]!.value.emit("exit", 2);
    await vi.advanceTimersByTimeAsync(1_000);
    await mod.stop();
    factory.mock.results[3]!.value.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(factory).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("forcibly terminates a worker that does not acknowledge shutdown", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    worker.postMessage = vi.fn((message) => worker.posted.push(message));
    const factory = vi.fn(() => worker);
    const mod = shadowModule(factory);
    await mod.start();
    const stopping = mod.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(factory).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
