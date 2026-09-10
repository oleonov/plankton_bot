import { describe, expect, it, vi } from "vitest";
import {
  createBotRunId,
  createConditionId,
  createOrderId,
  createTokenId,
  type ExchangeOrder,
  type MakerCaptureRepriceIntent,
  type Order,
  type OrderBookSnapshot,
} from "@krabs/domain";
import {
  buildMakerCaptureRepriceIdentity,
  classifyMakerCaptureExactCancellation,
  computeMakerCaptureCandidate,
  findPermanentR23LineageBlocker,
  isMakerCaptureCancellationReason,
  isMakerCaptureBookAfterCancellation,
  isMakerCaptureExactCancellation,
  parseMakerCaptureRepriceSignal,
  primeFreshMakerCaptureBook,
  resolveMakerCaptureCancellationAnchorMs,
  resolvePermanentR23CapacityCarriers,
} from "../maker-capture-reprice.js";
import { DEFAULT_EXECUTION_POLICY } from "../execution-policy.js";

const TOKEN = createTokenId("tok-capture-reprice");
const CONDITION = createConditionId("cond-capture-reprice");
const ACTIVATION_ID = "permanent-r23-red";
const ACTIVATED_AT = "2026-08-28T09:16:57.368Z";
const NOW = Date.parse("2026-08-28T09:17:30.000Z");

function permanentPolicy() {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    makerEntry: {
      ...DEFAULT_EXECUTION_POLICY.makerEntry,
      mode: "micro_live" as const,
      permanentR23ActivationId: ACTIVATION_ID,
      permanentR23ActivatedAtUtc: ACTIVATED_AT,
      captureBookReprice: { enabled: true, maxRepricesPerRoot: 5 },
    },
  };
}

