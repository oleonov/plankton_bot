import { afterEach, describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@krabs/event-bus";
import { createConditionId, createPositionId, createTokenId, type Position } from "@krabs/domain";
import { RedeemSweepModule } from "../redeem-sweep-module.js";
import { DEFAULT_EXECUTION_POLICY } from "../../../execution-policy.js";
import { SettlementInfraBreaker } from "../../settlement-infra-breaker.js";

const NOW = Date.parse("2026-05-11T00:00:00.000Z");
const TOKEN = "tok-1";
const TOKEN_TWO = "tok-2";
const CONDITION = "cond-1";

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger(),
  } as any;
}

function remotePosition(overrides: Partial<any> = {}) {
  return {
    tokenId: TOKEN,
    conditionId: CONDITION,
    size: 10,
    currentValueUsdc: 1,
    initialValueUsdc: 1,
    redeemable: true,
    slug: "market",
    marketSlug: "market",
    outcome: "Yes",
    raw: {},
    ...overrides,
  };
}

function localPosition(tokenId = TOKEN): Position {
  return {
    positionId: createPositionId(`pos-${tokenId}`),
    tokenId: createTokenId(tokenId),
    conditionId: createConditionId(CONDITION),
    side: "buy",
    size: 10,
    avgEntryPrice: 0.1,
    costBasisUsdc: 1,
    currentValueUsdc: 1,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: new Date(NOW).toISOString(),
    closedAt: null,
    updatedAt: new Date(NOW).toISOString(),
  };
}

function makeRedeemQuarantineRepo(
  initial: Record<
    string,
    {
      consecutiveStateFailedCount?: number;
      redeemQuarantineUntilTs?: number | null;
      lastStateFailedTs?: number | null;
      positionRows?: number;
      totalBasisUsdc?: number;
    }
  > = {},
) {
  const states = new Map(
    Object.entries(initial).map(([conditionId, state]) => [
      conditionId,
      {
        conditionId,
        consecutiveStateFailedCount: state.consecutiveStateFailedCount ?? 0,
        redeemQuarantineUntilTs: state.redeemQuarantineUntilTs ?? null,
        lastStateFailedTs: state.lastStateFailedTs ?? null,
        positionRows: state.positionRows ?? 1,
        totalBasisUsdc: state.totalBasisUsdc ?? 1,
      },
    ]),
  );
  const reset = vi.fn((conditionId: string) => {
    const previous = states.get(conditionId);
    states.set(conditionId, {
      conditionId,
      consecutiveStateFailedCount: 0,
      redeemQuarantineUntilTs: null,
      lastStateFailedTs: previous?.lastStateFailedTs ?? null,
      positionRows: previous?.positionRows ?? 1,
      totalBasisUsdc: previous?.totalBasisUsdc ?? 1,
    });
    return {
      conditionId,
      changedRows: previous?.positionRows ?? 1,
      previousConsecutiveStateFailedCount: previous?.consecutiveStateFailedCount ?? 0,
      previousRedeemQuarantineUntilTs: previous?.redeemQuarantineUntilTs ?? null,
      reset:
        (previous?.consecutiveStateFailedCount ?? 0) > 0 ||
        (previous?.redeemQuarantineUntilTs ?? null) !== null,
    };
  });
  return {
    states,
    repo: {
      findByConditionIds: vi.fn((conditionIds: readonly string[]) => {
        const result = new Map();
        for (const conditionId of conditionIds) {
          const state = states.get(conditionId);
          if (state) result.set(conditionId, state);
        }
        return result;
      }),
      recordStateFailed: vi.fn(
        ({
          conditionId,
          nowTs,
          threshold,
          ttlMs,
        }: {
          conditionId: string;
          nowTs: number;
          threshold: number;
          ttlMs: number;
        }) => {
          const previous = states.get(conditionId);
          const previousUntil = previous?.redeemQuarantineUntilTs ?? null;
          const nextCount = (previous?.consecutiveStateFailedCount ?? 0) + 1;
          const nextUntil = nextCount >= threshold ? nowTs + ttlMs : previousUntil;
          const state = {
            conditionId,
            consecutiveStateFailedCount: nextCount,
            redeemQuarantineUntilTs: nextUntil,
            lastStateFailedTs: nowTs,
            positionRows: previous?.positionRows ?? 1,
            totalBasisUsdc: previous?.totalBasisUsdc ?? 1,
          };
          states.set(conditionId, state);
          return {
            ...state,
            enteredQuarantine:
              nextUntil !== null &&
              nextUntil > nowTs &&
              (previousUntil === null || previousUntil <= nowTs),
          };
        },
      ),
      clearAfterSuccess: reset,
      clearExpired: reset,
    },
  };
}

