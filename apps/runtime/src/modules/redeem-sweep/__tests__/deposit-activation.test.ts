import { afterEach, describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@krabs/event-bus";
import { createConditionId, createPositionId, createTokenId, type Position } from "@krabs/domain";
import { RedeemSweepModule } from "../redeem-sweep-module.js";
import { DEFAULT_EXECUTION_POLICY } from "../../../execution-policy.js";

const NOW = Date.parse("2026-05-13T00:00:00.000Z");
const TOKEN = "tok-da-1";
const CONDITION = "cond-da-1";

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger(),
  } as any;
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

function remotePosition(redeemable = true) {
  return {
    tokenId: TOKEN,
    conditionId: CONDITION,
    size: 10,
    currentValueUsdc: 1,
    initialValueUsdc: 1,
    redeemable,
    slug: "market",
    marketSlug: "market",
    outcome: "Yes",
    raw: {},
  };
}

function makeRedeemLogRepo() {
  const rows: any[] = [];
  return {
    insert: vi.fn((row) => rows.push({ id: rows.length + 1, ...row })),
    updateLatestActiveAttempt: vi.fn((entry) => {
      const row = rows
        .filter(
          (r) =>
            r.conditionId === entry.conditionId &&
            (r.status === "attempting" || r.status === "submitted" || r.status === "pending"),
        )
        .sort((a, b) => b.attemptTs - a.attemptTs || b.id - a.id)[0];
      if (!row) return false;
      Object.assign(row, entry);
      return true;
    }),
    findRecentActiveAttempts: vi.fn(() => []),
    hasRecentActiveAttempt: vi.fn(() => false),
    findLatestAttemptTs: vi.fn(() => null),
    markOrphanedActiveAttempts: vi.fn(() => []),
  };
}

function makeHarness(opts: {
  activationEnabled?: boolean;
  minAmountUsdcCents?: number;
  activationImpl?: () => Promise<any>;
  redeemable?: boolean;
  now?: () => number;
  riskEventRepo?: { insert: ReturnType<typeof vi.fn> };
}) {
  const bus = new InProcessEventBus();
  const activateFn = vi.fn(
    opts.activationImpl ??
      (() =>
        Promise.resolve({
          status: "submitted",
          perAsset: [],
          txHash: "0xactivate",
          gasUsed: 5000,
        })),
  );
  const gateway = {
    redeemPositions: vi.fn(() =>
      Promise.resolve({
        status: "confirmed",
        conditionIds: [CONDITION],
        txHash: "0xredeem",
        gasUsed: 12345,
      }),
    ),
    activatePendingUsdcCollateral: activateFn,
  };
  const position = localPosition();
  const redeemLogRepo = makeRedeemLogRepo();
  const riskEventRepo = opts.riskEventRepo ?? { insert: vi.fn() };
  const nowFn = opts.now ?? (() => NOW);

  const module = new RedeemSweepModule({
    bus,
    gateway: gateway as any,
    positionReader: {
      read: vi.fn(() =>
        Promise.resolve([remotePosition(opts.redeemable !== false)]),
      ),
    },
    positionRepo: {
      findByTokenId: vi.fn((tokenId) => (String(tokenId) === TOKEN ? position : null)),
      save: vi.fn(),
    } as any,
    lotRepo: { settleAll: vi.fn() } as any,
    marketRepo: {
      findByConditionId: vi.fn(() => [{ tokenId: createTokenId(TOKEN) }]),
    } as any,
    orderRepo: { findOpen: vi.fn(() => []) } as any,
    redeemLogRepo: redeemLogRepo as any,
    policy: () => ({
      ...DEFAULT_EXECUTION_POLICY.redeemSweep,
      enabled: true,
      intervalMs: 60_000,
      inFlightTtlMs: 15 * 60_000,
      retryBackoffMs: [60_000],
    }),
    depositActivationPolicy: () => ({
      enabled: opts.activationEnabled !== false,
      minAmountUsdcCents: opts.minAmountUsdcCents ?? 100,
    }),
    riskEventRepo: riskEventRepo as any,
    log: logger(),
    runtimeMetrics: { writeEvent: vi.fn(), writeLatest: vi.fn() } as any,
    now: nowFn,
  });

  return { module, gateway, activateFn, riskEventRepo };
}