function captureOrder(overrides: Partial<Order> = {}): Order {
  const orderId = overrides.orderId ?? createOrderId("root-red");
  const createdAt = overrides.createdAt ?? new Date(NOW - 10_000).toISOString();
  return {
    orderId,
    clientOrderId: (overrides.clientOrderId ?? "client-root-red") as never,
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "buy",
    orderType: "GTC",
    postOnly: true,
    price: 0.3,
    size: 3,
    sizeUsdc: 0.9,
    status: "open",
    exchangeOrderId: "exchange-root-red",
    signalId: "signal-root-red",
    signalReason: "probe-entry",
    decisionRuleId: "R23_DIP_TRIGGER",
    signalTimestamp: createdAt,
    entryStyle: "maker",
    metadata: {
      makerMicroLiveLifecycle: {
        kind: "permanent_r23",
        activationId: ACTIVATION_ID,
        activatedAtUtc: ACTIVATED_AT,
        fillWaitMs: 120_000,
      },
      makerCaptureLineageV1: {
        version: 1,
        rootOrderId: orderId,
        predecessorOrderId: null,
        replacementIndex: 0,
        rootNotionalUsdc: 0.9,
      },
      quoteMotionV1: {
        version: 1,
        kind: "r23_capture",
        cohortId: ACTIVATED_AT,
        originalSuggestedPrice: 0.4,
        originalTargetPrice: null,
        entryPriceCeiling: 0.45,
        policySchemaVersion: DEFAULT_EXECUTION_POLICY.version,
        policyControlRevision: 7,
        permanentR23ActivationId: ACTIVATION_ID,
        permanentR23ActivatedAtUtc: ACTIVATED_AT,
        initialBook: {
          depthStatus: "full",
          bestBid: 0.29,
          bestAsk: 0.35,
          tickSize: 0.01,
          snapshotTs: NOW - 10_000,
          source: "test",
        },
      },
    },
    botRunId: createBotRunId("run-red"),
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function book(
  bids: Array<{ price: number; size: number }>,
  asks: Array<{ price: number; size: number }>,
  timestamp = 10_000,
): OrderBookSnapshot {
  return {
    tokenId: TOKEN,
    bids,
    asks,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    midPrice: null,
    spread: null,
    minOrderSize: 1,
    timestamp,
  };
}

function rootRepo(orders: Order[]) {
  const root = orders[0]!;
  return {
    findById: vi.fn(() => root),
    findByTokenId: vi.fn(() => orders),
    getMakerCaptureChainUsage: vi.fn(() => ({
      trusted: true,
      rootOrderId: root.orderId,
      rootNotionalUsdc: root.sizeUsdc,
      chainFilledUsdc: 0.2,
      predecessorRemainingShares: 2.3,
      replacementIndex: 0,
      orderIds: [root.orderId],
    })),
  };
}

function rootMetadata(group: string, changes: Record<string, unknown>): Partial<Order> {
  const metadata = captureOrder().metadata!;
  return { metadata: { ...metadata, [group]: { ...(metadata[group] as object), ...changes } } };
}

describe("permanent root lookup cost", () => {
  it.each<[string, Partial<Order>, number]>([
    ["missing metadata", { metadata: null }, NOW],
    ["non R23", { decisionRuleId: "R_OTHER" }, NOW],
    ["sell", { side: "sell" }, NOW],
    ["non maker", { entryStyle: "probe" }, NOW],
    ["not post only", { postOnly: false }, NOW],
    ["invalid timestamp", { createdAt: "invalid" }, NOW],
    ["expired at boundary", {}, NOW + 110_000],
    ["expired after boundary", {}, NOW + 110_001],
    ["stale signal", { signalTimestamp: "2026-08-01T00:00:00.000Z" }, NOW],
    ["wrong origin", rootMetadata("quoteMotionV1", { kind: "bounce_exit_target" }), NOW],
    ["old schema", rootMetadata("quoteMotionV1", { policySchemaVersion: 999 }), NOW],
    ["old cohort", rootMetadata("quoteMotionV1", { cohortId: "old" }), NOW],
    ["old activation", rootMetadata("quoteMotionV1", { permanentR23ActivationId: "old" }), NOW],
    [
      "old activation time",
      rootMetadata("quoteMotionV1", { permanentR23ActivatedAtUtc: "old" }),
      NOW,
    ],
    ["wrong lifecycle", rootMetadata("makerMicroLiveLifecycle", { kind: "r23_capture" }), NOW],
    [
      "old lifecycle activation",
      rootMetadata("makerMicroLiveLifecycle", { activationId: "old" }),
      NOW,
    ],
    ["old lifecycle time", rootMetadata("makerMicroLiveLifecycle", { activatedAtUtc: "old" }), NOW],
    [
      "child lineage",
      rootMetadata("makerCaptureLineageV1", { replacementIndex: 1, predecessorOrderId: "parent" }),
      NOW,
    ],
    ["foreign root", rootMetadata("makerCaptureLineageV1", { rootOrderId: "foreign" }), NOW],
    ["wrong notional", { sizeUsdc: 1 }, NOW],
  ])("skips chain reads for %s", (_name, overrides, nowMs) => {
    const orderRepo = rootRepo([captureOrder(overrides)]);
    expect(
      findPermanentR23LineageBlocker({
        tokenId: TOKEN,
        policy: permanentPolicy(),
        orderRepo,
        nowMs,
      }),
    ).toBeNull();
    expect(orderRepo.getMakerCaptureChainUsage).not.toHaveBeenCalled();
  });

  it.each([
    { trusted: false },
    { rootOrderId: createOrderId("foreign") },
    { replacementIndex: 1 },
    { rootNotionalUsdc: 1 },
  ])("rejects inconsistent chain usage %j", (overrides) => {
    const orderRepo = rootRepo([captureOrder()]);
    orderRepo.getMakerCaptureChainUsage.mockReturnValue({
      ...orderRepo.getMakerCaptureChainUsage(),
      ...overrides,
    });
    orderRepo.getMakerCaptureChainUsage.mockClear();
    expect(
      findPermanentR23LineageBlocker({
        tokenId: TOKEN,
        policy: permanentPolicy(),
        orderRepo,
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(orderRepo.getMakerCaptureChainUsage).toHaveBeenCalledTimes(1);
  });

  it("keeps a cancelled root with a working child and observes later fills and policy changes", () => {
    const root = captureOrder({ status: "cancelled", cancelReason: "operator_cancelled" });
    const child = captureOrder({
      ...rootMetadata("makerCaptureLineageV1", {
        replacementIndex: 1,
        predecessorOrderId: root.orderId,
      }),
      orderId: createOrderId("child"),
    });
    const history = Array.from({ length: 100 }, (_, i) =>
      captureOrder({ orderId: createOrderId(`old-${i}`), metadata: null }),
    );
    const orderRepo = rootRepo([root]);
    orderRepo.findByTokenId.mockReturnValue([...history, child, root]);
    const input = { tokenId: TOKEN, policy: permanentPolicy(), orderRepo, nowMs: NOW + 109_999 };
    expect(findPermanentR23LineageBlocker(input)).toEqual({
      rootOrderId: root.orderId,
      tokenId: TOKEN,
      conditionId: CONDITION,
      deadlineMs: NOW + 110_000,
      residualNotionalUsdc: 0.7,
    });
    expect(orderRepo.getMakerCaptureChainUsage).toHaveBeenCalledTimes(1);
    orderRepo.getMakerCaptureChainUsage.mockReturnValue({
      trusted: true,
      rootOrderId: root.orderId,
      rootNotionalUsdc: 0.9,
      chainFilledUsdc: 0.6,
      predecessorRemainingShares: 1,
      replacementIndex: 0,
      orderIds: [root.orderId, child.orderId],
    });
    expect(findPermanentR23LineageBlocker(input)?.residualNotionalUsdc).toBeCloseTo(0.3);
    expect(orderRepo.getMakerCaptureChainUsage).toHaveBeenCalledTimes(2);
    input.policy.makerEntry.permanentR23ActivationId = "new-activation";
    expect(findPermanentR23LineageBlocker(input)).toBeNull();
    expect(orderRepo.getMakerCaptureChainUsage).toHaveBeenCalledTimes(2);
  });
});

describe("maker capture reprice helper", () => {
  it("classifies permanent exact-cancel convergence without conflating retryable state and drift", () => {
    const predecessor = captureOrder({
      status: "cancelled",
      cancelReason: "maker_capture_reprice",
      cancelAgeMs: 2_000,
    });
    const exact: ExchangeOrder = {
      orderId: predecessor.exchangeOrderId!,
      clientOrderId: String(predecessor.clientOrderId),
      tokenId: predecessor.tokenId,
      side: "buy",
      price: predecessor.price,
      sizeTotal: predecessor.size,
      sizeFilled: 0.7,
      sizeRemaining: 2.3,
      status: "OPEN",
      createdAt: Date.parse(predecessor.createdAt),
    };

    expect(resolveMakerCaptureCancellationAnchorMs(predecessor)).toBe(
      Date.parse(predecessor.createdAt) + 2_000,
    );
    expect(classifyMakerCaptureExactCancellation(predecessor, 2.3, null)).toEqual({
      kind: "retryable",
      reason: "unavailable",
    });
    expect(classifyMakerCaptureExactCancellation(predecessor, 2.3, exact)).toEqual({
      kind: "retryable",
      reason: "still-working",
    });
    expect(
      classifyMakerCaptureExactCancellation(predecessor, 2.3, {
        ...exact,
        status: "CANCELLED",
      }),
    ).toEqual({ kind: "proven" });
    expect(
      classifyMakerCaptureExactCancellation(predecessor, 2.3, {
        ...exact,
        sizeRemaining: 2.2,
      }),
    ).toEqual({ kind: "conflict", reason: "identity-or-parity-drift" });
    expect(
      resolveMakerCaptureCancellationAnchorMs({ ...predecessor, cancelAgeMs: null }),
    ).toBeNull();
  });

  it.each([
    ["unchanged policy", permanentPolicy()],
    [
      "same activation after unrelated maker-policy revision and current ceiling change",
      {
        ...permanentPolicy(),
        entryPriceCeiling: 0.5,
        makerEntry: { ...permanentPolicy().makerEntry, bidImproveTicks: 2 },
      },
    ],
  ])("keeps one trusted current-activation root blocked under %s", (_case, policy) => {
    const root = captureOrder({
      status: "cancelled",
      cancelReason: "maker_capture_reprice",
      cancelAgeMs: 1_000,
    });
    const identity = buildMakerCaptureRepriceIdentity(root.orderId, root.orderId, 1);
    const intent: MakerCaptureRepriceIntent = {
      intentId: identity.intentId,
      predecessorOrderId: root.orderId,
      lifecycleSignalId: identity.lifecycleSignalId,
      rootOrderId: root.orderId,
      tokenId: root.tokenId,
      conditionId: root.conditionId,
      replacementIndex: 1,
      status: "cancel_pending",
      candidatePrice: null,
      replacementSize: null,
      childOrderId: null,
      createdAt: new Date(NOW - 1_000).toISOString(),
      updatedAt: new Date(NOW - 1_000).toISOString(),
      failure: null,
      proof: {
        version: 1,
        trigger: {
          eventTimestampMs: NOW - 1_000,
          evaluatedAtMs: NOW - 1_000,
          bestBid: 0.31,
          bestAsk: 0.35,
          tickSize: 0.01,
          bookSource: "clob",
          policySchemaVersion: DEFAULT_EXECUTION_POLICY.version,
          policyControlRevision: 7,
          activatedAtUtc: ACTIVATED_AT,
          expiresAtUtc: new Date(NOW + 110_000).toISOString(),
          originalSuggestedPrice: 0.4,
          entryPriceCeiling: 0.45,
          rootNotionalUsdc: 0.9,
          chainFilledUsdc: 0.2,
          predecessorRemainingShares: 2.3,
        },
        prepared: null,
        submit: null,
      },
    };
    const orderRepo = {
      findByTokenId: vi.fn(() => [root]),
      findById: vi.fn(() => root),
      findRecoverableMakerCaptureRepriceIntents: vi.fn(() => [intent]),
      findMakerCaptureRepriceIntentByPredecessor: vi.fn(() => intent),
      findMakerCaptureRepriceIntentBySignal: vi.fn(() => intent),
      getMakerCaptureChainUsage: vi.fn(() => ({
        trusted: true,
        rootOrderId: root.orderId,
        rootNotionalUsdc: 0.9,
        chainFilledUsdc: 0.2,
        predecessorRemainingShares: 2.3,
        replacementIndex: 0,
        orderIds: [root.orderId],
      })),
    };

    expect(
      findPermanentR23LineageBlocker({
        tokenId: TOKEN,
        policy,
        orderRepo,
        nowMs: NOW,
      }),
    ).toMatchObject({ rootOrderId: root.orderId, residualNotionalUsdc: 0.7 });
    expect(
      resolvePermanentR23CapacityCarriers({
        policy,
        orderRepo,
        pendingReservations: [],
        nowMs: NOW,
      }),
    ).toEqual([
      expect.objectContaining({
        rootOrderId: root.orderId,
        tokenId: TOKEN,
        notionalUsdc: 0.7,
        kind: "virtual-cancelled-gap",
      }),
    ]);

    expect(
      resolvePermanentR23CapacityCarriers({
        policy: {
          ...policy,
          makerEntry: { ...policy.makerEntry, permanentR23ActivationId: "new" },
        },
        orderRepo,
        pendingReservations: [],
        nowMs: NOW,
      }),
    ).toEqual([]);
    vi.mocked(orderRepo.findRecoverableMakerCaptureRepriceIntents).mockReturnValue([
      { ...intent, status: "failed" },
    ]);
    expect(
      resolvePermanentR23CapacityCarriers({
        policy,
        orderRepo,
        pendingReservations: [],
        nowMs: NOW,
      }),
    ).toEqual([]);
  });
  it("accepts only capture-owned exact cancellations", () => {
    const predecessor = {
      exchangeOrderId: "exchange-predecessor",
      tokenId: TOKEN,
      side: "buy" as const,
      price: 0.3,
      size: 3,
      status: "cancelled" as const,
      cancelReason: "maker_capture_reprice",
    };
    const exact: ExchangeOrder = {
      orderId: predecessor.exchangeOrderId,
      clientOrderId: null,
      tokenId: TOKEN,
      side: "buy",
      price: 0.3,
      sizeTotal: 3,
      sizeFilled: 0.7,
      sizeRemaining: 2.3,
      status: "CANCELLED",
      createdAt: 1,
    };

    expect(isMakerCaptureCancellationReason("maker_capture_reprice")).toBe(true);
    expect(isMakerCaptureCancellationReason("exchange-exact-cancelled")).toBe(true);
    expect(isMakerCaptureCancellationReason("operator_cancelled")).toBe(false);
    expect(isMakerCaptureExactCancellation(predecessor, 2.3, exact)).toBe(true);
    expect(
      isMakerCaptureExactCancellation(
        { ...predecessor, cancelReason: "operator_cancelled" },
        2.3,
        exact,
      ),
    ).toBe(false);
    for (const status of ["OPEN", "PARTIALLY_FILLED", "EXPIRED", "REJECTED"] as const) {
      expect(isMakerCaptureExactCancellation(predecessor, 2.3, { ...exact, status })).toBe(false);
    }
    expect(
      isMakerCaptureExactCancellation(predecessor, 2.3, { ...exact, orderId: "foreign" }),
    ).toBe(false);
    expect(isMakerCaptureExactCancellation(predecessor, 2.3, { ...exact, sizeFilled: 0.6 })).toBe(
      false,
    );
    expect(isMakerCaptureExactCancellation(predecessor, 2.3, null)).toBe(false);
  });

  it("derives stable identities from the exact root hop", () => {
    const root = createOrderId("root");
    const predecessor = createOrderId("predecessor");
    const first = buildMakerCaptureRepriceIdentity(root, predecessor, 1);

    expect(buildMakerCaptureRepriceIdentity(root, predecessor, 1)).toEqual(first);
    expect(buildMakerCaptureRepriceIdentity(root, predecessor, 2)).not.toEqual(first);
    expect(first.lifecycleSignalId).toContain(":1:");
  });

  it("parses only the exact bounded signal shape", () => {
    const valid = {
      version: 1,
      intentId: "intent",
      rootOrderId: createOrderId("root"),
      predecessorOrderId: createOrderId("pred"),
      replacementIndex: 5,
    };
    expect(parseMakerCaptureRepriceSignal(valid)).toEqual(valid);
    expect(parseMakerCaptureRepriceSignal({ ...valid, replacementIndex: 6 })).toBeNull();
    expect(parseMakerCaptureRepriceSignal({ ...valid, extra: true })).toBeNull();
  });

  it("subtracts the cancelled predecessor and requires a full-tick upward move", () => {
    const held = computeMakerCaptureCandidate({
      book: book(
        [
          { price: 0.3, size: 5 },
          { price: 0.29, size: 20 },
        ],
        [{ price: 0.35, size: 20 }],
      ),
      tickSize: 0.01,
      predecessorPrice: 0.3,
      predecessorVisibleShares: 5,
      originalSuggestedPrice: 0.4,
      entryPriceCeiling: 0.45,
    });
    const moved = computeMakerCaptureCandidate({
      book: book(
        [
          { price: 0.31, size: 20 },
          { price: 0.3, size: 5 },
        ],
        [{ price: 0.34, size: 20 }],
      ),
      tickSize: 0.01,
      predecessorPrice: 0.3,
      predecessorVisibleShares: 5,
      originalSuggestedPrice: 0.4,
      entryPriceCeiling: 0.45,
    });

    expect(held).toEqual({ ok: false, reason: "no-valid-move" });
    expect(moved).toMatchObject({ ok: true, price: 0.32, bestBid: 0.31, bestAsk: 0.34 });
  });

  it("keeps working-order ambiguity fail-closed", () => {
    expect(
      computeMakerCaptureCandidate({
        book: book(
          [
            { price: 0.31, size: 20 },
            { price: 0.3, size: 1 },
          ],
          [{ price: 0.34, size: 20 }],
        ),
        tickSize: 0.01,
        predecessorPrice: 0.3,
        predecessorVisibleShares: 2.3,
        originalSuggestedPrice: 0.4,
        entryPriceCeiling: 0.45,
      }),
    ).toEqual({ ok: false, reason: "self-book-ambiguous" });
  });

  it("accepts only a REST observation captured after durable cancellation", () => {
    expect(
      isMakerCaptureBookAfterCancellation({ snapshotTs: 999, sourcePolledAtMs: 1_001 }, 1_000),
    ).toBe(false);
    expect(
      isMakerCaptureBookAfterCancellation({ snapshotTs: 1_000, sourcePolledAtMs: 1_000 }, 1_000),
    ).toBe(true);
  });

  it("fails closed for missing or stale REST books", async () => {
    const entry = {
      tokenId: String(TOKEN),
      snapshotTs: 10_000,
      cachedAtMs: 10_000,
      sourcePolledAtMs: 10_000,
      bookSource: "clob" as const,
      sourceKind: "rest" as const,
      book: book([{ price: 0.3, size: 10 }], [{ price: 0.4, size: 10 }]),
    };
    const cache = { prime: vi.fn().mockResolvedValue(new Map([[String(TOKEN), entry]])) };

    await expect(primeFreshMakerCaptureBook(cache, String(TOKEN), 10_000)).resolves.toEqual(entry);
    await expect(primeFreshMakerCaptureBook(cache, String(TOKEN), 13_001)).resolves.toBeNull();
    await expect(
      primeFreshMakerCaptureBook(
        { prime: vi.fn().mockResolvedValue(new Map()) },
        String(TOKEN),
        10_000,
      ),
    ).resolves.toBeNull();
  });
});