function makeHarness(
  opts: {
    positions?: any[];
    readImpl?: () => Promise<any[] | null>;
    redeemImpl?: () => Promise<any>;
    policy?: Partial<typeof DEFAULT_EXECUTION_POLICY.redeemSweep>;
    redeemLogRows?: any[];
    uniqueViolationOnFirstAttemptingInsert?: boolean;
    marketRows?: any[];
    openOrders?: any[];
    runtimeControl?: { isPaused: () => boolean };
    quarantineStates?: Parameters<typeof makeRedeemQuarantineRepo>[0];
    settlementInfraBreaker?: SettlementInfraBreaker;
  } = {},
) {
  const bus = new InProcessEventBus();
  const log = logger();
  const redeemLogRows: any[] = opts.redeemLogRows ?? [];
  const position = localPosition();
  const positionRepo = {
    findByTokenId: vi.fn((tokenId) => (String(tokenId) === TOKEN ? position : null)),
    save: vi.fn(),
  };
  const lotRepo = { settleAll: vi.fn() };
  const gateway = {
    redeemPositions: vi.fn(
      opts.redeemImpl ??
        (() =>
          Promise.resolve({
            status: "confirmed",
            conditionIds: [CONDITION],
            txHash: "0xredeem",
            gasUsed: 12345,
          })),
    ),
  };
  const reader = {
    read: vi.fn(opts.readImpl ?? (() => Promise.resolve(opts.positions ?? [remotePosition()]))),
  };
  const runtimeMetrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
  const orderRepo = { findOpen: vi.fn(() => opts.openOrders ?? []) };
  const quarantine = makeRedeemQuarantineRepo(opts.quarantineStates);
  let uniqueViolationOnFirstAttemptingInsert = opts.uniqueViolationOnFirstAttemptingInsert ?? false;
  const module = new RedeemSweepModule({
    bus,
    gateway: gateway as any,
    positionReader: reader,
    positionRepo: positionRepo as any,
    lotRepo: lotRepo as any,
    marketRepo: {
      findByConditionId: vi.fn(
        () =>
          opts.marketRows ?? [
            { tokenId: createTokenId(TOKEN), endDate: null },
            { tokenId: createTokenId(TOKEN_TWO), endDate: null },
          ],
      ),
    } as any,
    orderRepo: orderRepo as any,
    redeemLogRepo: {
      insert: vi.fn((row) => {
        if (row.status === "attempting" && uniqueViolationOnFirstAttemptingInsert) {
          uniqueViolationOnFirstAttemptingInsert = false;
          const err = new Error("UNIQUE constraint failed: redeem_log.condition_id") as Error & {
            code: string;
          };
          err.code = "SQLITE_CONSTRAINT_UNIQUE";
          throw err;
        }
        const nextId =
          redeemLogRows.reduce((max, existing) => Math.max(max, existing.id ?? 0), 0) + 1;
        redeemLogRows.push({ id: nextId, ...row });
      }),
      updateLatestActiveAttempt: vi.fn((entry) => {
        const row = redeemLogRows
          .filter(
            (existing) =>
              existing.conditionId === entry.conditionId &&
              isActiveRedeemLogStatus(existing.status),
          )
          .sort((a, b) => b.attemptTs - a.attemptTs || b.id - a.id)[0];
        if (!row) return false;
        Object.assign(row, entry);
        return true;
      }),
      findRecentActiveAttempts: vi.fn((sinceTs: number) =>
        redeemLogRows
          .filter((row) => isActiveRedeemLogStatus(row.status) && row.attemptTs > sinceTs)
          .filter((row) => !hasLaterRedeemLogRow(redeemLogRows, row))
          .map((row) => ({
            id: row.id,
            conditionId: row.conditionId,
            tokenIds: row.tokenIds,
            attemptTs: row.attemptTs,
            status: row.status,
            detailsJson: row.details ? JSON.stringify(row.details) : null,
          })),
      ),
      hasRecentActiveAttempt: vi.fn((conditionId: string, sinceTs: number) =>
        redeemLogRows.some(
          (row) =>
            row.conditionId === conditionId &&
            isActiveRedeemLogStatus(row.status) &&
            row.attemptTs > sinceTs &&
            !hasLaterRedeemLogRow(redeemLogRows, row),
        ),
      ),
      findLatestAttemptTs: vi.fn((conditionId: string) => {
        const row = redeemLogRows
          .filter((entry) => entry.conditionId === conditionId)
          .sort((a, b) => b.attemptTs - a.attemptTs || b.id - a.id)[0];
        return row?.attemptTs ?? null;
      }),
      markOrphanedActiveAttempts: vi.fn((cutoffTs: number, errorMsg: string) => {
        const rows = redeemLogRows.filter(
          (row) =>
            isActiveRedeemLogStatus(row.status) &&
            row.attemptTs <= cutoffTs &&
            !hasLaterRedeemLogRow(redeemLogRows, row),
        );
        for (const row of rows) {
          row.status = "failed_orphaned";
          row.errorMsg = row.errorMsg ?? errorMsg;
        }
        return rows.map((row) => ({
          id: row.id,
          conditionId: row.conditionId,
          attemptTs: row.attemptTs,
          status: row.status,
        }));
      }),
    } as any,
    redeemQuarantineRepo: quarantine.repo as any,
    policy: () => ({
      ...DEFAULT_EXECUTION_POLICY.redeemSweep,
      enabled: true,
      intervalMs: 60_000,
      inFlightTtlMs: 15 * 60_000,
      retryBackoffMs: [60_000, 300_000, 1_800_000],
      ...(opts.policy ?? {}),
    }),
    depositActivationPolicy: () => ({
      enabled: false,
      minAmountUsdcCents: 100,
    }),
    log,
    runtimeMetrics: runtimeMetrics as any,
    now: () => Date.now(),
    ...(opts.settlementInfraBreaker ? { settlementInfraBreaker: opts.settlementInfraBreaker } : {}),
    ...(opts.runtimeControl ? { runtimeControl: opts.runtimeControl } : {}),
  });
  return {
    bus,
    module,
    gateway,
    reader,
    redeemLogRows,
    positionRepo,
    lotRepo,
    orderRepo,
    log,
    runtimeMetrics,
    redeemQuarantineRepo: quarantine.repo,
    quarantineStates: quarantine.states,
  };
}

function isActiveRedeemLogStatus(status: string): boolean {
  return status === "attempting" || status === "submitted" || status === "pending";
}

