import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteOrderRepository } from "../repositories/order-repository.js";
import {
  createOrderId,
  createTokenId,
  createConditionId,
  createPositionId,
  createBotRunId,
} from "@krabs/domain";
import type {
  Order,
  ClientOrderId,
  MakerCaptureBookDecisionProofV1,
  MakerCaptureRepriceIntent,
  BounceAskCaptureBookDecisionProofV1,
  BounceAskCaptureIntent,
  BounceAskCaptureSubmitProofV1,
} from "@krabs/domain";

const triggerProof = {
  eventTimestampMs: 1,
  evaluatedAtMs: 1,
  bestBid: 0.1,
  bestAsk: 0.2,
  tickSize: 0.01,
  bookSource: "clob" as const,
  policySchemaVersion: 1,
  policyControlRevision: 7,
  activatedAtUtc: "2026-08-20T10:00:00.000Z",
  expiresAtUtc: "2026-08-21T10:00:00.000Z",
  originalSuggestedPrice: 0.2,
  entryPriceCeiling: 0.2,
  rootNotionalUsdc: 1,
  chainFilledUsdc: 0,
  predecessorRemainingShares: 10,
};

function bookProof(overrides: Partial<MakerCaptureBookDecisionProofV1> = {}) {
  return {
    evaluatedAtMs: 2,
    snapshotTs: 2,
    cachedAtMs: 2,
    sourcePolledAtMs: 2,
    sourceKind: "rest" as const,
    bookSource: "clob" as const,
    tickSize: 0.01,
    predecessorPrice: 0.1,
    predecessorRemainingShares: 10,
    predecessorLevelBookShares: 12,
    predecessorSharesSubtracted: 10,
    predecessorLevelExternalShares: 2,
    externalBestBid: 0.1,
    externalBestAsk: 0.2,
    originalSuggestedPrice: 0.2,
    entryPriceCeiling: 0.2,
    rootNotionalUsdc: 1,
    chainFilledUsdc: 0,
    rootRemainingUsdc: 1,
    candidatePrice: 0.11,
    replacementSize: 8,
    minOrderSize: 1,
    policySchemaVersion: 1,
    policyControlRevision: 7,
    activatedAtUtc: triggerProof.activatedAtUtc,
    expiresAtUtc: triggerProof.expiresAtUtc,
    ...overrides,
  } satisfies MakerCaptureBookDecisionProofV1;
}

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteOrderRepository;

