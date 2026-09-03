import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@krabs/event-bus";
import { createConditionId, createTokenId } from "@krabs/domain";
import { PlanktonEntryShadowModule } from "../plankton-entry-shadow-module.js";
import {
  ActivitySourceSaturatedError,
  ShadowStore,
  ShadowWorkerRuntime,
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
  it("adopts rollback-era activity into v2 without changing the v1 insert contract", () => {
    const dir = mkdtempSync(join(tmpdir(), "entry-shadow-v2-"));
    const path = join(dir, "shadow.db");
    new ShadowStore(path).close();
    const legacy = new Database(path);
    legacy
      .prepare(
        `INSERT INTO plankton_buy_activity
        (transaction_hash,condition_id,token_id,outcome,outcome_index,occurred_at,price,size,
         usdc_size,first_seen_at,is_baseline,target_generation)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      )
      .run("rollback-tx", "condition-a", "token-a", "Yes", 0, 1_000, 0.01, 100, 1, 1_000_000, 0);
    legacy.close();

    const store = new ShadowStore(path);
    const pollId = store.beginPoll(1_100_000);
    const targets = store.commitActivity(
      [buy("rollback-tx", 1_000)],
      false,
      1_100_000,
      60_000,
      pollId,
    );
    expect(targets).toHaveLength(1);
    store.close();
    const check = new Database(path, { readonly: true });
    expect(
      check.prepare("SELECT target_generation_v2 generation FROM plankton_buy_activity").get(),
    ).toEqual({ generation: 1 });
    expect(check.prepare("SELECT COUNT(*) count FROM shadow_targets").get()).toEqual({ count: 0 });
    expect(check.pragma("user_version", { simple: true })).toBe(2);
    check.close();
    rmSync(dir, { recursive: true });
  });

  it("keeps overlapping generations open and atomically links one same-poll batch", () => {
    const store = new ShadowStore(":memory:");
    const firstPoll = store.beginPoll(1_000_000);
    const first = store.commitActivity(
      [buy("tx-1", 1_000), buy("tx-2", 1_001)],
      false,
      1_010_000,
      60_000,
      firstPoll,
    );
    const secondPoll = store.beginPoll(1_020_000);
    const second = store.commitActivity([buy("tx-3", 1_002)], false, 1_020_000, 60_000, secondPoll);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    const replayPoll = store.beginPoll(1_030_000);
    expect(
      store.commitActivity(
        [buy("tx-1", 1_000), buy("tx-2", 1_001)],
        false,
        1_030_000,
        60_000,
        replayPoll,
      ),
    ).toEqual([]);
    expect(store.readTargets().map((target) => target.generation)).toEqual([1, 2]);
    store.recordObservation({
      ...first[0]!,
      stage: "scanner",
      result: "include",
      observedAt: 1_030_000,
      payload: {},
    });
    expect(store.readObservation(first[0]!, "scanner")?.outcome).toBe("include");
    expect(store.readObservation(second[0]!, "scanner")).toBeNull();
    store.close();
  });

  it("persists empty/failure poll status and closes every overdue generation with gaps", () => {
    const store = new ShadowStore(":memory:");
    const emptyPoll = store.beginPoll(900_000);
    expect(store.commitActivity([], true, 900_100, 100, emptyPoll)).toEqual([]);
    expect(store.readCursor()).toBeNull();
    expect(store.isBaselineDone()).toBe(true);
    expect(store.healthState()).toEqual({ lastSuccessAt: 900_100, consecutiveFailures: 0 });
    const targetPoll = store.beginPoll(1_000_000);
    const [target] = store.commitActivity(
      [buy("tx-target", 1_000)],
      false,
      1_000_000,
      100,
      targetPoll,
    );
    const failedPoll = store.beginPoll(1_000_050);
    store.failPoll(failedPoll, "source_saturated", "source_saturated", 1_000_075);
    const unavailablePoll = store.beginPoll(1_000_080);
    store.failPoll(unavailablePoll, "unavailable", "source_unavailable", 1_000_090);
    const closed = store.maintain(1_000_100, 14 * 86_400_000);
    expect(closed).toMatchObject([{ generation: target!.generation }]);
    expect(store.readTargets()).toEqual([]);
    for (const stage of ["scanner", "tracking", "normalized", "algo", "signal"])
      expect(store.readObservation(target!, stage)?.outcome).toBe("telemetry_gap");
    store.close();
  });

  it("rejects pre-detection, deadline-equal, post-deadline, and after-close observations", () => {
    const store = new ShadowStore(":memory:");
    const poll = store.beginPoll(1_000);
    const [target] = store.commitActivity([buy("tx-window", 1)], false, 1_000, 100, poll);
    for (const [result, observedAt] of [
      ["before", 999],
      ["equal", 1_100],
      ["after", 1_101],
    ] as const)
      store.recordObservation({ ...target!, stage: "scanner", result, observedAt, payload: {} });
    expect(store.readObservation(target!, "scanner")).toBeNull();
    store.maintain(1_100, 100_000);
    store.recordObservation({
      ...target!,
      stage: "scanner",
      result: "buffered-before-deadline",
      observedAt: 1_099,
      payload: {},
    });
    expect(store.readObservation(target!, "scanner")?.outcome).toBe("telemetry_gap");
    store.close();
  });

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
    const current = store.readTargets().find((target) => target.generation === 2)!;
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

  it("honors abort before and during an activity fetch", async () => {
    const before = new AbortController();
    before.abort();
    const fetchPage = vi.fn(async () => []);
    await expect(
      fetchActivityWindow(fetchPage, null, 2_000, "wallet", before.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchPage).not.toHaveBeenCalled();

    const during = new AbortController();
    const pending = fetchActivityWindow(
      vi.fn(
        async (_url: URL, signal?: AbortSignal) =>
          new Promise((_resolve, reject) =>
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              {
                once: true,
              },
            ),
          ),
      ),
      null,
      2_000,
      "wallet",
      during.signal,
    );
    during.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("finalizes interrupted polls and overdue targets before ready, then aborts before close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "entry-shadow-runtime-"));
    const path = join(dir, "shadow.db");
    const now = Date.now();
    const seed = new ShadowStore(path);
    seed.commitActivity([buy("tx-overdue", Math.floor(now / 1_000) - 1)], false, now - 200, 100);
    seed.beginPoll(now - 150);
    seed.close();
    const port = new EventEmitter() as EventEmitter & {
      posted: unknown[];
      postMessage(value: unknown): void;
    };
    port.posted = [];
    port.postMessage = (value) => port.posted.push(value);
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => (fetchStarted = resolve));
    const fetchPage = vi.fn(
      async (_url: URL, signal?: AbortSignal) =>
        new Promise<unknown>((_resolve, reject) => {
          fetchStarted();
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const runtime = new ShadowWorkerRuntime(
      {
        dbPath: path,
        wallet: "wallet",
        pollMs: 60_000,
        retentionMs: 14 * 86_400_000,
        timeouts: { scannerMs: 10, trackingMs: 10, algoMs: 10 },
      },
      port,
      fetchPage,
    );

    runtime.start();
    await started;
    expect(port.posted.slice(0, 2)).toMatchObject([
      { type: "target_closed" },
      { type: "ready", targets: [] },
    ]);
    await runtime.shutdown();
    expect(fetchPage.mock.calls[0]![1]?.aborted).toBe(true);
    expect(port.posted.at(-1)).toEqual({ type: "stopped" });
    const check = new Database(path, { readonly: true });
    expect(
      check
        .prepare("SELECT COUNT(*) count FROM shadow_poll_runs_v2 WHERE status='interrupted'")
        .get(),
    ).toEqual({ count: 2 });
    expect(
      check.prepare("SELECT value FROM shadow_state WHERE key='v2_consecutive_failures'").get(),
    ).toEqual({ value: "2" });
    check.close();
    const pruner = new ShadowStore(path);
    pruner.maintain(now + 15 * 86_400_000, 14 * 86_400_000);
    pruner.close();
    const pruned = new Database(path, { readonly: true });
    expect(pruned.prepare("SELECT COUNT(*) count FROM shadow_poll_runs_v2").get()).toEqual({
      count: 0,
    });
    pruned.close();
    rmSync(dir, { recursive: true });
  });

  it("keeps a target open through one full subsequent scanner completion budget", async () => {
    const posted: unknown[] = [];
    const port = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
    port.postMessage = (value) => posted.push(value);
    const runtime = new ShadowWorkerRuntime(
      {
        dbPath: ":memory:",
        wallet: "wallet",
        pollMs: 60_000,
        retentionMs: 14 * 86_400_000,
        timeouts: { scannerMs: 100, trackingMs: 5, algoMs: 1 },
      },
      port,
      vi.fn(async () => [buy("tx-scanner-window", Math.floor(Date.now() / 1_000))]),
    );

    runtime.start();
    await vi.waitFor(() => expect(posted.some(isTargetAdded)).toBe(true));
    const target = (
      posted.find(isTargetAdded) as {
        target: { coverageStartedAt: number; coverageEndsAt: number };
      }
    ).target;
    expect(target.coverageEndsAt - target.coverageStartedAt).toBe(212);
    await runtime.shutdown();
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
    store.recordObservation({
      ...target,
      stage: "signal",
      result: "produced_sell",
      observedAt: 1_010_000,
      payload: { side: "sell" },
    });
    expect(store.readObservation(target, "signal")?.outcome).toBe("produced_sell");
    store.maintain(target.coverageEndsAt, 14 * 86_400_000);
    expect(store.readObservation(target, "tracking")?.outcome).toBe("telemetry_gap");
    expect(store.readObservation(target, "signal")?.outcome).toBe("telemetry_gap");
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
  it("routes concurrent generations, current tracking snapshots, and exact BUY/SELL signals", async () => {
    const bus = new InProcessEventBus();
    const worker = new FakeWorker();
    const mod = shadowModule(() => worker, bus);
    await mod.start();
    mod.observeTrackedMarkets(["token-a"], 900);
    const target = {
      tokenId: "token-a",
      conditionId: createConditionId("condition-a"),
      outcome: "Yes",
      outcomeIndex: 0,
      generation: 1,
      baseline: false,
      detectionLagMs: 0,
      coverageStartedAt: 1_000,
      coverageEndsAt: 10_000,
    };
    worker.emit("message", { type: "target_added", target });
    worker.emit("message", { type: "target_added", target: { ...target, generation: 2 } });
    expect(worker.posted.filter(isTrackingObservation)).toHaveLength(0);
    mod.observeTrackedMarkets(["token-a"], 1_100);
    mod.observeTrackedMarkets(["token-a"], 1_200);
    const signal = {
      signalId: "signal-1",
      tokenId: createTokenId("token-a"),
      conditionId: createConditionId("condition-a"),
      side: "sell" as const,
      suggestedPrice: 0.02,
      suggestedSize: 10,
      suggestedSizeUsdc: 0.2,
      reason: "operator" as const,
      decisionRuleId: "R1",
      sizingRuleId: "S1",
      strategyTick: 1,
      sequenceInTick: 0,
      generatedAt: new Date().toISOString(),
    };
    const market = {
      tokenId: signal.tokenId,
      conditionId: signal.conditionId,
      outcome: "Yes",
      outcomeIndex: 0,
    };
    await bus.publish("SignalProduced", { signal, market: market as never });
    await bus.publish("SignalProduced", {
      signal: { ...signal, signalId: "signal-2", side: "buy" },
      market: market as never,
    });
    await bus.drain();
    mod.observeAlgo(signal.tokenId, "planner_result", { type: "signal", side: "sell" });
    mod.observeAlgo(signal.tokenId, "planner_result", { type: "signal", side: "buy" });

    const observations = worker.posted.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: string }).type === "observation",
    );
    expect(observations.filter((row) => row["stage"] === "tracking")).toHaveLength(2);
    expect(observations.filter((row) => row["result"] === "produced_sell")).toHaveLength(2);
    expect(observations.filter((row) => row["result"] === "produced_buy")).toHaveLength(2);
    expect(
      worker.posted.filter((row) => (row as { result?: string }).result === "planner_buy"),
    ).toHaveLength(2);
    expect(observations.find((row) => row["result"] === "produced_buy")?.["payload"]).toMatchObject(
      {
        signalId: "signal-2",
        side: "buy",
        suggestedSizeUsdc: 0.2,
      },
    );
    await bus.publish("SignalProduced", {
      signal: { ...signal, signalId: "signal-wildcard", side: "buy" },
      market: { ...market, outcomeIndex: null } as never,
    });
    await bus.publish("SignalProduced", {
      signal: { ...signal, signalId: "signal-invalid-time", side: "buy", generatedAt: "invalid" },
      market: market as never,
    });
    worker.emit("message", { type: "target_closed", target });
    await bus.publish("SignalProduced", {
      signal: { ...signal, signalId: "signal-3", side: "buy" },
      market: market as never,
    });
    await bus.drain();
    expect(JSON.stringify(worker.posted)).not.toContain("signal-wildcard");
    expect(JSON.stringify(worker.posted)).not.toContain("signal-invalid-time");
    expect(
      worker.posted
        .filter(
          (row) => (row as { payload?: { signalId?: string } }).payload?.signalId === "signal-3",
        )
        .map((row) => (row as { generation: number }).generation),
    ).toEqual([2]);
    await mod.stop();
  });

  it("rejects incomplete/conflicting identities and timestamps an exact normalized match", async () => {
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
      baseline: false,
      detectionLagMs: 0,
      coverageStartedAt: 1_000,
      coverageEndsAt: 10_000,
    };
    worker.emit("message", { type: "target_added", target });
    mod.scanStarted("scan", 1_100);
    mod.scannerEvaluation("scan", {
      tokenId: "token-a",
      conditionId: "condition-a",
      outcome: "Yes",
      outcomeIndex: null,
      finalStatus: "INCLUDE",
      observedAt: 1_100,
    });
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        {
          tokenId: createTokenId("token-a"),
          conditionId: "condition-a",
          outcome: "No",
          outcomeIndex: 1,
        },
      ] as never,
      timestamp: 1_200,
    });
    await bus.drain();
    expect(worker.posted.filter(isScannerOrNormalizedObservation)).toHaveLength(0);

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        {
          tokenId: createTokenId("token-a"),
          conditionId: "condition-a",
          outcome: "Yes",
          outcomeIndex: 0,
          active: true,
        },
      ] as never,
      timestamp: 1_300,
    });
    await bus.drain();
    expect(worker.posted.filter(isScannerOrNormalizedObservation)).toMatchObject([
      { stage: "normalized", result: "active", observedAt: 1_300 },
    ]);
    await mod.stop();
  });

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
      coverageStartedAt: 0,
      coverageEndsAt: Number.MAX_SAFE_INTEGER,
    };
    worker.emit("message", {
      type: "ready",
      targets: [target],
    });
    worker.emit("message", { type: "target_added", target: { ...target, generation: 2 } });
    worker.emit("message", { type: "target_added", target });
    worker.emit("message", { type: "health", source: "unavailable", cursor: 1 });
    await expect(mod.healthCheck()).resolves.toMatchObject({ ok: true });

    mod.observeTrackedMarkets(["token-a", "other"], 1);
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        {
          tokenId: createTokenId("token-a"),
          conditionId: "condition-a",
          outcome: "Yes",
          outcomeIndex: 0,
        },
        {
          tokenId: createTokenId("other"),
          conditionId: "condition-other",
          outcome: "No",
          outcomeIndex: 1,
        },
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

function isTrackingObservation(value: unknown): boolean {
  return (
    (value as { type?: string; stage?: string }).type === "observation" &&
    (value as { stage?: string }).stage === "tracking"
  );
}

function isScannerOrNormalizedObservation(value: unknown): boolean {
  const stage = (value as { stage?: string }).stage;
  return (
    (value as { type?: string }).type === "observation" &&
    (stage === "scanner" || stage === "normalized")
  );
}

function isTargetAdded(value: unknown): boolean {
  return (value as { type?: string }).type === "target_added";
}