// Run two sweeps to satisfy the stability-snapshot requirement (STABILITY_SNAPSHOTS_REQUIRED=2).
// The first sweep sees count=1 (not yet stable), the second sees count=2 and proceeds to redeem.
async function runSweepPair(module: RedeemSweepModule): Promise<void> {
  await (module as any).doSweep("test-prime");
  await (module as any).doSweep("test");
}

describe("deposit activation — post-redeem trigger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls activatePendingUsdcCollateral once after a successful redeem batch", async () => {
    const { module, activateFn } = makeHarness({});
    await module.start();
    await runSweepPair(module);
    await module.stop();
    expect(activateFn).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callArg = (activateFn.mock.calls as any)[0][0] as { minAmountWei: bigint };
    // 100 cents × 10_000 = 1_000_000n raw
    expect(callArg.minAmountWei).toBe(1_000_000n);
  });

  it("does NOT call activatePendingUsdcCollateral when depositActivation.enabled=false", async () => {
    const { module, activateFn } = makeHarness({ activationEnabled: false });
    await module.start();
    await runSweepPair(module);
    await module.stop();
    expect(activateFn).not.toHaveBeenCalled();
  });

  it("records a risk_event with eventType=deposit-activation on success", async () => {
    const riskEventRepo = { insert: vi.fn() };
    const { module } = makeHarness({ riskEventRepo });
    await module.start();
    await runSweepPair(module);
    await module.stop();
    expect(riskEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "deposit-activation" }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = (riskEventRepo.insert.mock.calls as any)[0][0].payload as Record<string, unknown>;
    expect(payload.status).toBe("submitted");
    expect(payload.error).toBeNull();
  });

  it("records a risk_event with severity indicator on gateway throw, does NOT abort sweep cycle", async () => {
    const riskEventRepo = { insert: vi.fn() };
    const { module } = makeHarness({
      activationImpl: () => Promise.reject(new Error("rpc timeout")),
      riskEventRepo,
    });
    await module.start();
    // prime stability, then trigger redeem on second sweep — activation will throw
    await expect(runSweepPair(module)).resolves.not.toThrow();
    await module.stop();
    expect(riskEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "deposit-activation" }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = (riskEventRepo.insert.mock.calls as any)[0][0].payload as Record<string, unknown>;
    expect(payload.status).toBe("error");
    expect(String(payload.error)).toContain("rpc timeout");
  });
});

describe("deposit activation — periodic safety-net", () => {
  it("fires when redeemableCount=0 and lastActivationAttemptAt is >1h ago (zero = never run)", async () => {
    // Position is not redeemable → redeemableCount=0
    const { module, activateFn } = makeHarness({ redeemable: false, now: () => NOW });
    await module.start();
    await module.stop();
    // The periodic safety-net: NOW - 0 >= 1h (0 is the default lastActivationAttemptAt)
    expect(activateFn).toHaveBeenCalledOnce();
  });

  it("does NOT fire when lastActivationAttemptAt is within 1h", async () => {
    let tick = NOW;
    const { module, activateFn } = makeHarness({
      redeemable: false,
      now: () => tick,
    });
    await module.start();
    // First sweep fires activation (sets lastActivationAttemptAt = NOW)
    expect(activateFn).toHaveBeenCalledOnce();
    activateFn.mockClear();
    // Advance time by 30 minutes (< 1h)
    tick = NOW + 30 * 60_000;
    // Force a second sweep
    (module as any).isSweepRunning = false;
    await (module as any).doSweep("test");
    expect(activateFn).not.toHaveBeenCalled();
    await module.stop();
  });

  it("fires again when 1h has elapsed since last activation", async () => {
    let tick = NOW;
    const { module, activateFn } = makeHarness({
      redeemable: false,
      now: () => tick,
    });
    await module.start();
    expect(activateFn).toHaveBeenCalledOnce();
    activateFn.mockClear();
    // Advance by 61 minutes
    tick = NOW + 61 * 60_000;
    (module as any).isSweepRunning = false;
    await (module as any).doSweep("test");
    expect(activateFn).toHaveBeenCalledOnce();
    await module.stop();
  });
});
