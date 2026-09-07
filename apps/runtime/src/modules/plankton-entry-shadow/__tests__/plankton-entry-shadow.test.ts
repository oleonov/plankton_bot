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
const transientBuy = (tx: string, timestamp: number) => ({
  ...buy(tx, timestamp),
  outcomeIndex: 999,
});

describe("plankton entry shadow worker", () => {
  it("adopts rollback-era activity into v3 without changing the v1 insert contract", () => {
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
    expect(check.pragma("user_version", { simple: true })).toBe(3);
    expect(
      (check.pragma("table_info(shadow_targets_v2)") as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    ).toEqual(expect.arrayContaining(["downstream_grace_started_at", "downstream_grace_ends_at"]));
    check.close();
    rmSync(dir, { recursive: true });
  });

  it("counts transient identities without persisting them or advancing the canonical cursor", () => {
    const dir = mkdtempSync(join(tmpdir(), "entry-shadow-transient-"));
    const path = join(dir, "shadow.db");
    new ShadowStore(path).close();
    const legacy = new Database(path);
    legacy.exec(`INSERT INTO plankton_buy_activity
      (transaction_hash,condition_id,token_id,outcome,outcome_index,occurred_at,price,size,
       usdc_size,first_seen_at,is_baseline,target_generation,target_generation_v2)
      VALUES ('legacy-999','condition-a','token-a','Yes',999,1000,0.01,100,1,900000,1,7,8)`);
    const legacyBefore = legacy.prepare("SELECT * FROM plankton_buy_activity").get();
    legacy.close();
    const store = new ShadowStore(path);
    const sentinel = transientBuy("sentinel", 1_000);
    const canonical = buy("canonical", 900);
    const transientState = () => {
      const state = store.healthState();
      return [state.transientIdentityRowsSeen, state.transientIdentityLastSeenAt];
    };
    const firstPoll = store.beginPoll(1_000_000);
    expect(store.commitActivity([sentinel], true, 1_000_010, 100, firstPoll)).toEqual([]);
    expect(store.isBaselineDone()).toBe(true);
    expect(store.readCursor()).toBeNull();
    expect(transientState()).toEqual([1, 1_000_010]);
    const secondPoll = store.beginPoll(1_000_020);
    const targets = store.commitActivity([canonical], false, 1_000_020, 100, secondPoll);
    expect(targets).toMatchObject([{ baseline: false, outcomeIndex: 0, generation: 1 }]);
    expect(store.readCursor()).toBe(900);
    expect(transientState()).toEqual([1, 1_000_010]);
    const replayPoll = store.beginPoll(1_000_030);
    expect(store.commitActivity([sentinel, canonical], false, 1_000_030, 100, replayPoll)).toEqual(
      [],
    );
    expect(store.readCursor()).toBe(900);
    expect(transientState()).toEqual([2, 1_000_030]);
    store.close();
    const check = new Database(path, { readonly: true });
    expect(
      check
        .prepare("SELECT COUNT(*) count FROM plankton_buy_activity WHERE outcome_index=999")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      check.prepare("SELECT * FROM plankton_buy_activity WHERE outcome_index=999").get(),
    ).toEqual(legacyBefore);
    expect(
      check
        .prepare(
          `SELECT group_concat(rows_seen||'/'||rows_inserted||'/'||targets_created, ',') summary
          FROM (SELECT * FROM shadow_poll_runs_v2 ORDER BY poll_id)`,
        )
        .get(),
    ).toEqual({ summary: "1/0/0,1/1/1,2/0/0" });
    check.close();
    rmSync(dir, { recursive: true });
  });

  it("creates one canonical generation when the same transient fill is corrected and replayed", () => {
    const dir = mkdtempSync(join(tmpdir(), "entry-shadow-correction-"));
    const store = new ShadowStore(join(dir, "shadow.db"));
    const canonical = buy("corrected-fill", 1_000);
    expect(
      store.commitActivity([{ ...canonical, outcomeIndex: 999 }], false, 1_000_010, 100),
    ).toEqual([]);
    expect(store.commitActivity([canonical], false, 1_000_020, 100)).toMatchObject([
      { outcomeIndex: 0, generation: 1 },
    ]);
    expect(store.commitActivity([canonical], false, 1_000_030, 100)).toEqual([]);
    expect(store.readTargets()).toHaveLength(1);
    store.close();
    rmSync(dir, { recursive: true });
  });

  it("rolls back transient counters with canonical writes when poll finalization fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "entry-shadow-transient-rollback-"));
    const path = join(dir, "shadow.db");
    new ShadowStore(path).close();
    const triggerDb = new Database(path);
    triggerDb.exec(`CREATE TRIGGER force_success_failure BEFORE UPDATE ON shadow_poll_runs_v2
      WHEN NEW.status='ok' BEGIN SELECT RAISE(ABORT,'forced finish failure'); END;`);
    triggerDb.close();
    const store = new ShadowStore(path);
    const poll = store.beginPoll(1_000_000);
    expect(() =>
      store.commitActivity(
        [buy("canonical", 900), transientBuy("sentinel", 1_000)],
        true,
        1_000_010,
        100,
        poll,
      ),
    ).toThrow("forced finish failure");
    store.close();
    const reopened = new ShadowStore(path);
    expect(reopened.healthState()).toMatchObject({
      transientIdentityRowsSeen: 0,
      transientIdentityLastSeenAt: null,
    });
    reopened.close();
    const check = new Database(path, { readonly: true });
    expect(
      check
        .prepare(
          `SELECT (SELECT COUNT(*) FROM plankton_buy_activity) activity,
          (SELECT COUNT(*) FROM shadow_targets_v2) targets,
          (SELECT COUNT(*) FROM shadow_state WHERE key IN
            ('v2_activity_cursor','v2_baseline_done','v2_transient_identity_rows_seen',
             'v2_transient_identity_last_seen_at')) changedState,status
          FROM shadow_poll_runs_v2`,
        )
        .get(),
    ).toEqual({ activity: 0, targets: 0, changedState: 0, status: "interrupted" });
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
    expect(store.healthState()).toEqual({
      lastSuccessAt: 900_100,
      consecutiveFailures: 0,
      transientIdentityRowsSeen: 0,
      transientIdentityLastSeenAt: null,
    });
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

  it("defers an expired target only for scan starts inside its half-open window", () => {
    for (const [startedAt, shouldDefer] of [
      [999, false],
      [1_000, true],
      [1_099, true],
      [1_100, false],
    ] as const) {
      const store = new ShadowStore(":memory:");
      store.commitActivity([buy(`tx-${startedAt}`, 1)], false, 1_000, 100);
      const closed = store.maintain(1_100, 100_000, [startedAt]);
      expect(closed.length === 0, `scan start ${startedAt}`).toBe(shouldDefer);
      expect(store.readTargets().length === 1).toBe(shouldDefer);
      store.close();
    }
  });

  it("waits for every eligible scan and applies its atomic result before closing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_050);
    const dir = mkdtempSync(join(tmpdir(), "entry-shadow-scan-"));
    const path = join(dir, "shadow.db");
    const seed = new ShadowStore(path);
    const [first] = seed.commitActivity([buy("tx-first", 1)], false, 1_000, 100);
    seed.commitActivity([buy("tx-second", 1)], false, 1_005, 100);
    seed.close();
    const posted: unknown[] = [];
    const port = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
    port.postMessage = (value) => posted.push(value);
    const runtime = new ShadowWorkerRuntime(
      {
        dbPath: path,
        wallet: "wallet",
        pollMs: 50,
        retentionMs: 100_000,
        timeouts: { scannerMs: 10, trackingMs: 10, algoMs: 10 },
      },
      port,
      vi.fn(async () => []),
    );
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    port.emit("message", { type: "scan_started", scanId: "failed", observedAt: 1_050 });
    port.emit("message", { type: "scan_started", scanId: "successful", observedAt: 1_060 });
    port.emit("message", {
      type: "scan_evaluation",
      scanId: "successful",
      observation: {
        ...first!,
        stage: "scanner",
        result: "include",
        observedAt: 1_060,
        payload: {},
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    let check = new Database(path, { readonly: true });
    expect(
      check.prepare("SELECT COUNT(*) count FROM shadow_targets_v2 WHERE closed_at IS NULL").get(),
    ).toEqual({ count: 2 });
    expect(
      check
        .prepare("SELECT COUNT(*) count FROM shadow_observations_v2 WHERE stage='scanner'")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      check
        .prepare(
          "SELECT COUNT(*) count FROM shadow_observations_v2 WHERE stage!='scanner' AND result='telemetry_gap'",
        )
        .get(),
    ).toEqual({ count: 8 });
    check.close();

    port.emit("message", {
      type: "observation",
      ...first!,
      stage: "normalized",
      result: "active",
      observedAt: 1_099,
      payload: {},
    });
    await vi.advanceTimersByTimeAsync(50);
    port.emit("message", { type: "scan_completed", scanId: "successful", observedAt: 1_200 });
    expect(
      posted.find((value) => (value as { type?: string }).type === "target_grace_started"),
    ).toMatchObject({
      target: { downstreamGraceStartedAt: 1_200, downstreamGraceEndsAt: 1_240 },
    });
    check = new Database(path, { readonly: true });
    expect(
      check.prepare("SELECT COUNT(*) count FROM shadow_targets_v2 WHERE closed_at IS NULL").get(),
    ).toEqual({ count: 2 });
    expect(
      check
        .prepare("SELECT COUNT(*) count FROM shadow_observations_v2 WHERE stage='scanner'")
        .get(),
    ).toEqual({ count: 1 });
    check.close();
    port.emit("message", { type: "scan_failed", scanId: "failed", observedAt: 1_300 });

    check = new Database(path, { readonly: true });
    expect(
      check.prepare("SELECT COUNT(*) count FROM shadow_targets_v2 WHERE closed_at IS NULL").get(),
    ).toEqual({ count: 0 });
    expect(
      check
        .prepare(
          "SELECT generation,result FROM shadow_observations_v2 WHERE stage='scanner' ORDER BY generation",
        )
        .all(),
    ).toEqual([
      { generation: 1, result: "include" },
      { generation: 2, result: "telemetry_gap" },
    ]);
    expect(
      check
        .prepare(
          `SELECT stage FROM shadow_observations_v2 WHERE generation=1
           AND result='telemetry_gap' AND stage IN ('normalized','grace_normalized') ORDER BY stage`,
        )
        .all(),
    ).toEqual([{ stage: "grace_normalized" }, { stage: "normalized" }]);
    expect(
      check
        .prepare(
          "SELECT COUNT(*) count FROM shadow_observations_v2 WHERE stage='normalized' AND result='active'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      check
        .prepare(
          "SELECT MAX(seen_count) maxSeen FROM shadow_observations_v2 WHERE result='telemetry_gap'",
        )
        .get(),
    ).toEqual({ maxSeen: 1 });
    check.close();
    expect(
      posted.filter((value) => (value as { type?: string }).type === "target_closed"),
    ).toHaveLength(2);
    await runtime.shutdown();
    vi.useRealTimers();
    rmSync(dir, { recursive: true });
  });

  it("grants only the first positive non-baseline downstream window and closes truthfully", () => {
    const dir = mkdtempSync(join(tmpdir(), "entry-shadow-grace-"));
    const path = join(dir, "shadow.db");
    let store = new ShadowStore(path);
    const [target] = store.commitActivity([buy("tx-grace", 1)], false, 1_000, 100);
    const scanner = (observedAt: number) => ({
      ...target!,
      stage: "scanner",
      result: "include",
      observedAt,
      payload: {},
    });

    expect(store.completeSuccessfulScan([scanner(1_050)], 1_050, 1_060, 40)).toEqual([]);
    expect(store.completeSuccessfulScan([scanner(1_080)], 999, 1_090, 40)).toEqual([]);
    expect(store.completeSuccessfulScan([scanner(1_080)], 1_080, 1_090, 40)).toMatchObject([
      { downstreamGraceStartedAt: 1_100, downstreamGraceEndsAt: 1_130 },
    ]);
    expect(store.completeSuccessfulScan([scanner(1_090)], 1_090, 1_100, 100)).toEqual([]);
    expect(store.readTargets()).toMatchObject([
      { downstreamGraceStartedAt: 1_100, downstreamGraceEndsAt: 1_130 },
    ]);
    store.close();
    store = new ShadowStore(path);

    store.recordObservation({
      ...target!,
      stage: "normalized",
      result: "active",
      observedAt: 1_110,
      payload: {},
    });
    store.recordObservation({
      ...target!,
      stage: "signal",
      result: "produced_sell",
      observedAt: 1_111,
      payload: {},
    });
    for (const stage of ["routing", "postplanner", "discovery"]) {
      store.recordObservation({
        ...target!,
        stage,
        result: "diagnostic",
        observedAt: 1_112,
        payload: {},
      });
    }
    expect(store.readObservation(target!, "grace_normalized")?.outcome).toBe("active");
    expect(store.readObservation(target!, "grace_signal")?.outcome).toBe("produced_sell");
    expect(store.maintain(1_130, 100_000, [1_099])).toEqual([]);
    expect(store.readTargets()).toHaveLength(1);
    expect(store.maintain(1_131, 100_000)).toHaveLength(1);
    store.close();

    const check = new Database(path, { readonly: true });
    expect(
      check
        .prepare(
          `SELECT closed_at closedAt,close_reason closeReason,downstream_grace_started_at startedAt,
           downstream_grace_ends_at endsAt FROM shadow_targets_v2`,
        )
        .get(),
    ).toEqual({ closedAt: 1_100, closeReason: "window_elapsed", startedAt: 1_100, endsAt: 1_130 });
    expect(
      check
        .prepare(
          `SELECT stage,result FROM shadow_observations_v2
           WHERE stage LIKE 'grace_%' ORDER BY stage,result`,
        )
        .all(),
    ).toEqual([
      { stage: "grace_algo", result: "telemetry_gap" },
      { stage: "grace_discovery", result: "diagnostic" },
      { stage: "grace_normalized", result: "active" },
      { stage: "grace_postplanner", result: "diagnostic" },
      { stage: "grace_routing", result: "diagnostic" },
      { stage: "grace_signal", result: "produced_sell" },
      { stage: "grace_signal", result: "telemetry_gap" },
      { stage: "grace_tracking", result: "telemetry_gap" },
    ]);
    check.close();
    rmSync(dir, { recursive: true });
  });

  it("does not grant supplemental coverage to a baseline target", () => {
    const store = new ShadowStore(":memory:");
    const [target] = store.commitActivity([buy("tx-baseline", 1)], true, 1_000, 100);
    expect(
      store.completeSuccessfulScan(
        [
          {
            ...target!,
            stage: "scanner",
            result: "include",
            observedAt: 1_090,
            payload: {},
          },
        ],
        1_090,
        1_100,
        40,
      ),
    ).toEqual([]);
    expect(store.readTargets()[0]?.downstreamGraceEndsAt).toBeNull();
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
      coverageEndsAt: Number.MAX_SAFE_INTEGER,
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
      generatedAt: new Date(2_000).toISOString(),
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

  it("dedupes tracking by observed phase and routes only real grace observations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_105);
    const bus = new InProcessEventBus();
    const worker = new FakeWorker();
    const mod = shadowModule(() => worker, bus);
    await mod.start();
    const target = {
      tokenId: "token-a",
      conditionId: createConditionId("condition-a"),
      outcome: "Yes",
      outcomeIndex: 0,
      generation: 1,
      baseline: false,
      detectionLagMs: 0,
      coverageStartedAt: 1_000,
      coverageEndsAt: 1_100,
      downstreamGraceStartedAt: null,
      downstreamGraceEndsAt: null,
    };
    worker.emit("message", { type: "target_added", target });
    mod.observeTrackedMarkets(["token-a"], 1_050);
    worker.emit("message", {
      type: "target_grace_started",
      target: {
        ...target,
        downstreamGraceStartedAt: 1_100,
        downstreamGraceEndsAt: 1_140,
      },
    });
    const routeTargets = mod.routeTargetTokenIds();
    expect([...routeTargets]).toEqual(["token-a"]);
    mod.observeTrackedMarkets(["token-a"], 1_090);
    expect(worker.posted.filter(isTrackingObservation)).toHaveLength(1);
    mod.observeTrackedMarkets(["token-a"], 1_100);
    expect(worker.posted.filter(isTrackingObservation)).toMatchObject([
      { stage: "tracking", observedAt: 1_050 },
      { stage: "grace_tracking", observedAt: 1_100 },
    ]);

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        {
          tokenId: createTokenId("token-a"),
          conditionId: createConditionId("condition-a"),
          outcome: "Yes",
          outcomeIndex: 0,
          active: true,
        },
      ] as never,
      timestamp: 1_105,
    });
    const signal = {
      signalId: "signal-grace",
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
      generatedAt: new Date(1_105).toISOString(),
    };
    const market = {
      tokenId: signal.tokenId,
      conditionId: signal.conditionId,
      outcome: "Yes",
      outcomeIndex: 0,
    };
    await bus.publish("SignalProduced", { signal, market: market as never });
    await bus.publish("SignalProduced", {
      signal: { ...signal, signalId: "buy-grace", side: "buy" },
      market: market as never,
    });
    await bus.drain();
    mod.observeRouting({
      tokenId: "token-a",
      conditionId: "condition-a",
      outcome: "Yes",
      outcomeIndex: 0,
      capturedAtMs: 1_105,
      basis: "post_detection_route_evaluation",
      route: "entry_candidate",
      v4Category: null,
      v4Reason: null,
      admissionRank: 1,
      capacitySlots: 2,
      signatureMatched: false,
    });
    mod.observeDiscovery(market as never, "returned", 1_105, { source: "rest" });
    mod.observeAlgo(signal.tokenId, "planner_result", { type: "none" });
    mod.observeAlgo(signal.tokenId, "postplanner_guard", {
      side: "buy",
      decisionRuleId: "R23",
      guardReason: "buy_budget",
      budgetReason: "buy_budget_cooldown",
    });
    const grace = worker.posted.filter(
      (value) =>
        (value as { type?: string }).type === "observation" &&
        String((value as { stage?: string }).stage).startsWith("grace_"),
    );
    expect(grace.map((value) => (value as { stage: string }).stage)).toEqual(
      expect.arrayContaining([
        "grace_tracking",
        "grace_normalized",
        "grace_signal",
        "grace_signal",
        "grace_routing",
        "grace_discovery",
        "grace_algo",
        "grace_postplanner",
      ]),
    );
    expect(grace).toHaveLength(8);
    expect(
      grace.find((value) => (value as { stage?: string }).stage === "grace_postplanner"),
    ).toMatchObject({ result: "buy_budget", payload: { budgetReason: "buy_budget_cooldown" } });
    expect(JSON.stringify(grace)).toContain("produced_sell");
    await mod.stop();
    vi.useRealTimers();
  });

  it("forwards every real pending snapshot until durable grace bounds arrive", async () => {
    const worker = new FakeWorker();
    const mod = shadowModule(() => worker);
    await mod.start();
    worker.emit("message", {
      type: "target_added",
      target: {
        tokenId: "token-a",
        conditionId: "condition-a",
        outcome: "Yes",
        outcomeIndex: 0,
        generation: 1,
        baseline: false,
        detectionLagMs: 0,
        coverageStartedAt: 1_000,
        coverageEndsAt: 1_100,
        downstreamGraceStartedAt: null,
        downstreamGraceEndsAt: null,
      },
    });
    mod.observeTrackedMarkets(["token-a"], 1_050);
    mod.observeTrackedMarkets(["token-a"], 1_100);
    mod.observeTrackedMarkets(["token-a"], 1_201);
    expect(worker.posted.filter(isTrackingObservation)).toMatchObject([
      { stage: "tracking", observedAt: 1_050 },
      { stage: "tracking", observedAt: 1_100 },
      { stage: "tracking", observedAt: 1_201 },
    ]);
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
  const stage = (value as { stage?: string }).stage;
  return (
    (value as { type?: string; stage?: string }).type === "observation" &&
    (stage === "tracking" || stage === "grace_tracking")
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