function hasLaterRedeemLogRow(rows: readonly any[], row: any): boolean {
  return rows.some(
    (candidate) =>
      candidate.conditionId === row.conditionId &&
      (candidate.attemptTs > row.attemptTs ||
        (candidate.attemptTs === row.attemptTs && candidate.id > row.id)),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function coalescingPosition(index: number) {
  return remotePosition({
    tokenId: `tok-coalesce-${index}`,
    conditionId: `cond-coalesce-${index}`,
  });
}

function manyRedeemablePositions(count: number) {
  return Array.from({ length: count }, (_, index) =>
    remotePosition({
      tokenId: `tok-batch-${index + 1}`,
      conditionId: `cond-batch-${index + 1}`,
    }),
  );
}

function walletUpdateEvent(tokenId = TOKEN, conditionId = CONDITION) {
  return {
    positions: [
      {
        tokenId: createTokenId(tokenId),
        conditionId,
        size: 10,
        redeemable: true,
        slug: "market",
        outcome: "Yes",
      },
    ],
    timestamp: Date.now(),
  };
}

function runSweepForTest(module: RedeemSweepModule, reason = "periodic"): Promise<void> {
  return (
    module as unknown as {
      runSweep(reason: string): Promise<void>;
    }
  ).runSweep(reason);
}

function redeemConditionCallOrder(calls: readonly unknown[][]): string[] {
  return calls.map((call) => (call[0] as readonly string[])[0]!);
}

async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function runStableStartup(h: ReturnType<typeof makeHarness>): Promise<void> {
  await h.module.start();
  await runSweepForTest(h.module, "test-stability");
  await h.bus.drain();
}

async function primeCoalescingStability(h: ReturnType<typeof makeHarness>): Promise<void> {
  h.reader.read.mockResolvedValueOnce([coalescingPosition(1), coalescingPosition(2)]);
  await runSweepForTest(h.module, "prime-stability");
  h.gateway.redeemPositions.mockClear();
  h.reader.read.mockReset();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RedeemSweepModule", () => {
  it("redeems visible redeemable wallet positions and closes local state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({ policy: { intervalMs: 60 * 60_000 } });
    await runStableStartup(h);

    expect(h.gateway.redeemPositions).toHaveBeenCalledWith([CONDITION], {
      redeemTokenIdsByCondition: { [CONDITION]: [createTokenId(TOKEN)] },
    });
    expect(h.redeemLogRows.map((row) => row.status)).toEqual(["success"]);
    expect(h.redeemLogRows.at(-1)).toMatchObject({
      txHash: "0xredeem",
      gasUsed: 12345,
      details: expect.objectContaining({ gatewayStatus: "confirmed" }),
    });
    expect(h.lotRepo.settleAll).toHaveBeenCalledWith(createPositionId(`pos-${TOKEN}`));
    expect(h.positionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ size: 0, status: "closed" }),
    );
  });

  it("skips a duplicate attempt inside the per-condition TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness();
    await runStableStartup(h);
    await h.bus.publish("PolymarketWalletUpdated", walletUpdateEvent());
    await h.bus.drain();

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
  });

  it("queues wallet-event sweeps and returns to the event bus without waiting for IO", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({ positions: [] });
    await h.module.start();
    await h.bus.drain();
    h.reader.read.mockClear();
    const pendingRead = deferred<any[] | null>();
    h.reader.read.mockReturnValueOnce(pendingRead.promise);

    let publishResolved = false;
    const publish = h.bus.publish("PolymarketWalletUpdated", walletUpdateEvent()).then(() => {
      publishResolved = true;
    });
    await flushMicrotasks();

    expect(publishResolved).toBe(true);
    expect(h.reader.read).toHaveBeenCalledTimes(1);
    expect(h.runtimeMetrics.writeLatest).toHaveBeenCalledWith(
      "redeem_sweep_async_queue_depth",
      expect.any(Number),
      null,
      expect.any(String),
    );

    pendingRead.resolve([]);
    await publish;
    await flushMicrotasks();
  });

  it("runs an enqueued wallet-event sweep asynchronously after publish returns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({ positions: [] });
    await h.module.start();
    await primeCoalescingStability(h);
    h.reader.read.mockResolvedValueOnce([coalescingPosition(1)]);

    await h.bus.publish(
      "PolymarketWalletUpdated",
      walletUpdateEvent("tok-coalesce-1", "cond-coalesce-1"),
    );
    await flushMicrotasks();

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
    expect(h.gateway.redeemPositions).toHaveBeenCalledWith(["cond-coalesce-1"], {
      redeemTokenIdsByCondition: { "cond-coalesce-1": [createTokenId("tok-coalesce-1")] },
    });
  });

  it("records async sweep failures without surfacing them through wallet-event publish", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({ positions: [] });
    await h.module.start();
    await h.bus.drain();
    h.reader.read.mockRejectedValueOnce(new Error("wallet reader down"));

    await h.bus.publish("PolymarketWalletUpdated", walletUpdateEvent());
    await flushMicrotasks();

    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), reason: "wallet-event" }),
      "redeem sweep async worker failed",
    );
    expect(h.runtimeMetrics.writeEvent).toHaveBeenCalledWith(
      "redeem_sweep_async_failed_total",
      1,
      JSON.stringify({ reason: "wallet-event" }),
      expect.any(String),
    );
  });

  it("records overflow when wallet-event async queue is saturated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({ positions: [] });
    await h.module.start();
    await h.bus.drain();
    h.reader.read.mockClear();
    const pendingRead = deferred<any[] | null>();
    h.reader.read.mockReturnValueOnce(pendingRead.promise);

    const publishes = Array.from({ length: 18 }, (_, index) =>
      h.bus.publish(
        "PolymarketWalletUpdated",
        walletUpdateEvent(`tok-overflow-${index}`, CONDITION),
      ),
    );
    await flushMicrotasks();

    expect(h.runtimeMetrics.writeEvent).toHaveBeenCalledWith(
      "redeem_sweep_async_queue_overflow_total",
      1,
      JSON.stringify({ reason: "wallet-event", max_depth: 16 }),
      expect.any(String),
    );

    pendingRead.resolve([]);
    await Promise.all(publishes);
    await flushMicrotasks();
  });

  it("keeps Track D quarantine gating on async wallet-event sweeps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      positions: [],
      quarantineStates: {
        "cond-quarantined": {
          consecutiveStateFailedCount: 5,
          redeemQuarantineUntilTs: NOW + 60_000,
        },
      },
    });
    await h.module.start();
    await h.bus.drain();
    h.reader.read.mockResolvedValueOnce([
      remotePosition({ tokenId: "tok-quarantined", conditionId: "cond-quarantined" }),
    ]);

    await h.bus.publish(
      "PolymarketWalletUpdated",
      walletUpdateEvent("tok-quarantined", "cond-quarantined"),
    );
    await flushMicrotasks();

    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();
    expect(h.runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "redeem_quarantine_skipped_total",
      1,
      JSON.stringify({ reason: "state_failed_quarantine" }),
    );
  });

  it("retries a failed redeem and records retry_count on success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemImpl: vi
        .fn()
        .mockRejectedValueOnce(new Error("relayer down"))
        .mockResolvedValueOnce({
          status: "confirmed",
          conditionIds: [CONDITION],
          txHash: "0xretry",
          gasUsed: 111,
        }),
    });
    await runStableStartup(h);

    await vi.advanceTimersByTimeAsync(60_000);
    await h.bus.drain();

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(2);
    expect(h.redeemLogRows.map((row) => row.status)).toEqual(["failed", "success"]);
    expect(h.redeemLogRows.at(-1)).toMatchObject({ retryCount: 1 });
  });

  it("does not close local state for pending settlement until verification clears remote shares", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemImpl: vi.fn().mockResolvedValue({
        status: "pending",
        conditionIds: [CONDITION],
        txHash: "0xpending",
        gasUsed: null,
      }),
      policy: { postRedeemVerifyDelayMs: 1_000 },
    });
    await runStableStartup(h);

    expect(h.redeemLogRows.map((row) => row.status)).toEqual(["pending"]);
    expect(h.positionRepo.save).not.toHaveBeenCalled();
    expect(h.lotRepo.settleAll).not.toHaveBeenCalled();

    h.reader.read.mockResolvedValueOnce([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await h.bus.drain();

    expect(h.positionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ size: 0, status: "closed" }),
    );
  });

  it("does not close local state when redeem is skipped because settlement is unsupported", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemImpl: vi.fn().mockResolvedValue({
        status: "skipped",
        conditionIds: [CONDITION],
        reason: "unsupported_settlement",
        txHash: null,
        gasUsed: null,
      }),
    });
    await runStableStartup(h);

    expect(h.redeemLogRows.map((row) => row.status)).toEqual(["rejected"]);
    expect(h.positionRepo.save).not.toHaveBeenCalled();
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION, gatewayReason: "unsupported_settlement" }),
      "redeem sweep skipped without settlement support",
    );
  });

  it("emits failed_max_retries after configured retry exhaustion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemImpl: vi.fn().mockRejectedValue(new Error("relayer down")),
      policy: { maxRetries: 1, retryBackoffMs: [60_000] },
    });
    await runStableStartup(h);
    await vi.advanceTimersByTimeAsync(60_000);
    await h.bus.drain();

    expect(h.redeemLogRows.at(-1)).toMatchObject({
      status: "failed_max_retries",
      retryCount: 1,
    });
    expect(h.log.error).toHaveBeenCalled();
  });

  it("redeems only the redeemable token in a partial condition", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      positions: [
        remotePosition({ tokenId: TOKEN, redeemable: true }),
        remotePosition({ tokenId: TOKEN_TWO, redeemable: false, size: 4 }),
      ],
    });
    await runStableStartup(h);

    expect(h.gateway.redeemPositions).toHaveBeenCalledWith([CONDITION], {
      redeemTokenIdsByCondition: { [CONDITION]: [createTokenId(TOKEN)] },
    });
    expect(h.redeemLogRows[0]!.details).toMatchObject({ excludedTokenIds: [TOKEN_TWO] });
  });

  it("post-redeem verification retries when remote shares remain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness();
    await runStableStartup(h);

    await vi.advanceTimersByTimeAsync(DEFAULT_EXECUTION_POLICY.redeemSweep.postRedeemVerifyDelayMs);
    await h.bus.drain();

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(2);
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION }),
      "redeem sweep verification found remaining wallet shares",
    );
  });

  it("handles a redeem_log unique in-flight race without retrying or alerting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({ uniqueViolationOnFirstAttemptingInsert: true });
    await runStableStartup(h);

    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();
    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION }),
      "redeem sweep race detected, condition already in-flight",
    );
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it("serializes startup and wallet-event sweeps through one single-flight guard", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const firstRead = deferred<any[]>();
    const h = makeHarness({
      readImpl: vi
        .fn()
        .mockReturnValueOnce(firstRead.promise)
        .mockResolvedValueOnce([
          remotePosition({ tokenId: "tok-event", conditionId: "cond-event" }),
        ]),
    });

    const startPromise = h.module.start();
    await Promise.resolve();
    const eventPromise = h.bus.publish("PolymarketWalletUpdated", {
      positions: [
        {
          tokenId: createTokenId("tok-event"),
          conditionId: "cond-event",
          size: 8,
          redeemable: true,
          slug: "event-market",
          outcome: "Yes",
        },
      ],
      timestamp: Date.now(),
    });
    await Promise.resolve();

    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();
    firstRead.resolve([remotePosition()]);
    await startPromise;
    await eventPromise;
    await h.bus.drain();

    expect(h.reader.read).toHaveBeenCalledTimes(2);
    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();
  });

  it("coalescing: drops duplicate trigger while sweep is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({ positions: [] });
    await h.module.start();
    await primeCoalescingStability(h);
    const firstRedeem = deferred<any>();
    h.reader.read
      .mockResolvedValueOnce([coalescingPosition(1)])
      .mockResolvedValueOnce([coalescingPosition(2)]);
    h.gateway.redeemPositions.mockReturnValueOnce(firstRedeem.promise);

    const firstSweep = runSweepForTest(h.module);
    await flushMicrotasks();
    let secondResolved = false;
    const secondSweep = runSweepForTest(h.module, "reactive").then(() => {
      secondResolved = true;
    });
    await flushMicrotasks();

    expect(h.reader.read).toHaveBeenCalledTimes(1);
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
    expect(secondResolved).toBe(true);

    firstRedeem.resolve({ status: "confirmed", conditionIds: ["cond-coalesce-1"] });
    await firstSweep;
    await secondSweep;
  });

  it("coalescing: pending trigger executes one follow-up after current completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({ positions: [] });
    await h.module.start();
    await primeCoalescingStability(h);
    const firstRedeem = deferred<any>();
    h.reader.read
      .mockResolvedValueOnce([coalescingPosition(1)])
      .mockResolvedValueOnce([coalescingPosition(2)]);
    h.gateway.redeemPositions
      .mockReturnValueOnce(firstRedeem.promise)
      .mockResolvedValue({ status: "confirmed", conditionIds: ["cond-coalesce-2"] });

    const firstSweep = runSweepForTest(h.module);
    await flushMicrotasks();
    await runSweepForTest(h.module, "reactive");
    await flushMicrotasks();

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
    firstRedeem.resolve({ status: "confirmed", conditionIds: ["cond-coalesce-1"] });
    await firstSweep;
    await flushMicrotasks();

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(2);
    expect((h.module as unknown as { pendingSweepReason: string | null }).pendingSweepReason).toBe(
      null,
    );
  });

  it("coalescing: 5 rapid triggers result in exactly 1 follow-up, not 5", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({ positions: [] });
    await h.module.start();
    await primeCoalescingStability(h);
    const firstRedeem = deferred<any>();
    h.reader.read
      .mockResolvedValueOnce([coalescingPosition(1)])
      .mockResolvedValueOnce([coalescingPosition(2)]);
    h.gateway.redeemPositions
      .mockReturnValueOnce(firstRedeem.promise)
      .mockResolvedValue({ status: "confirmed", conditionIds: ["cond-coalesce-2"] });

    const firstSweep = runSweepForTest(h.module);
    await flushMicrotasks();
    for (let i = 1; i <= 5; i += 1) {
      await runSweepForTest(h.module, `reactive-${i}`);
    }

    expect((h.module as unknown as { pendingSweepReason: string | null }).pendingSweepReason).toBe(
      "reactive-5",
    );
    firstRedeem.resolve({ status: "confirmed", conditionIds: ["cond-coalesce-1"] });
    await firstSweep;
    await flushMicrotasks();

    expect(h.reader.read).toHaveBeenCalledTimes(2);
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(2);
    expect(redeemConditionCallOrder(h.gateway.redeemPositions.mock.calls as unknown[][])).toEqual([
      "cond-coalesce-1",
      "cond-coalesce-2",
    ]);
  });

  it("coalescing: error in first sweep does not block subsequent calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({ positions: [] });
    await h.module.start();
    await primeCoalescingStability(h);
    h.reader.read
      .mockResolvedValueOnce([coalescingPosition(1)])
      .mockResolvedValueOnce([coalescingPosition(2)]);
    h.gateway.redeemPositions
      .mockRejectedValueOnce(new Error("relayer down"))
      .mockResolvedValueOnce({ status: "confirmed", conditionIds: ["cond-coalesce-2"] });

    await runSweepForTest(h.module);
    expect((h.module as unknown as { isSweepRunning: boolean }).isSweepRunning).toBe(false);
    await runSweepForTest(h.module);

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(2);
    expect(h.gateway.redeemPositions).toHaveBeenLastCalledWith(["cond-coalesce-2"], {
      redeemTokenIdsByCondition: { "cond-coalesce-2": [createTokenId("tok-coalesce-2")] },
    });
  });

  it("caps verification-triggered retries when remote shares never clear", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      policy: { maxRetries: 1, postRedeemVerifyDelayMs: 1_000 },
    });
    await runStableStartup(h);

    await vi.advanceTimersByTimeAsync(1_000);
    await h.bus.drain();
    await vi.advanceTimersByTimeAsync(1_000);
    await h.bus.drain();

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(2);
    expect(h.redeemLogRows.at(-1)).toMatchObject({
      status: "failed_max_retries",
      errorMsg: "verification_retry_budget_exhausted",
      retryCount: 1,
    });
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION }),
      "redeem sweep verification exhausted retry budget",
    );
  });

  it("reacts to wallet snapshot events without waiting for the timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({ positions: [] });
    await h.module.start();
    await h.bus.drain();
    h.reader.read.mockResolvedValue([remotePosition()]);
    const walletEvent = {
      positions: [
        {
          tokenId: createTokenId(TOKEN),
          conditionId: CONDITION,
          size: 10,
          redeemable: true,
          slug: "market",
          outcome: "Yes",
        },
      ],
      timestamp: Date.now(),
    };
    await h.bus.publish("PolymarketWalletUpdated", walletEvent);
    await h.bus.publish("PolymarketWalletUpdated", walletEvent);
    await h.bus.drain();
    await flushMicrotasks();

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
  });

  it("batches multiple ready conditions in one gateway call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      positions: [
        remotePosition({ tokenId: TOKEN, conditionId: "cond-1" }),
        remotePosition({ tokenId: TOKEN_TWO, conditionId: "cond-2" }),
      ],
    });
    await runStableStartup(h);

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
    expect(h.gateway.redeemPositions).toHaveBeenCalledWith(["cond-1", "cond-2"], {
      redeemTokenIdsByCondition: {
        "cond-1": [createTokenId(TOKEN)],
        "cond-2": [createTokenId(TOKEN_TWO)],
      },
    });
  });

  it("caps redeem batch size at 9 and waits 5 minutes between batches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const positions = manyRedeemablePositions(10);
    const h = makeHarness({
      positions,
      policy: { intervalMs: 60 * 60_000, postRedeemVerifyDelayMs: 60 * 60_000 },
    });
    await h.module.start();
    await h.bus.drain();

    const sweep = runSweepForTest(h.module, "batch-cap");
    await flushMicrotasks();

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
    expect((h.gateway.redeemPositions.mock.calls as any[])[0]?.[0]).toHaveLength(9);

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    await flushMicrotasks();
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await sweep;

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(2);
    expect((h.gateway.redeemPositions.mock.calls as any[])[1]?.[0]).toEqual(["cond-batch-10"]);
  });

  it("redeems on Data API redeemable=true even when market end_date is far in the future", async () => {
    // Regression: Gamma returns event-level end_date (e.g. tournament end) instead
    // of actual settlement time, so an "end_date + Nh" gate would block forever.
    // The Data API redeemable flag is sourced from on-chain CTF settlement state
    // and is the canonical readiness signal — we now trust it directly.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const farFuture = new Date(NOW + 5 * 24 * 60 * 60_000).toISOString();
    const h = makeHarness({
      marketRows: [{ tokenId: createTokenId(TOKEN), endDate: farFuture }],
    });
    await runStableStartup(h);

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
    expect(h.redeemLogRows.some((row) => row.errorMsg === "min_age_after_resolution")).toBe(false);
    expect(h.redeemLogRows.some((row) => row.errorMsg === "missing_end_date")).toBe(false);
  });

  it("redeems when market end_date is null (Gamma dropped the market)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      marketRows: [{ tokenId: createTokenId(TOKEN), endDate: null }],
    });
    await runStableStartup(h);

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
    expect(h.redeemLogRows.some((row) => row.errorMsg === "missing_end_date")).toBe(false);
  });

  it("hard-pauses all redeem sweeps for the upstream reset window after Polygon RPC 429", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const first = remotePosition({ tokenId: "tok-rate", conditionId: "cond-rate" });
    const later = remotePosition({ tokenId: "tok-later", conditionId: "cond-later" });
    const h = makeHarness({
      positions: [first, later],
      redeemImpl: vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            '{"error":"request error","status":429,"data":{"error":"quota exceeded: 0 units remaining, resets in 5695 seconds"}}',
          ),
        )
        .mockResolvedValue({ status: "confirmed", conditionIds: ["cond-later"] }),
    });
    await h.module.start();
    h.reader.read.mockResolvedValue([first]);
    await runSweepForTest(h.module, "rate-limit-hit");

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);

    h.reader.read.mockResolvedValue([later]);
    await runSweepForTest(h.module, "during-hard-pause");
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await runSweepForTest(h.module, "default-hard-pause-expired");
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync((5_695 - 300) * 1_000 + 1);
    await runSweepForTest(h.module, "after-upstream-reset");
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(2);
    expect(h.gateway.redeemPositions).toHaveBeenLastCalledWith(["cond-later"], {
      redeemTokenIdsByCondition: { "cond-later": [createTokenId("tok-later")] },
    });
  });

  it("hard-pauses when the settlement infra-alert callback reports Polygon RPC 429", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness();
    await h.module.start();
    h.module.notifySettlementInfraAlert("POLYGON_RPC_RATE_LIMITED");
    await runSweepForTest(h.module, "infra-alert");

    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await runSweepForTest(h.module, "after-infra-alert");
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
  });

  it("coalesces wallet-event sweeps while the shared settlement breaker is open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const breaker = new SettlementInfraBreaker({ now: () => Date.now() });
    const h = makeHarness({ settlementInfraBreaker: breaker });
    await h.module.start();
    vi.mocked(h.gateway.redeemPositions).mockClear();
    vi.mocked(h.runtimeMetrics.writeEvent).mockClear();

    breaker.pause(
      "POLYGON_RPC_RATE_LIMITED",
      new Error(
        '{"error":"request error","status":429,"data":{"error":"quota exceeded: 0 units remaining, resets in 600 seconds"}}',
      ),
    );
    await h.bus.publish("PolymarketWalletUpdated", walletUpdateEvent());
    await h.bus.publish("PolymarketWalletUpdated", walletUpdateEvent());

    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();
    const suppressed = vi
      .mocked(h.runtimeMetrics.writeEvent)
      .mock.calls.filter((call) => call[0] === "redeem_sweep_async_suppressed_hard_pause_total");
    expect(suppressed).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await h.bus.publish("PolymarketWalletUpdated", walletUpdateEvent());
    const afterWindow = vi
      .mocked(h.runtimeMetrics.writeEvent)
      .mock.calls.filter((call) => call[0] === "redeem_sweep_async_suppressed_hard_pause_total");
    expect(afterWindow).toHaveLength(2);
  });

  it("treats null verification reads as transient and empty reads as verified zero", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemImpl: vi.fn().mockResolvedValue({
        status: "pending",
        conditionIds: [CONDITION],
        txHash: "0xpending",
        gasUsed: null,
      }),
      policy: { postRedeemVerifyDelayMs: 1_000 },
    });
    await runStableStartup(h);

    h.reader.read.mockResolvedValueOnce(null).mockResolvedValueOnce([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await h.bus.drain();

    expect(h.positionRepo.save).not.toHaveBeenCalled();
    expect(h.redeemLogRows.map((row) => row.status)).toEqual(["pending"]);

    await vi.advanceTimersByTimeAsync(1_000);
    await h.bus.drain();

    expect(h.redeemLogRows.map((row) => row.status)).toEqual(["success"]);
    expect(h.positionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ size: 0, status: "closed" }),
    );
  });

  it("cooldowns a condition for 30 minutes after STATE_FAILED", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemImpl: vi
        .fn()
        .mockRejectedValueOnce(
          new Error("Settlement transaction reached failed state before balances cleared"),
        )
        .mockResolvedValue({ status: "confirmed", conditionIds: [CONDITION] }),
      policy: { inFlightTtlMs: 0, intervalMs: 60 * 60_000 },
    });
    await h.module.start();
    await runSweepForTest(h.module, "state-failed");
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
    await runSweepForTest(h.module, "blocked");
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
    expect(h.redeemLogRows.at(-1)).toMatchObject({
      status: "skipped",
      errorMsg: "state_failed_cooldown",
      details: { reason: "state_failed_cooldown", source: "blocked" },
    });

    await vi.advanceTimersByTimeAsync(1);
    await runSweepForTest(h.module, "unblocked");
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(2);
  });

  it("quarantines a condition after the configured STATE_FAILED threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemImpl: vi
        .fn()
        .mockRejectedValueOnce(
          new Error("Settlement transaction reached failed state before balances cleared"),
        )
        .mockRejectedValueOnce(
          new Error("Settlement transaction reached failed state before balances cleared"),
        ),
      policy: {
        inFlightTtlMs: 0,
        intervalMs: 60 * 60_000,
        stateFailedQuarantineThreshold: 2,
        stateFailedQuarantineTtlHours: 24,
      },
    });
    await h.module.start();
    await runSweepForTest(h.module, "state-failed-1");
    expect(h.quarantineStates.get(CONDITION)).toMatchObject({
      consecutiveStateFailedCount: 1,
      redeemQuarantineUntilTs: null,
    });

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await runSweepForTest(h.module, "state-failed-2");

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(2);
    expect(h.quarantineStates.get(CONDITION)).toMatchObject({
      consecutiveStateFailedCount: 2,
      redeemQuarantineUntilTs: NOW + 30 * 60_000 + 24 * 60 * 60_000,
    });
    expect(h.runtimeMetrics.writeEvent).toHaveBeenCalledWith(
      "redeem_quarantined_total",
      1,
      expect.stringContaining(CONDITION),
      expect.any(String),
    );
  });

  it("skips an active quarantine before calling the gateway", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      quarantineStates: {
        [CONDITION]: {
          consecutiveStateFailedCount: 5,
          redeemQuarantineUntilTs: NOW + 60 * 60_000,
          lastStateFailedTs: NOW - 60_000,
        },
      },
    });

    await h.module.start();

    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();
    expect(h.redeemLogRows.at(-1)).toMatchObject({
      status: "skipped",
      errorMsg: "state_failed_quarantine",
      details: expect.objectContaining({
        reason: "state_failed_quarantine",
        consecutiveStateFailedCount: 5,
      }),
    });
    expect(h.runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "redeem_quarantine_skipped_total",
      1,
      JSON.stringify({ reason: "state_failed_quarantine" }),
    );
  });

  it("resets the STATE_FAILED counter on redeem success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      quarantineStates: {
        [CONDITION]: {
          consecutiveStateFailedCount: 3,
          lastStateFailedTs: NOW - 60_000,
        },
      },
    });

    await runStableStartup(h);

    expect(h.quarantineStates.get(CONDITION)).toMatchObject({
      consecutiveStateFailedCount: 0,
      redeemQuarantineUntilTs: null,
    });
    expect(h.runtimeMetrics.writeEvent).toHaveBeenCalledWith(
      "redeem_quarantine_counter_reset_total",
      1,
      expect.stringContaining("success"),
      expect.any(String),
    );
  });

  it("does not reset the STATE_FAILED counter on non-STATE_FAILED failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemImpl: vi.fn().mockRejectedValueOnce(new Error("relayer down")),
      quarantineStates: {
        [CONDITION]: {
          consecutiveStateFailedCount: 3,
          lastStateFailedTs: NOW - 60_000,
        },
      },
    });

    await h.module.start();
    await runSweepForTest(h.module, "transient-failure");

    expect(h.redeemQuarantineRepo.recordStateFailed).not.toHaveBeenCalled();
    expect(h.redeemQuarantineRepo.clearAfterSuccess).not.toHaveBeenCalled();
    expect(h.quarantineStates.get(CONDITION)).toMatchObject({
      consecutiveStateFailedCount: 3,
    });
  });

  it("leaves the STATE_FAILED counter unchanged on RPC 429 hard-pause", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemImpl: vi
        .fn()
        .mockRejectedValueOnce(
          new Error("429 quota exceeded: 0 units remaining, resets in 60 seconds"),
        ),
      quarantineStates: {
        [CONDITION]: {
          consecutiveStateFailedCount: 2,
          lastStateFailedTs: NOW - 60_000,
        },
      },
    });

    await h.module.start();
    await runSweepForTest(h.module, "rate-limited");

    expect(h.redeemQuarantineRepo.recordStateFailed).not.toHaveBeenCalled();
    expect(h.quarantineStates.get(CONDITION)).toMatchObject({
      consecutiveStateFailedCount: 2,
    });
  });

  it("bypasses quarantine and counter updates when circuit breaker is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      policy: { circuitBreakerEnabled: false },
      quarantineStates: {
        [CONDITION]: {
          consecutiveStateFailedCount: 5,
          redeemQuarantineUntilTs: NOW + 60 * 60_000,
        },
      },
    });

    await runStableStartup(h);

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
    expect(h.redeemQuarantineRepo.recordStateFailed).not.toHaveBeenCalled();
    expect(h.redeemQuarantineRepo.clearAfterSuccess).not.toHaveBeenCalled();
  });

  it("redeems healthy conditions in a mixed batch while skipping quarantined ones", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      positions: [
        remotePosition({ tokenId: TOKEN, conditionId: CONDITION }),
        remotePosition({ tokenId: "tok-ok", conditionId: "cond-ok" }),
      ],
      quarantineStates: {
        [CONDITION]: {
          consecutiveStateFailedCount: 5,
          redeemQuarantineUntilTs: NOW + 60 * 60_000,
        },
      },
    });

    await runStableStartup(h);

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
    expect(h.gateway.redeemPositions).toHaveBeenCalledWith(["cond-ok"], {
      redeemTokenIdsByCondition: { "cond-ok": [createTokenId("tok-ok")] },
    });
    expect(h.redeemLogRows.some((row) => row.errorMsg === "state_failed_quarantine")).toBe(true);
  });

  it("expires quarantine, resets the counter, and retries after a fresh stability snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      quarantineStates: {
        [CONDITION]: {
          consecutiveStateFailedCount: 5,
          redeemQuarantineUntilTs: NOW - 1,
          lastStateFailedTs: NOW - 24 * 60 * 60_000,
        },
      },
    });

    await h.module.start();
    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();
    expect(h.quarantineStates.get(CONDITION)).toMatchObject({
      consecutiveStateFailedCount: 0,
      redeemQuarantineUntilTs: null,
    });
    expect(h.runtimeMetrics.writeEvent).toHaveBeenCalledWith(
      "redeem_quarantine_expired_total",
      1,
      expect.stringContaining(CONDITION),
      expect.any(String),
    );

    await runSweepForTest(h.module, "after-expiry-stable");
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
  });

  it("skips redeem when active orders exist on the same condition", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      openOrders: [{ conditionId: CONDITION, status: "open" }],
    });
    await runStableStartup(h);

    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();
    expect(h.redeemLogRows.at(-1)).toMatchObject({
      status: "skipped",
      errorMsg: "active_orders_exist",
    });
    expect(h.runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "redeem_sweep_skipped_total",
      1,
      JSON.stringify({ reason: "active_orders_exist" }),
    );
    expect(
      vi
        .mocked(h.runtimeMetrics.writeCounter)
        .mock.calls.some(
          ([name, , labels]) =>
            name === "redeem_sweep_skipped_total" && String(labels).includes(CONDITION),
        ),
    ).toBe(false);
  });

  it("requires two consecutive redeemable wallet snapshots before redeem", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness();
    await h.module.start();
    await h.bus.drain();

    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();

    await runSweepForTest(h.module, "second-snapshot");
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
  });

  it("does not redeem while disabled but can be enabled without restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const policy: Partial<typeof DEFAULT_EXECUTION_POLICY.redeemSweep> = { enabled: false };
    const h = makeHarness({ policy });
    await h.module.start();
    await runSweepForTest(h.module, "disabled");

    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();

    policy.enabled = true;
    await runSweepForTest(h.module, "enabled-prime");
    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();

    await runSweepForTest(h.module, "enabled-stable");
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
  });

  it("includes zero-size redeemable token ids in redeem requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      positions: [remotePosition({ size: 0, redeemable: true })],
    });
    await runStableStartup(h);

    expect(h.gateway.redeemPositions).toHaveBeenCalledWith([CONDITION], {
      redeemTokenIdsByCondition: { [CONDITION]: [createTokenId(TOKEN)] },
    });
  });

  it("loads recent attempting rows after restart and blocks duplicate reservation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemLogRows: [
        {
          id: 1,
          conditionId: CONDITION,
          tokenIds: [TOKEN],
          attemptTs: NOW - 60_000,
          status: "attempting",
        },
      ],
    });
    await h.module.start();
    await h.bus.drain();

    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();
    expect(h.module.isConditionInRedeemFlight(CONDITION)).toBe(true);
  });

  it("keeps in-flight guard active while redeem sweep is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      policy: { enabled: false },
      redeemLogRows: [
        {
          id: 1,
          conditionId: CONDITION,
          tokenIds: [TOKEN],
          attemptTs: NOW - 60_000,
          status: "submitted",
        },
      ],
    });
    await h.module.start();
    await h.bus.drain();

    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();
    expect(h.module.isConditionInRedeemFlight(CONDITION)).toBe(true);
  });

  it("reloads submitted rows after restart and schedules verification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemLogRows: [
        {
          id: 1,
          conditionId: CONDITION,
          tokenIds: [TOKEN],
          attemptTs: NOW - 4 * 60_000,
          status: "submitted",
          details: { excludedTokenIds: [TOKEN_TWO] },
        },
      ],
    });
    await h.module.start();
    await h.bus.drain();

    expect(h.module.isConditionInRedeemFlight(CONDITION)).toBe(true);
    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await h.bus.drain();

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
    expect(h.gateway.redeemPositions).toHaveBeenCalledWith([CONDITION], {
      redeemTokenIdsByCondition: { [CONDITION]: [createTokenId(TOKEN)] },
    });
    expect(h.redeemLogRows.map((row) => row.status)).toEqual(["failed", "success"]);
    expect(h.redeemLogRows.at(-1)).toMatchObject({
      status: "success",
      details: { source: "verify", excludedTokenIds: [TOKEN_TWO] },
    });
  });

  it("marks old attempting rows as orphaned on restart and alerts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemLogRows: [
        {
          id: 1,
          conditionId: CONDITION,
          tokenIds: [TOKEN],
          attemptTs: NOW - 31 * 60_000,
          status: "attempting",
        },
      ],
    });
    await h.module.start();
    await h.bus.drain();

    expect(h.redeemLogRows[0]).toMatchObject({
      status: "failed_orphaned",
      errorMsg: "runtime_restart_during_attempt",
    });
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ orphaned: expect.any(Array) }),
      "redeem sweep recovered orphaned attempts after runtime restart",
    );
  });

  it("does not reload successful attempts as in-flight after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemLogRows: [
        {
          id: 1,
          conditionId: "cond-success",
          tokenIds: [TOKEN],
          attemptTs: NOW - 60_000,
          status: "success",
        },
      ],
      positions: [],
    });
    await h.module.start();

    expect(h.module.isConditionInRedeemFlight("cond-success")).toBe(false);
  });

  it("does not reload failed attempts as in-flight after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemLogRows: [
        {
          id: 1,
          conditionId: "cond-failed",
          tokenIds: [TOKEN],
          attemptTs: NOW - 60_000,
          status: "failed",
        },
      ],
      positions: [],
    });
    await h.module.start();

    expect(h.module.isConditionInRedeemFlight("cond-failed")).toBe(false);
  });

  it("waits for startup in-flight load before the first wallet-event sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      redeemLogRows: [
        {
          id: 1,
          conditionId: CONDITION,
          tokenIds: [TOKEN],
          attemptTs: NOW - 60_000,
          status: "attempting",
        },
      ],
      positions: [],
    });
    const startPromise = h.module.start();
    await h.bus.publish("PolymarketWalletUpdated", {
      positions: [
        {
          tokenId: createTokenId(TOKEN),
          conditionId: CONDITION,
          size: 10,
          redeemable: true,
          slug: "market",
          outcome: "Yes",
        },
      ],
      timestamp: Date.now(),
    });
    await startPromise;
    await h.bus.drain();

    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();
  });

  it("records partial-ambiguous rows per condition and emits one batch warning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      positions: [
        remotePosition({ tokenId: "amb-1", conditionId: null }),
        remotePosition({ tokenId: "amb-2", conditionId: null }),
        remotePosition({ tokenId: "amb-3", conditionId: null }),
      ],
    });
    await h.module.start();
    await h.bus.drain();

    expect(h.redeemLogRows.filter((row) => row.errorMsg === "partial_ambiguous")).toHaveLength(3);
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ count: 3, conditionIds: expect.any(Array) }),
      "redeem_sweep_partial_ambiguous_batch",
    );
  });

  it("records one partial-ambiguous redeem_log entry for one ambiguous position", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      positions: [remotePosition({ tokenId: "amb-one", conditionId: null })],
    });
    await h.module.start();
    await h.bus.drain();

    expect(h.redeemLogRows).toContainEqual(
      expect.objectContaining({
        conditionId: "unknown:amb-one",
        tokenIds: ["amb-one"],
        status: "rejected",
        errorMsg: "partial_ambiguous",
        details: expect.objectContaining({
          includedTokenIds: ["amb-one"],
          excludedTokenIds: [],
        }),
      }),
    );
  });

  it("increments partial-ambiguous counters per condition", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = makeHarness({
      positions: [remotePosition({ tokenId: "amb-1", conditionId: null })],
    });
    await h.module.start();
    await h.bus.drain();

    expect(h.runtimeMetrics.writeEvent).toHaveBeenCalledWith(
      "redeem_partial_ambiguous_total",
      1,
      JSON.stringify({ condition_id: "unknown:amb-1" }),
      new Date(NOW).toISOString(),
    );
  });

  it("skips sweeps while the runtime is paused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const isPaused = vi.fn(() => true);
    const h = makeHarness({
      policy: { intervalMs: 60 * 60_000 },
      runtimeControl: { isPaused },
    });

    await h.module.start();
    await h.bus.drain();

    expect(isPaused).toHaveBeenCalled();
    expect(h.reader.read).not.toHaveBeenCalled();
    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();
    expect(h.redeemLogRows).toEqual([]);
  });

  it("skips wallet-event-driven sweeps while paused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let paused = false;
    const isPaused = vi.fn(() => paused);
    const h = makeHarness({
      policy: { intervalMs: 60 * 60_000 },
      runtimeControl: { isPaused },
    });
    await runStableStartup(h);

    h.reader.read.mockClear();
    h.gateway.redeemPositions.mockClear();
    paused = true;

    await h.bus.publish("PolymarketWalletUpdated", {
      positions: [
        {
          tokenId: createTokenId(TOKEN),
          conditionId: CONDITION,
          size: 10,
          redeemable: true,
          slug: "market",
          outcome: "Yes",
        },
      ],
      timestamp: Date.now(),
    });
    await h.bus.drain();

    expect(h.reader.read).not.toHaveBeenCalled();
    expect(h.gateway.redeemPositions).not.toHaveBeenCalled();
  });

  it("defers scheduled retries while the runtime is paused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let paused = false;
    const isPaused = vi.fn(() => paused);
    const redeemImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("relayer down"))
      .mockResolvedValueOnce({
        status: "confirmed",
        conditionIds: [CONDITION],
        txHash: "0xretry",
        gasUsed: 111,
      });
    const h = makeHarness({
      policy: { intervalMs: 60 * 60_000 },
      redeemImpl,
      runtimeControl: { isPaused },
    });
    await runStableStartup(h);

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);
    paused = true;

    await vi.advanceTimersByTimeAsync(60_000);
    await h.bus.drain();
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await h.bus.drain();
    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(1);

    paused = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await h.bus.drain();

    expect(h.gateway.redeemPositions).toHaveBeenCalledTimes(2);
    expect(h.redeemLogRows.at(-1)).toMatchObject({ status: "success" });
  });

  it("defers scheduled verification while the runtime is paused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let paused = false;
    const isPaused = vi.fn(() => paused);
    const h = makeHarness({
      redeemImpl: vi.fn().mockResolvedValue({
        status: "pending",
        conditionIds: [CONDITION],
        txHash: "0xpending",
        gasUsed: null,
      }),
      policy: { intervalMs: 60 * 60_000, postRedeemVerifyDelayMs: 1_000 },
      runtimeControl: { isPaused },
    });
    await runStableStartup(h);
    expect(h.redeemLogRows.map((row) => row.status)).toEqual(["pending"]);

    paused = true;
    h.reader.read.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await h.bus.drain();
    expect(h.positionRepo.save).not.toHaveBeenCalled();
    expect(h.reader.read).not.toHaveBeenCalled();

    // Re-arm under pause uses PAUSE_DEFER_RECHECK_MS floor (30s) to prevent
    // tight-loop re-arming when the original delay is small.
    await vi.advanceTimersByTimeAsync(1_000);
    await h.bus.drain();
    expect(h.reader.read).not.toHaveBeenCalled();

    paused = false;
    h.reader.read.mockResolvedValueOnce([]);
    await vi.advanceTimersByTimeAsync(30_000);
    await h.bus.drain();

    expect(h.reader.read).toHaveBeenCalledTimes(1);
    expect(h.positionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ size: 0, status: "closed" }),
    );
  });

  it("does not hot-loop when startup-hydrated verification delay is 0 while paused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let paused = true;
    const isPaused = vi.fn(() => paused);
    const submittedRow = {
      id: 7,
      conditionId: CONDITION,
      tokenIds: [TOKEN],
      // attemptTs older than postRedeemVerifyDelayMs → computed delay = 0
      attemptTs: NOW - 60_000,
      status: "submitted",
      details: { excludedTokenIds: [] },
    };
    const h = makeHarness({
      policy: { intervalMs: 60 * 60_000, postRedeemVerifyDelayMs: 1_000 },
      redeemLogRows: [submittedRow],
      runtimeControl: { isPaused },
    });

    await h.module.start();
    await h.bus.drain();

    h.reader.read.mockClear();

    // Drain the immediate timer queue (delay=0). Pause gate should defer with
    // PAUSE_DEFER_RECHECK_MS floor instead of re-arming at 0ms (hot loop).
    await vi.advanceTimersByTimeAsync(0);
    await h.bus.drain();
    await vi.advanceTimersByTimeAsync(1_000);
    await h.bus.drain();

    // While paused, verifier must not run on-chain reads.
    expect(h.reader.read).not.toHaveBeenCalled();

    // Resume: next re-arm fires after the pause-defer recheck delay.
    paused = false;
    h.reader.read.mockResolvedValueOnce([]);
    await vi.advanceTimersByTimeAsync(30_000);
    await h.bus.drain();

    expect(h.reader.read).toHaveBeenCalledTimes(1);
  });

  it("defers orphan attempt marking while paused and runs it after resume", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let paused = true;
    const isPaused = vi.fn(() => paused);
    const orphanRow = {
      id: 99,
      conditionId: "cond-orphan",
      tokenIds: [TOKEN],
      attemptTs: NOW - 4 * 60 * 60_000,
      status: "attempting",
      details: null,
    };
    const h = makeHarness({
      policy: { intervalMs: 60 * 60_000 },
      redeemLogRows: [orphanRow],
      runtimeControl: { isPaused },
    });

    await h.module.start();
    await h.bus.drain();

    // While paused: the orphan row stays `attempting` because the sweep is
    // skipped before `markOrphanedActiveAttempts` runs. We assert state, not
    // mock invocations — those are an implementation detail of the deps.
    expect(orphanRow.status).toBe("attempting");

    paused = false;
    await (h.module as unknown as { runSweep(reason: string): Promise<void> }).runSweep(
      "after-resume",
    );
    await h.bus.drain();

    expect(orphanRow.status).toBe("failed_orphaned");
  });
});