function makeOrder(overrides?: Partial<Order>): Order {
  const now = new Date().toISOString();
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "cloid-1" as ClientOrderId,
    tokenId: createTokenId("tok-1"),
    conditionId: createConditionId("cond-1"),
    side: "buy",
    orderType: "GTC",
    price: 0.55,
    size: 100,
    sizeUsdc: 55,
    status: "pending",
    exchangeOrderId: null,
    signalId: null,
    signalReason: null,
    botRunId: createBotRunId("run-1"),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeIntent(overrides: Partial<MakerCaptureRepriceIntent> = {}): MakerCaptureRepriceIntent {
  const now = "2026-08-20T10:05:00.000Z";
  return {
    intentId: "capture-intent-1",
    predecessorOrderId: createOrderId("capture-root"),
    lifecycleSignalId: "capture-reprice-signal-1",
    rootOrderId: createOrderId("capture-root"),
    tokenId: createTokenId("tok-1"),
    conditionId: createConditionId("cond-1"),
    replacementIndex: 1,
    status: "cancel_pending",
    candidatePrice: null,
    replacementSize: null,
    childOrderId: null,
    failure: null,
    proof: { version: 1, trigger: triggerProof, prepared: null, submit: null },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const bounceAskTriggerProof = {
  eventTimestampMs: 1,
  evaluatedAtMs: 2,
  policySchemaVersion: 1,
  policyControlRevision: 7,
  sourceCohortActivatedAtUtc: "2026-08-20T10:00:00.000Z",
  originalTargetPrice: 0.25,
  candidatePrice: 0.19,
  externalBestBid: 0.1,
  externalBestAsk: 0.2,
  tickSize: 0.01,
  positionResidualShares: 10,
  sourceBuyRootOrderIds: [createOrderId("source-buy-root")],
};

function bounceAskPreparedProof(
  overrides: Partial<BounceAskCaptureBookDecisionProofV1> = {},
): BounceAskCaptureBookDecisionProofV1 {
  return {
    ...bounceAskTriggerProof,
    snapshotTs: 3,
    cachedAtMs: 4,
    sourcePolledAtMs: 5,
    minOrderSize: 5,
    replacementSize: 8,
    ...overrides,
  };
}

function bounceAskSubmitProof(
  overrides: Partial<BounceAskCaptureSubmitProofV1> = {},
): BounceAskCaptureSubmitProofV1 {
  return {
    ...bounceAskPreparedProof(),
    childOrderId: "bounce-ask-child",
    clientOrderId: "bounce-ask-child-client",
    authoritativeStateCapturedAtMs: 6,
    authoritativeOpenOrderCount: 1,
    authoritativeFilledShares: 2,
    authoritativeWalletShares: 10,
    authoritativeStateHash: "sha256:authoritative-state",
    ...overrides,
  };
}

function makeBounceAskIntent(
  overrides: Partial<BounceAskCaptureIntent> = {},
): BounceAskCaptureIntent {
  const now = "2026-08-20T10:05:00.000Z";
  return {
    intentId: "bounce-ask-intent-1",
    predecessorOrderId: createOrderId("bounce-ask-root"),
    lifecycleSignalId: "bounce-ask-reprice-signal-1",
    rootOrderId: createOrderId("bounce-ask-root"),
    positionId: createPositionId("bounce-position-1"),
    tokenId: createTokenId("tok-1"),
    conditionId: createConditionId("cond-1"),
    replacementIndex: 1,
    status: "cancel_pending",
    candidatePrice: null,
    replacementSize: null,
    childOrderId: null,
    failure: null,
    proof: { version: 1, trigger: bounceAskTriggerProof, prepared: null, submit: null },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteOrderRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteOrderRepository", () => {
  it("save + findById round-trip", () => {
    const order = makeOrder();
    repo.save(order);

    const found = repo.findById(createOrderId("ord-1"));
    expect(found).not.toBeNull();
    expect(found!.orderId).toBe("ord-1");
    expect(found!.clientOrderId).toBe("cloid-1");
    expect(found!.tokenId).toBe("tok-1");
    expect(found!.side).toBe("buy");
    expect(found!.orderType).toBe("GTC");
    expect(found!.postOnly).toBe(false);
    expect(found!.price).toBe(0.55);
    expect(found!.size).toBe(100);
    expect(found!.sizeUsdc).toBe(55);
    expect(found!.status).toBe("pending");
    expect(found!.exchangeOrderId).toBeNull();
    expect(found!.signalId).toBeNull();
    expect(found!.botRunId).toBe("run-1");
  });

  it("round-trips signal and exchange reject telemetry", () => {
    repo.save(
      makeOrder({
        status: "rejected",
        signalId: "sig-1",
        decisionRuleId: "D5",
        signalTimestamp: "2026-04-26T00:00:00.000Z",
        exchangeErrorCode: "INSUFFICIENT_BALANCE",
        exchangeErrorMessage: "not enough balance",
        exchangeErrorPayload: JSON.stringify({ status: 400, responseBody: { error: "bad" } }),
        exchangeRejectionReason: "rejection_balance_insufficient",
      }),
    );

    const found = repo.findById(createOrderId("ord-1"));
    expect(found).toMatchObject({
      status: "rejected",
      signalId: "sig-1",
      decisionRuleId: "D5",
      signalTimestamp: "2026-04-26T00:00:00.000Z",
      exchangeErrorCode: "INSUFFICIENT_BALANCE",
      exchangeErrorMessage: "not enough balance",
      exchangeRejectionReason: "rejection_balance_insufficient",
    });
    expect(JSON.parse(found!.exchangeErrorPayload!)).toMatchObject({
      status: 400,
      responseBody: { error: "bad" },
    });
  });

  it("round-trips order metadata_json for S1 ladder tier recovery", () => {
    repo.save(
      makeOrder({
        status: "open",
        side: "sell",
        decisionRuleId: "S1_LADDER",
        metadata: {
          s1: {
            ladderId: "ladder-1",
            tierIndex: 2,
            tierCount: 4,
            targetPrice: 0.075,
          },
        },
      }),
    );

    const found = repo.findById(createOrderId("ord-1"));

    expect(found?.metadata).toEqual({
      s1: {
        ladderId: "ladder-1",
        tierIndex: 2,
        tierCount: 4,
        targetPrice: 0.075,
      },
    });
  });

  it("atomically replaces a rejected identity with a pending prepared identity", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("hash-first"),
        clientOrderId: "stable-client" as ClientOrderId,
        status: "rejected",
        exchangeOrderId: "hash-first",
        exchangeErrorCode: "INVALID_TICK",
        exchangeErrorMessage: "bad tick",
      }),
    );
    const replacement = makeOrder({
      orderId: createOrderId("hash-second"),
      clientOrderId: "stable-client" as ClientOrderId,
      status: "pending",
      exchangeOrderId: "hash-second",
      price: 0.56,
      size: 99,
      sizeUsdc: 55.44,
    });

    repo.replacePendingIdentity(createOrderId("hash-first"), replacement);

    expect(repo.findById(createOrderId("hash-first"))).toBeNull();
    expect(repo.findById(createOrderId("hash-second"))).toMatchObject({
      status: "pending",
      exchangeOrderId: "hash-second",
      price: 0.56,
      size: 99,
      exchangeErrorCode: null,
      exchangeErrorMessage: null,
    });
  });

  it("replaces only pending or rejected unfilled orders with a stable client identity", () => {
    repo.save(makeOrder());
    repo.replacePendingIdentity(
      createOrderId("ord-1"),
      makeOrder({ orderId: createOrderId("ord-2"), exchangeOrderId: "ord-2" }),
    );
    expect(repo.findById(createOrderId("ord-1"))).toBeNull();
    expect(repo.findById(createOrderId("ord-2"))).toMatchObject({ status: "pending" });

    repo.updateStatus(createOrderId("ord-2"), "open");
    expect(() =>
      repo.replacePendingIdentity(
        createOrderId("ord-2"),
        makeOrder({ orderId: createOrderId("ord-3") }),
      ),
    ).toThrow("requires pending/rejected order");

    repo.save(
      makeOrder({
        orderId: createOrderId("client-source"),
        clientOrderId: "client-stable" as ClientOrderId,
      }),
    );
    expect(() =>
      repo.replacePendingIdentity(
        createOrderId("client-source"),
        makeOrder({
          orderId: createOrderId("client-target"),
          clientOrderId: "different-client" as ClientOrderId,
        }),
      ),
    ).toThrow("cannot change client order identity");

    repo.save(
      makeOrder({
        orderId: createOrderId("filled-source"),
        clientOrderId: "filled-stable" as ClientOrderId,
        status: "rejected",
      }),
    );
    conn.db
      .prepare(
        `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc)
         VALUES ('filled-source-fill', 'filled-source', 'tok-1', 'cond-1', 'buy', 0.55, 1, 0.55)`,
      )
      .run();
    expect(() =>
      repo.replacePendingIdentity(
        createOrderId("filled-source"),
        makeOrder({
          orderId: createOrderId("filled-target"),
          clientOrderId: "filled-stable" as ClientOrderId,
        }),
      ),
    ).toThrow("refused for filled order");
  });

  it("CAS-rearms only the exact unfilled cancelled recovery identity", () => {
    const metadata = { exitRecoveryChildV1: { version: 1, predecessorOrderId: "predecessor" } };
    repo.save(
      makeOrder({
        orderId: createOrderId("cancelled-recovery"),
        clientOrderId: "recovery-stable" as ClientOrderId,
        status: "cancelled",
        metadata,
      }),
    );
    const replacement = makeOrder({
      orderId: createOrderId("rearmed-recovery"),
      clientOrderId: "recovery-stable" as ClientOrderId,
      exchangeOrderId: "rearmed-recovery",
    });
    expect(() =>
      repo.replaceCancelledRecoveryIdentity(createOrderId("cancelled-recovery"), replacement, {
        exitRecoveryChildV1: { version: 1, predecessorOrderId: "drift" },
      }),
    ).toThrow("metadata CAS failed");

    repo.replaceCancelledRecoveryIdentity(
      createOrderId("cancelled-recovery"),
      replacement,
      metadata,
    );
    expect(repo.findById(createOrderId("cancelled-recovery"))).toBeNull();
    expect(repo.findById(createOrderId("rearmed-recovery"))).toMatchObject({
      status: "pending",
      clientOrderId: "recovery-stable",
      exchangeOrderId: "rearmed-recovery",
    });
    expect(() =>
      repo.replaceCancelledRecoveryIdentity(
        createOrderId("rearmed-recovery"),
        makeOrder({
          orderId: createOrderId("unexpected-third"),
          clientOrderId: "recovery-stable" as ClientOrderId,
        }),
        metadata,
      ),
    ).toThrow("requires cancelled order");
  });

  it("finds durable startup exit-recovery blockers regardless of local terminal status", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("blocked-cancelled"),
        clientOrderId: "blocked-cancelled" as ClientOrderId,
        status: "cancelled",
        metadata: { startupExitRecoveryBlockV1: { version: 1 } },
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("fenced-filled"),
        clientOrderId: "fenced-filled" as ClientOrderId,
        status: "filled",
        metadata: { exitRecoveryFenceV1: { version: 1, phase: "complete" } },
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("ordinary-open"),
        clientOrderId: "ordinary-open" as ClientOrderId,
        status: "open",
        metadata: { bounceRung: { rungIndex: 0 } },
      }),
    );
    conn.db
      .prepare("UPDATE orders SET metadata_json = ? WHERE order_id = 'ordinary-open'")
      .run('{"unrelatedLegacy":');

    expect(repo.findStartupExitRecoveryBlocked().map((order) => order.orderId)).toEqual([
      createOrderId("blocked-cancelled"),
      createOrderId("fenced-filled"),
    ]);
  });

  it("updates metadata by order_id and returns the persisted order", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("s1-meta-order"),
        clientOrderId: "s1-meta-client" as ClientOrderId,
        status: "open",
        metadata: { s1: { ladderId: "ladder-1", handoffStartedAt: null } },
      }),
    );

    const updated = repo.updateMetadata(createOrderId("s1-meta-order"), {
      s1: {
        ladderId: "ladder-1",
        handoffStartedAt: "2026-06-12T10:30:00.000Z",
      },
    });

    expect(updated.orderId).toBe("s1-meta-order");
    expect(repo.findById(createOrderId("s1-meta-order"))?.metadata).toEqual({
      s1: {
        ladderId: "ladder-1",
        handoffStartedAt: "2026-06-12T10:30:00.000Z",
      },
    });
  });

  it("throws when updateMetadata targets an unknown order_id", () => {
    expect(() => repo.updateMetadata(createOrderId("missing-order"), { s1: {} })).toThrow(
      /missing-order/,
    );
  });

  it("updates metadata in one atomic bulk transaction", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("s1-bulk-a"),
        clientOrderId: "s1-bulk-a-client" as ClientOrderId,
        status: "open",
        metadata: { s1: { ladderId: "ladder-1", tierIndex: 0, handoffStartedAt: null } },
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("s1-bulk-b"),
        clientOrderId: "s1-bulk-b-client" as ClientOrderId,
        status: "open",
        metadata: { s1: { ladderId: "ladder-1", tierIndex: 1, handoffStartedAt: null } },
      }),
    );

    repo.updateMetadataBulk([
      {
        orderId: createOrderId("s1-bulk-a"),
        metadata: {
          s1: { ladderId: "ladder-1", tierIndex: 0, handoffStartedAt: "2026-06-12T10:00:00Z" },
        },
      },
      {
        orderId: createOrderId("s1-bulk-b"),
        metadata: {
          s1: { ladderId: "ladder-1", tierIndex: 1, handoffStartedAt: "2026-06-12T10:00:00Z" },
        },
      },
    ]);

    expect(repo.findById(createOrderId("s1-bulk-a"))?.metadata).toMatchObject({
      s1: { handoffStartedAt: "2026-06-12T10:00:00Z" },
    });
    expect(repo.findById(createOrderId("s1-bulk-b"))?.metadata).toMatchObject({
      s1: { handoffStartedAt: "2026-06-12T10:00:00Z" },
    });
  });

  it("rolls back bulk metadata updates when any order_id is missing", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("s1-bulk-kept"),
        clientOrderId: "s1-bulk-kept-client" as ClientOrderId,
        status: "open",
        metadata: { s1: { ladderId: "ladder-1", handoffStartedAt: null } },
      }),
    );

    expect(() =>
      repo.updateMetadataBulk([
        {
          orderId: createOrderId("s1-bulk-kept"),
          metadata: { s1: { ladderId: "ladder-1", handoffStartedAt: "bad-partial" } },
        },
        {
          orderId: createOrderId("s1-bulk-missing"),
          metadata: { s1: { ladderId: "ladder-1", handoffStartedAt: "bad-partial" } },
        },
      ]),
    ).toThrow(/s1-bulk-missing/);

    expect(repo.findById(createOrderId("s1-bulk-kept"))?.metadata).toEqual({
      s1: { ladderId: "ladder-1", handoffStartedAt: null },
    });
  });

  it("findByClientOrderId works", () => {
    repo.save(makeOrder());

    const found = repo.findByClientOrderId("cloid-1");
    expect(found).not.toBeNull();
    expect(found!.orderId).toBe("ord-1");

    const notFound = repo.findByClientOrderId("nonexistent");
    expect(notFound).toBeNull();
  });

  it("findOpen returns pending, open, and partially-filled orders", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("o1"),
        clientOrderId: "c1" as ClientOrderId,
        status: "pending",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o2"),
        clientOrderId: "c2" as ClientOrderId,
        status: "open",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o3"),
        clientOrderId: "c3" as ClientOrderId,
        status: "filled",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o4"),
        clientOrderId: "c4" as ClientOrderId,
        status: "cancelled",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o5"),
        clientOrderId: "c5" as ClientOrderId,
        status: "rejected",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o6"),
        clientOrderId: "c6" as ClientOrderId,
        status: "partially-filled",
      }),
    );

    const open = repo.findOpen();
    expect(open).toHaveLength(3);

    const statuses = open.map((o) => o.status).sort();
    expect(statuses).toEqual(["open", "partially-filled", "pending"]);
  });

  it("findByTokenId returns orders for token", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("o1"),
        clientOrderId: "c1" as ClientOrderId,
        tokenId: createTokenId("tok-A"),
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o2"),
        clientOrderId: "c2" as ClientOrderId,
        tokenId: createTokenId("tok-A"),
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o3"),
        clientOrderId: "c3" as ClientOrderId,
        tokenId: createTokenId("tok-B"),
      }),
    );

    const tokA = repo.findByTokenId(createTokenId("tok-A"));
    expect(tokA).toHaveLength(2);

    const tokB = repo.findByTokenId(createTokenId("tok-B"));
    expect(tokB).toHaveLength(1);
  });

  it("findRecentByTokenId and findFirstByTokenId return bounded token order windows", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("o-old"),
        clientOrderId: "c-old" as ClientOrderId,
        tokenId: createTokenId("tok-A"),
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o-new"),
        clientOrderId: "c-new" as ClientOrderId,
        tokenId: createTokenId("tok-A"),
        createdAt: "2026-01-03T00:00:00Z",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o-mid"),
        clientOrderId: "c-mid" as ClientOrderId,
        tokenId: createTokenId("tok-A"),
        createdAt: "2026-01-02T00:00:00Z",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o-other"),
        clientOrderId: "c-other" as ClientOrderId,
        tokenId: createTokenId("tok-B"),
        createdAt: "2026-01-04T00:00:00Z",
      }),
    );

    expect(
      repo.findRecentByTokenId(createTokenId("tok-A"), 2).map((order) => order.orderId),
    ).toEqual(["o-new", "o-mid"]);
    expect(repo.findFirstByTokenId(createTokenId("tok-A"))?.orderId).toBe("o-old");
  });

  it("findRecentBySignalReasons returns bounded exit orders since a timestamp", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("o-old"),
        clientOrderId: "c-old" as ClientOrderId,
        signalReason: "repricing-exit",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o-entry"),
        clientOrderId: "c-entry" as ClientOrderId,
        signalReason: "probe-entry",
        createdAt: "2026-01-03T00:00:00Z",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o-exit"),
        clientOrderId: "c-exit" as ClientOrderId,
        signalReason: "repricing-exit",
        createdAt: "2026-01-04T00:00:00Z",
      }),
    );

    const recent = repo.findRecentBySignalReasons(["repricing-exit"], "2026-01-02T00:00:00Z", 10);
    expect(recent.map((order) => order.orderId)).toEqual(["o-exit"]);
  });

  it("updateStatus changes status", () => {
    repo.save(makeOrder());

    repo.updateStatus(createOrderId("ord-1"), "filled");

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.status).toBe("filled");
  });

  it("updateStatus sets exchangeOrderId", () => {
    repo.save(makeOrder());

    repo.updateStatus(createOrderId("ord-1"), "open", "exch-123");

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.status).toBe("open");
    expect(found!.exchangeOrderId).toBe("exch-123");
  });

  it("updateStatus records cancellation reason", () => {
    repo.save(makeOrder());

    repo.updateStatus(createOrderId("ord-1"), "cancelled", undefined, "stale_entry_ttl");

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.status).toBe("cancelled");
    expect(found!.cancelReason).toBe("stale_entry_ttl");
  });

  it("updateStatus persists cancel telemetry payload", () => {
    repo.save(makeOrder());

    repo.updateStatus(createOrderId("ord-1"), "cancelled", undefined, "stale_entry_ttl", {
      cancelAgeMs: 1234,
      cancelAgeBucket: "<1min",
      fillProgressShares: 5,
      marketHorizon: "short",
    });

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.cancelAgeMs).toBe(1234);
    expect(found!.cancelAgeBucket).toBe("<1min");
    expect(found!.fillProgressShares).toBe(5);
    expect(found!.marketHorizon).toBe("short");
  });

  it("save round-trips telemetry fields", () => {
    repo.save(
      makeOrder({
        cancelAgeMs: 9_000,
        cancelAgeBucket: "1-10min",
        fillProgressShares: 3.5,
        marketHorizon: "medium",
      }),
    );

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.cancelAgeMs).toBe(9_000);
    expect(found!.cancelAgeBucket).toBe("1-10min");
    expect(found!.fillProgressShares).toBe(3.5);
    expect(found!.marketHorizon).toBe("medium");
  });

  it("persists and retrieves signalReason", () => {
    repo.save(makeOrder({ signalReason: "repricing-exit" }));

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.signalReason).toBe("repricing-exit");
  });

  it("persists and retrieves postOnly", () => {
    repo.save(makeOrder({ postOnly: true }));

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.postOnly).toBe(true);
  });

  it("signalReason defaults to null", () => {
    repo.save(makeOrder());

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.signalReason).toBeNull();
  });

  it("findByExchangeOrderId returns order when exchange_order_id matches", () => {
    repo.save(makeOrder());
    repo.updateStatus(createOrderId("ord-1"), "open", "exch-abc");

    const found = repo.findByExchangeOrderId("exch-abc");
    expect(found).not.toBeNull();
    expect(found!.orderId).toBe("ord-1");
    expect(found!.exchangeOrderId).toBe("exch-abc");
  });

  it("findByExchangeOrderId returns null when not found", () => {
    const result = repo.findByExchangeOrderId("nonexistent-exchange-id");
    expect(result).toBeNull();
  });

  it("findById returns null for unknown id", () => {
    expect(repo.findById(createOrderId("nonexistent"))).toBeNull();
  });

  // ─── sumOpenBuyNotional ────────────────────────────────────────────

  it("sumOpenBuyNotional returns 0 when no orders exist", () => {
    expect(repo.sumOpenBuyNotional()).toBe(0);
  });

  it("sumOpenBuyNotional sums only open buy orders", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("o1"),
        clientOrderId: "c1" as ClientOrderId,
        side: "buy",
        status: "pending",
        sizeUsdc: 10,
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o2"),
        clientOrderId: "c2" as ClientOrderId,
        side: "buy",
        status: "open",
        sizeUsdc: 20,
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o3"),
        clientOrderId: "c3" as ClientOrderId,
        side: "buy",
        status: "partially-filled",
        sizeUsdc: 15,
      }),
    );

    expect(repo.sumOpenBuyNotional()).toBe(45);
  });

  it("sumOpenBuyNotional excludes sell orders and non-open statuses", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("o1"),
        clientOrderId: "c1" as ClientOrderId,
        side: "buy",
        status: "open",
        sizeUsdc: 10,
      }),
    );
    // sell order — should be excluded
    repo.save(
      makeOrder({
        orderId: createOrderId("o2"),
        clientOrderId: "c2" as ClientOrderId,
        side: "sell",
        status: "open",
        sizeUsdc: 50,
      }),
    );
    // filled buy — should be excluded
    repo.save(
      makeOrder({
        orderId: createOrderId("o3"),
        clientOrderId: "c3" as ClientOrderId,
        side: "buy",
        status: "filled",
        sizeUsdc: 100,
      }),
    );
    // cancelled buy — should be excluded
    repo.save(
      makeOrder({
        orderId: createOrderId("o4"),
        clientOrderId: "c4" as ClientOrderId,
        side: "buy",
        status: "cancelled",
        sizeUsdc: 200,
      }),
    );

    expect(repo.sumOpenBuyNotional()).toBe(10);
  });

  it("sums durable maker BUY commitments in a half-open window", () => {
    const activatedAtUtc = "2026-08-20T10:00:00.000Z";
    const expiresAtUtc = "2026-08-20T12:00:00.000Z";
    const rows = [
      ["pending", 0.1, activatedAtUtc, "c-pending", "maker", "buy"],
      ["open", 0.2, "2026-08-20T10:30:00.000Z", "c-open", "maker", "buy"],
      ["partially-filled", 0.3, "2026-08-20T11:00:00.000Z", "c-partial", "maker", "buy"],
      ["filled", 0.4, "2026-08-20T11:10:00.000Z", "c-filled", "maker", "buy"],
      ["cancelled", 0.5, "2026-08-20T11:20:00.000Z", "c-cancelled", "maker", "buy"],
      ["rejected", 9, "2026-08-20T11:30:00.000Z", "c-rejected", "maker", "buy"],
      ["open", 9, "2026-08-20T09:59:59.999Z", "c-before", "maker", "buy"],
      ["open", 9, expiresAtUtc, "c-expiry", "maker", "buy"],
      ["open", 9, "2026-08-20T11:40:00.000Z", "c-probe", "probe", "buy"],
      ["open", 9, "2026-08-20T11:50:00.000Z", "c-sell", "maker", "sell"],
    ] as const;
    rows.forEach(([status, sizeUsdc, createdAt, clientOrderId, entryStyle, side], index) => {
      repo.save(
        makeOrder({
          orderId: createOrderId(`window-${index}`),
          clientOrderId: clientOrderId as ClientOrderId,
          status,
          sizeUsdc,
          createdAt,
          updatedAt: createdAt,
          entryStyle,
          side,
          ...(index === 4 ? { conditionId: createConditionId("cond-2") } : {}),
        }),
      );
    });
    const insertFill = conn.db.prepare(
      `INSERT INTO fills
       (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc)
       VALUES (?, ?, 'tok-1', 'cond-1', 'buy', 0.5, 1, ?)`,
    );
    insertFill.run("fill-window", "window-3", 0.25);
    insertFill.run("fill-excluded", "window-1", 0.2);

    expect(repo.getMakerBuyWindowUsage(activatedAtUtc, expiresAtUtc, "cond-1", "c-open")).toEqual({
      committedUsdc: 1.3,
      conditionCommittedUsdc: 0.8,
      distinctAcceptedConditions: 2,
      committedConditionIds: expect.arrayContaining(["cond-1", "cond-2"]),
      filledUsdc: 0.25,
    });
  });

  it("persists one deterministic reprice intent and applies status changes with CAS", () => {
    const intent = makeIntent();
    expect(repo.claimMakerCaptureRepriceIntent(intent)).toBe(true);
    expect(repo.claimMakerCaptureRepriceIntent(intent)).toBe(false);
    expect(repo.findMakerCaptureRepriceIntentBySignal(intent.lifecycleSignalId)).toMatchObject({
      intentId: intent.intentId,
      status: "cancel_pending",
    });
    expect(repo.markMakerCaptureRepriceReady(intent.intentId, 0.11, 8, bookProof())).toBe(true);
    expect(repo.markMakerCaptureRepriceReady(intent.intentId, 0.12, 7, bookProof())).toBe(false);
    expect(
      repo.markMakerCaptureRepriceSubmitted(intent.intentId, createOrderId("capture-child")),
    ).toBe(true);
    repo.save(
      makeOrder({
        orderId: createOrderId("capture-child"),
        clientOrderId: "capture-child-client" as ClientOrderId,
      }),
    );
    expect(
      repo.markMakerCaptureRepriceSubmitProof(
        intent.intentId,
        createOrderId("capture-child"),
        "capture-child-client",
        {
          ...bookProof(),
          childOrderId: "capture-child",
          clientOrderId: "capture-child-client",
        },
      ),
    ).toBe(true);
    expect(
      repo.markMakerCaptureRepriceSubmitProof(
        intent.intentId,
        createOrderId("capture-child"),
        "capture-child-client",
        { ...bookProof(), childOrderId: "capture-child", clientOrderId: "capture-child-client" },
      ),
    ).toBe(false);
    conn.close();
    conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
    repo = new SqliteOrderRepository(conn.db);
    expect(
      repo.findMakerCaptureRepriceIntentBySignal(intent.lifecycleSignalId)?.proof?.submit,
    ).toMatchObject({ childOrderId: "capture-child", clientOrderId: "capture-child-client" });
    expect(repo.markMakerCaptureRepriceTerminal(intent.intentId, "completed")).toBe(true);
    expect(repo.markMakerCaptureRepriceTerminal(intent.intentId, "failed", "late")).toBe(false);
    expect(repo.findRecoverableMakerCaptureRepriceIntents()).toEqual([]);
    expect(
      conn.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get("maker_capture_reprice_intents"),
    ).toBeTruthy();
  });

  it("persists bounce ask-capture proof and fences one nonterminal intent per position", () => {
    const intent = makeBounceAskIntent();
    const competing = makeBounceAskIntent({
      intentId: "bounce-ask-intent-2",
      predecessorOrderId: createOrderId("bounce-ask-other-predecessor"),
      lifecycleSignalId: "bounce-ask-reprice-signal-2",
      rootOrderId: createOrderId("bounce-ask-other-root"),
    });

    expect(repo.claimBounceAskCaptureIntent(intent)).toBe(true);
    expect(repo.claimBounceAskCaptureIntent(intent)).toBe(false);
    expect(repo.claimBounceAskCaptureIntent(competing)).toBe(false);
    expect(repo.hasNonterminalBounceAskCaptureIntentForPosition(intent.positionId)).toBe(true);
    expect(repo.isOrderManagedByNonterminalBounceAskCaptureIntent(intent.predecessorOrderId)).toBe(
      true,
    );
    expect(repo.findBounceAskCaptureIntentBySignal(intent.lifecycleSignalId)).toMatchObject({
      intentId: intent.intentId,
      positionId: intent.positionId,
      status: "cancel_pending",
    });

    expect(repo.markBounceAskCaptureReady(intent.intentId, 0.18, 8, bounceAskPreparedProof())).toBe(
      false,
    );
    expect(repo.markBounceAskCaptureReady(intent.intentId, 0.19, 8, bounceAskPreparedProof())).toBe(
      true,
    );
    expect(
      repo.markBounceAskCaptureSubmitted(intent.intentId, createOrderId("bounce-ask-child")),
    ).toBe(true);
    expect(
      repo.isOrderManagedByNonterminalBounceAskCaptureIntent(createOrderId("bounce-ask-child")),
    ).toBe(true);
    expect(
      repo.markBounceAskCaptureSubmitProof(
        intent.intentId,
        createOrderId("bounce-ask-child"),
        "bounce-ask-child-client",
        bounceAskSubmitProof(),
      ),
    ).toBe(false);

    repo.save(
      makeOrder({
        orderId: createOrderId("bounce-ask-child"),
        clientOrderId: "bounce-ask-child-client" as ClientOrderId,
        positionId: intent.positionId,
      }),
    );
    expect(
      repo.markBounceAskCaptureSubmitProof(
        intent.intentId,
        createOrderId("bounce-ask-child"),
        "bounce-ask-child-client",
        bounceAskSubmitProof(),
      ),
    ).toBe(true);
    expect(
      repo.findBounceAskCaptureIntentByChild(createOrderId("bounce-ask-child"))?.proof?.submit,
    ).toMatchObject({
      authoritativeStateHash: "sha256:authoritative-state",
      clientOrderId: "bounce-ask-child-client",
    });
    expect(
      repo.resetBounceAskCaptureSubmitted(intent.intentId, createOrderId("bounce-ask-child")),
    ).toBe(true);
    expect(repo.findBounceAskCaptureIntentBySignal(intent.lifecycleSignalId)).toMatchObject({
      status: "ready",
      childOrderId: null,
      proof: { trigger: intent.proof?.trigger, prepared: bounceAskPreparedProof(), submit: null },
    });
    expect(
      repo.markBounceAskCaptureSubmitted(intent.intentId, createOrderId("bounce-ask-child")),
    ).toBe(true);
    expect(repo.findBounceAskCaptureIntentByPredecessor(intent.predecessorOrderId)?.intentId).toBe(
      intent.intentId,
    );

    conn.close();
    conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
    repo = new SqliteOrderRepository(conn.db);
    expect(repo.findRecoverableBounceAskCaptureIntents()).toHaveLength(1);
    expect(repo.markBounceAskCaptureTerminal(intent.intentId, "dust")).toBe(true);
    expect(repo.hasNonterminalBounceAskCaptureIntentForPosition(intent.positionId)).toBe(false);
    expect(repo.isOrderManagedByNonterminalBounceAskCaptureIntent(intent.predecessorOrderId)).toBe(
      false,
    );
    expect(repo.claimBounceAskCaptureIntent(competing)).toBe(true);
    expect(repo.markBounceAskCaptureTerminal(competing.intentId, "failed", "test")).toBe(true);
    expect(repo.findRecoverableBounceAskCaptureIntents()).toEqual([]);
  });

  it("counts a trusted root once, all chain fills, and invalid siblings conservatively", () => {
    const createdAt = "2026-08-20T10:00:00.000Z";
    const rootLineage = {
      version: 1,
      rootOrderId: "capture-root",
      predecessorOrderId: null,
      replacementIndex: 0,
      rootNotionalUsdc: 1,
    } as const;
    repo.save(
      makeOrder({
        orderId: createOrderId("capture-root"),
        clientOrderId: "capture-root-client" as ClientOrderId,
        status: "cancelled",
        price: 0.1,
        size: 10,
        sizeUsdc: 1,
        entryStyle: "maker",
        postOnly: true,
        signalId: "root-signal",
        signalReason: "probe-entry",
        decisionRuleId: "R23_DIP_TRIGGER",
        metadata: { makerCaptureLineageV1: rootLineage },
        createdAt,
        updatedAt: createdAt,
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("capture-child"),
        clientOrderId: "capture-child-client" as ClientOrderId,
        status: "open",
        price: 0.11,
        size: 8,
        sizeUsdc: 0.88,
        entryStyle: "maker",
        postOnly: true,
        signalId: "capture-reprice-signal-1",
        signalReason: "probe-entry",
        decisionRuleId: "R23_DIP_TRIGGER",
        metadata: {
          makerCaptureLineageV1: {
            ...rootLineage,
            predecessorOrderId: "capture-root",
            replacementIndex: 1,
          },
        },
        createdAt: "2026-08-20T12:00:00.000Z",
        updatedAt: "2026-08-20T12:00:00.000Z",
      }),
    );
    const intent = makeIntent();
    repo.claimMakerCaptureRepriceIntent(intent);
    repo.markMakerCaptureRepriceReady(intent.intentId, 0.11, 8, bookProof());
    repo.markMakerCaptureRepriceSubmitted(intent.intentId, createOrderId("capture-child"));
    const insertFill = conn.db.prepare(
      `INSERT INTO fills
       (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc)
       VALUES (?, ?, 'tok-1', 'cond-1', 'buy', ?, ?, ?)`,
    );
    insertFill.run("capture-root-fill", "capture-root", 0.1, 2, 0.2);
    insertFill.run("capture-child-fill", "capture-child", 0.11, 1, 0.11);

    expect(
      repo.getMakerBuyWindowUsage(
        "2026-08-20T09:00:00.000Z",
        "2026-08-20T12:00:00.000Z",
        "cond-1",
        "unused",
      ),
    ).toMatchObject({ committedUsdc: 1, conditionCommittedUsdc: 1, filledUsdc: 0.31 });
    expect(repo.getMakerCaptureChainUsage(createOrderId("capture-child"))).toMatchObject({
      trusted: true,
      rootNotionalUsdc: 1,
      chainFilledUsdc: 0.31,
      predecessorRemainingShares: 7,
      replacementIndex: 1,
    });

    conn.db
      .prepare("UPDATE orders SET created_at = ? WHERE order_id = 'capture-child'")
      .run("2026-08-20T11:59:00.000Z");
    repo.updateStatus(createOrderId("capture-root"), "open");
    expect(
      repo.getMakerBuyWindowUsage(
        "2026-08-20T09:00:00.000Z",
        "2026-08-20T12:00:00.000Z",
        "cond-1",
        "unused",
      ).committedUsdc,
    ).toBeCloseTo(1.88);
    expect(repo.getMakerCaptureChainUsage(createOrderId("capture-child")).trusted).toBe(false);
  });

  it("persists positionId round-trip and defaults to null when absent (Release A Phase 3)", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("o-pid"),
        clientOrderId: "cloid-pid" as ClientOrderId,
        positionId: createPositionId("pos-9"),
      }),
    );
    expect(repo.findById(createOrderId("o-pid"))!.positionId).toBe("pos-9");

    repo.save(
      makeOrder({
        orderId: createOrderId("o-nopid"),
        clientOrderId: "cloid-nopid" as ClientOrderId,
      }),
    );
    expect(repo.findById(createOrderId("o-nopid"))!.positionId).toBeNull();
  });

  it("positionId is write-once on upsert (status update never overwrites the cycle)", () => {
    repo.save(makeOrder({ orderId: createOrderId("o1"), positionId: createPositionId("pos-A") }));
    // A later save of the SAME order (e.g. status transition) that omits positionId
    // must NOT null out the persisted cycle identity.
    repo.save(makeOrder({ orderId: createOrderId("o1"), status: "open", positionId: null }));
    expect(repo.findById(createOrderId("o1"))!.positionId).toBe("pos-A");
  });
});
