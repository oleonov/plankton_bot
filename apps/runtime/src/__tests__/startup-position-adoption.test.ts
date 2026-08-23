import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapControlDb,
  bootstrapLedgerDb,
  readOwnershipInvariantViolations,
  SqliteFillRepository,
  SqliteInventoryLotRepository,
  SqliteLegStateRepository,
  SqliteMarketRepository,
  SqliteOrderRepository,
  SqlitePositionRepository,
} from "@krabs/db";
import {
  createBotRunId,
  createConditionId,
  createFillId,
  createLotId,
  createOrderId,
  createPositionId,
  createTokenId,
  BOUNCE_EXIT_TARGET_RULE_ID,
  GATE_ENTRY_RULE_ID,
  R23_DIP_TRIGGER_RULE_ID,
  type ClientOrderId,
  type ExchangeFill,
} from "@krabs/domain";
import {
  cleanupPriorStartupAdoptionArtifacts,
  runStartupPositionAdoption,
  StartupSnapshotUnreliableError,
} from "../startup-position-adoption.js";
import {
  BounceForAllNullOwnerError,
  DrainedOrderUnfencedError,
  runDrainedOrderFenceGate,
  runOwnershipInvariantStartupGate,
} from "../modules/exit-ownership/assert-bounce-for-all-invariant.js";
import { canonicalRecoveryMetadata } from "../modules/execution/reservation-utils.js";

const TOKEN_ID = createTokenId("tok-btc-yes");

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  debug: vi.fn(),
  child: () => silentLog,
} as any;

function makeExchangeFill(overrides?: Partial<ExchangeFill>): ExchangeFill {
  return {
    fillId: "fill-1",
    orderId: "ex-1",
    clientOrderId: "plk_missing",
    tokenId: TOKEN_ID,
    side: "buy",
    price: 0.4,
    size: 10,
    liquidityRole: "unknown",
    fee: 0,
    feeRateBps: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

function seedMarket(repo: SqliteMarketRepository): void {
  repo.save({
    tokenId: TOKEN_ID,
    conditionId: "cond-1",
    slug: "bitcoin-above-68000",
    eventSlug: "bitcoin-april",
    question: "Will BTC be above 68k?",
    outcome: "YES",
    regime: "threshold",
    horizon: "daily",
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    eventMarketCount: 1,
    gammaCreatedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function seedMissingBounceCandidate(
  conn: ReturnType<typeof bootstrapLedgerDb>,
  opts: { postOnly?: boolean } = {},
) {
  const orderRepo = new SqliteOrderRepository(conn.db);
  const positionId = createPositionId("pos-missing-bounce");
  const sourceOrderId = createOrderId("ord-missing-bounce-source");
  const predecessorId = createOrderId("ord-missing-bounce-predecessor");
  const now = new Date().toISOString();
  conn.db
    .prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price, cost_basis_usdc,
          status, entry_style, entry_lane, exit_owner, opened_at, updated_at)
       VALUES (?, ?, 'cond-1', 'buy', 5, 0.2, 1, 'open', 'maker', 'R23', 'bounce', ?, ?)`,
    )
    .run(positionId, TOKEN_ID, now, now);
  conn.db
    .prepare(
      `INSERT INTO orders
         (order_id, client_order_id, token_id, condition_id, side, order_type, post_only,
          price, size, size_usdc, status, bot_run_id, created_at, updated_at)
       VALUES (?, 'coid-source', ?, 'cond-1', 'buy', 'GTC', 0, 0.2, 5, 1,
               'filled', 'run-1', ?, ?)`,
    )
    .run(sourceOrderId, TOKEN_ID, now, now);
  conn.db
    .prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
       VALUES ('fill-source', ?, ?, 'cond-1', 'buy', 0.2, 5, 1, ?)`,
    )
    .run(sourceOrderId, TOKEN_ID, now);
  conn.db
    .prepare(
      `INSERT INTO inventory_lots
         (lot_id, position_id, token_id, side, size, remaining_size, entry_price,
          cost_usdc, fill_id, created_at)
       VALUES ('lot-source', ?, ?, 'buy', 5, 5, 0.2, 1, 'fill-source', ?)`,
    )
    .run(positionId, TOKEN_ID, now);
  orderRepo.save({
    orderId: predecessorId,
    clientOrderId: "coid-missing-bounce" as ClientOrderId,
    exchangeOrderId: "ex-missing-bounce",
    tokenId: TOKEN_ID,
    conditionId: createConditionId("cond-1"),
    positionId,
    side: "sell",
    orderType: "GTC",
    postOnly: opts.postOnly ?? true,
    price: 0.3,
    size: 1.5,
    sizeUsdc: 0.45,
    status: "pending",
    signalId: null,
    signalReason: "bounce-exit",
    decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
    entryStyle: "maker",
    metadata: { bounceRung: { ladderId: "ladder-1", rungIndex: 0 } },
    botRunId: createBotRunId("run-1"),
    createdAt: now,
    updatedAt: now,
  });
  return { orderRepo, predecessorId };
}

describe("runStartupPositionAdoption", () => {
  const connections: Array<ReturnType<typeof bootstrapLedgerDb>> = [];

  afterEach(() => {
    while (connections.length > 0) {
      connections.pop()!.close();
    }
  });

  it("adopts orphan buy fills into local order/fill/position/lot state", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    seedMarket(marketRepo);

    const result = await runStartupPositionAdoption({
      gateway: {
        getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getFillsResult: vi.fn().mockResolvedValue({ ok: true, data: [makeExchangeFill()] }),
      },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
    });

    expect(result.appliedFills).toBe(1);
    expect(result.adoptedOrphanFills).toBe(1);
    expect(result.syntheticOrdersCreated).toBe(1);
    expect(result.positionsCreated).toBe(1);
    expect(orderRepo.findByExchangeOrderId("ex-1")).not.toBeNull();
    expect(fillRepo.findByTokenId(TOKEN_ID)).toHaveLength(1);
    expect(fillRepo.findUnreconciled()).toHaveLength(0);
    expect(inventoryLotRepo.findByTokenId(TOKEN_ID)).toHaveLength(1);

    const position = positionRepo.findByTokenId(TOKEN_ID);
    expect(position).not.toBeNull();
    expect(position?.size).toBe(10);
    expect(position?.costBasisUsdc).toBe(4);
  });

  it("uses the immutable pending snapshot after fill import and fails closed for every unresolved exact result", async () => {
    for (const exactResult of [
      { ok: true as const, data: null },
      { ok: false as const, reason: "server" as const, attempts: 1 },
      {
        ok: true as const,
        data: {
          orderId: "ex-pending",
          clientOrderId: null,
          tokenId: TOKEN_ID,
          side: "buy" as const,
          price: 0.4,
          sizeTotal: 10,
          sizeFilled: 6,
          sizeRemaining: 4,
          status: "CANCELLED" as const,
          createdAt: Date.now(),
        },
      },
    ]) {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
      const legStateRepo = new SqliteLegStateRepository(conn.db);
      seedMarket(marketRepo);
      orderRepo.save({
        orderId: createOrderId(`pending-${connections.length}`),
        clientOrderId: `plk_pending_${connections.length}` as ClientOrderId,
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        orderType: "GTC",
        price: 0.4,
        size: 10,
        sizeUsdc: 4,
        status: "pending",
        exchangeOrderId: "ex-pending",
        signalId: null,
        signalReason: null,
        botRunId: createBotRunId("run-1"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await expect(
        runStartupPositionAdoption({
          gateway: {
            getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
            getFillsResult: vi.fn().mockResolvedValue({
              ok: true,
              data: [makeExchangeFill({ orderId: "ex-pending", clientOrderId: null, size: 5 })],
            }),
            getOrderResult: vi.fn().mockResolvedValue(exactResult),
          },
          marketRepo,
          orderRepo,
          fillRepo,
          positionRepo,
          inventoryLotRepo,
          legStateRepo,
          log: silentLog,
          db: conn.db,
          botRunId: createBotRunId("run-1"),
        }),
      ).rejects.toThrow("pending order");
      expect(fillRepo.findByOrderId(createOrderId(`pending-${connections.length}`))).toHaveLength(
        1,
      );
    }
  });

  it("restarts through marked missing-bounce child ambiguity and complete exact coverage", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const marketRepo = new SqliteMarketRepository(conn.db);
    seedMarket(marketRepo);
    const { orderRepo, predecessorId } = seedMissingBounceCandidate(conn);
    let allowRecovery = true;
    const deps = {
      gateway: {
        getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getFillsResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getOrderResult: vi.fn().mockResolvedValue({ ok: true, data: null }),
      },
      marketRepo,
      orderRepo,
      fillRepo: new SqliteFillRepository(conn.db),
      positionRepo: new SqlitePositionRepository(conn.db),
      inventoryLotRepo: new SqliteInventoryLotRepository(conn.db),
      legStateRepo: new SqliteLegStateRepository(conn.db),
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
      allowMissingBounceExitRecovery: () => allowRecovery,
    };

    await runStartupPositionAdoption(deps);
    const marker = orderRepo.findById(predecessorId)?.metadata?.startupExitRecoveryBlockV1;
    expect(marker).toMatchObject({
      predecessorOrderId: String(predecessorId),
      positionShares: 5,
    });

    await runStartupPositionAdoption(deps);
    expect(orderRepo.findById(predecessorId)?.metadata?.startupExitRecoveryBlockV1).toEqual(marker);

    const predecessor = orderRepo.findById(predecessorId)!;
    const childOrderId = createOrderId("ord-missing-bounce-recovery");
    const childClientOrderId = "plk_missing_bounce_recovery" as ClientOrderId;
    const now = new Date().toISOString();
    const hash = "a".repeat(64);
    const incompleteFence = {
      version: 1 as const,
      action: "recover_missing_bounce_exit" as const,
      operatorCommandId: 7,
      predecessorOrderId: String(predecessorId),
      tokenId: String(predecessor.tokenId),
      conditionId: String(predecessor.conditionId),
      positionId: String(predecessor.positionId),
      decisionRuleId: predecessor.decisionRuleId!,
      bounceRungJson: canonicalRecoveryMetadata(predecessor.metadata?.bounceRung),
      createdAt: now,
      preOpenSnapshotHash: hash,
      preFillSnapshotHash: hash,
      preFillWatermark: "0:none:0",
      residualShares: 5,
      childClientOrderId: String(childClientOrderId),
      phase: "child_pending" as const,
      fenceCompletedAt: now,
      postFenceOpenSnapshotHash: hash,
      postFenceFillSnapshotHash: hash,
      postFenceFillWatermark: "0:none:0",
    };
    orderRepo.updateMetadata(predecessorId, {
      ...predecessor.metadata,
      exitRecoveryFenceV1: incompleteFence,
    });
    orderRepo.save({
      ...predecessor,
      orderId: childOrderId,
      clientOrderId: childClientOrderId,
      exchangeOrderId: "ex-missing-bounce-recovery",
      size: 5,
      sizeUsdc: 1.5,
      status: "pending",
      metadata: {
        bounceRung: predecessor.metadata?.bounceRung,
        exitRecoveryChildV1: {
          version: 1,
          predecessorOrderId: String(predecessorId),
          childClientOrderId: String(childClientOrderId),
          coverage: "full_active_residual",
          predecessorShares: predecessor.size,
          residualShares: 5,
        },
      },
      createdAt: now,
      updatedAt: now,
    });

    await runStartupPositionAdoption(deps);

    const exactChild = {
      orderId: "ex-missing-bounce-recovery",
      clientOrderId: String(childClientOrderId),
      tokenId: predecessor.tokenId,
      side: "sell" as const,
      price: predecessor.price,
      sizeTotal: 5,
      sizeFilled: 1,
      sizeRemaining: 4,
      status: "PARTIALLY_FILLED" as const,
      createdAt: Date.now(),
    };
    const completedMetadata = { ...orderRepo.findById(predecessorId)!.metadata };
    delete completedMetadata.startupExitRecoveryBlockV1;
    orderRepo.updateMetadata(predecessorId, {
      ...completedMetadata,
      exitRecoveryFenceV1: {
        ...incompleteFence,
        phase: "complete",
        completedAt: now,
        childOrderId: String(childOrderId),
      },
    });
    vi.mocked(deps.gateway.getOpenOrdersResult).mockResolvedValue({
      ok: true,
      data: [exactChild],
    });
    vi.mocked(deps.gateway.getOrderResult).mockImplementation(async (orderId) => ({
      ok: true,
      data: orderId === exactChild.orderId ? exactChild : null,
    }));
    allowRecovery = false;
    await runStartupPositionAdoption(deps);

    const completedPredecessorMetadata = orderRepo.findById(predecessorId)!.metadata!;
    orderRepo.updateMetadata(predecessorId, {
      ...completedPredecessorMetadata,
      exitRecoveryFenceV1: {
        ...(completedPredecessorMetadata.exitRecoveryFenceV1 as Record<string, unknown>),
        childOrderId: "forged-child",
      },
    });
    await expect(runStartupPositionAdoption(deps)).rejects.toThrow("pending order");
    orderRepo.updateMetadata(predecessorId, completedPredecessorMetadata);

    const childMetadata = orderRepo.findById(childOrderId)!.metadata!;
    orderRepo.updateMetadata(childOrderId, {
      ...childMetadata,
      exitRecoveryChildV1: {
        ...(childMetadata.exitRecoveryChildV1 as Record<string, unknown>),
        predecessorOrderId: "forged-predecessor",
      },
    });
    await expect(runStartupPositionAdoption(deps)).rejects.toThrow("pending order");
    orderRepo.updateMetadata(childOrderId, childMetadata);

    allowRecovery = true;
    orderRepo.updateMetadata(predecessorId, {
      ...orderRepo.findById(predecessorId)!.metadata,
      startupExitRecoveryBlockV1: { version: 99 },
    });
    await expect(runStartupPositionAdoption(deps)).rejects.toThrow("marker is invalid");
    orderRepo.updateMetadata(predecessorId, completedPredecessorMetadata);

    allowRecovery = false;
    orderRepo.save({
      ...orderRepo.findById(childOrderId)!,
      orderId: createOrderId("ord-missing-bounce-recovery-sibling"),
      clientOrderId: "plk_missing_bounce_recovery_sibling" as ClientOrderId,
      exchangeOrderId: "ex-missing-bounce-recovery-sibling",
      status: "rejected",
    });
    await expect(runStartupPositionAdoption(deps)).rejects.toThrow("pending order");
  });

  it("keeps an ineligible exact-notFound pending order on the fatal startup path", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const marketRepo = new SqliteMarketRepository(conn.db);
    seedMarket(marketRepo);
    const { orderRepo, predecessorId } = seedMissingBounceCandidate(conn, { postOnly: false });

    await expect(
      runStartupPositionAdoption({
        gateway: {
          getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
          getFillsResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
          getOrderResult: vi.fn().mockResolvedValue({ ok: true, data: null }),
        },
        marketRepo,
        orderRepo,
        fillRepo: new SqliteFillRepository(conn.db),
        positionRepo: new SqlitePositionRepository(conn.db),
        inventoryLotRepo: new SqliteInventoryLotRepository(conn.db),
        legStateRepo: new SqliteLegStateRepository(conn.db),
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
        allowMissingBounceExitRecovery: () => true,
      }),
    ).rejects.toThrow("pending order");
    expect(orderRepo.findById(predecessorId)?.metadata).toEqual({
      bounceRung: { ladderId: "ladder-1", rungIndex: 0 },
    });
  });

  it("Release A Phase 3 (P6): startup fence quarantines mismatched/NULL-positionId working SELLs as drain targets before servicing resumes", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    seedMarket(marketRepo);

    // Three exchange-live SELLs left over from a prior cycle: one with a NULL/legacy
    // positionId (pre-migration order), one whose positionId points at a
    // cycle that is no longer active, and one whose local row is already cancelled.
    // All three must fail-closed as stale per
    // isStaleOrReopeningWorkingOrder's SELL branch, since neither matches the
    // active position the fill replay below is about to (re)create.
    const staleSellNullId = createOrderId("ord-stale-sell-null");
    orderRepo.save({
      orderId: staleSellNullId,
      clientOrderId: "plk_stale_sell_null" as ClientOrderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      side: "sell",
      orderType: "GTC",
      price: 0.6,
      size: 10,
      sizeUsdc: 6,
      status: "open",
      exchangeOrderId: "ex-stale-sell-null",
      signalId: null,
      signalReason: "bounce-exit",
      botRunId: createBotRunId("run-1"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // positionId intentionally omitted — NULL/legacy.
    });
    const staleSellMismatchId = createOrderId("ord-stale-sell-mismatch");
    orderRepo.save({
      orderId: staleSellMismatchId,
      clientOrderId: "plk_stale_sell_mismatch" as ClientOrderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      side: "sell",
      orderType: "GTC",
      price: 0.62,
      size: 10,
      sizeUsdc: 6.2,
      status: "open",
      exchangeOrderId: "ex-stale-sell-mismatch",
      signalId: null,
      signalReason: "bounce-exit",
      positionId: createPositionId("pos-prior-closed-cycle"),
      botRunId: createBotRunId("run-1"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const staleSellLocallyCancelledId = createOrderId("ord-stale-sell-local-cancelled");
    orderRepo.save({
      orderId: staleSellLocallyCancelledId,
      clientOrderId: "plk_stale_sell_local_cancelled" as ClientOrderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      side: "sell",
      orderType: "GTC",
      price: 0.64,
      size: 10,
      sizeUsdc: 6.4,
      status: "cancelled",
      cancelReason: "operator",
      exchangeOrderId: "ex-stale-sell-local-cancelled",
      signalId: null,
      signalReason: "bounce-exit",
      positionId: createPositionId("pos-prior-local-terminal-cycle"),
      botRunId: createBotRunId("run-1"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await runStartupPositionAdoption({
      gateway: {
        getOpenOrdersResult: vi.fn().mockResolvedValue({
          ok: true,
          data: [
            {
              orderId: "ex-stale-sell-null",
              clientOrderId: "plk_stale_sell_null",
              tokenId: TOKEN_ID,
              side: "sell",
              price: 0.6,
              sizeTotal: 10,
              sizeFilled: 0,
              sizeRemaining: 10,
              status: "OPEN",
              createdAt: Date.now(),
            },
            {
              orderId: "ex-stale-sell-mismatch",
              clientOrderId: "plk_stale_sell_mismatch",
              tokenId: TOKEN_ID,
              side: "sell",
              price: 0.62,
              sizeTotal: 10,
              sizeFilled: 0,
              sizeRemaining: 10,
              status: "OPEN",
              createdAt: Date.now(),
            },
            {
              orderId: "ex-stale-sell-local-cancelled",
              clientOrderId: "plk_stale_sell_local_cancelled",
              tokenId: TOKEN_ID,
              side: "sell",
              price: 0.64,
              sizeTotal: 10,
              sizeFilled: 0,
              sizeRemaining: 10,
              status: "OPEN",
              createdAt: Date.now(),
            },
          ],
        }),
        getFillsResult: vi.fn().mockResolvedValue({ ok: true, data: [makeExchangeFill()] }),
      },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
    });

    // The BUY fill replay above (re)establishes the token's ONLY active
    // position, so all three resting SELLs are cross-cycle relative to it —
    // none carries that position's id.
    expect(result.quarantinedStaleSells).toBe(3);
    expect(result.quarantinedReopeningBuys).toBe(0);
    expect(result.drainTargets).toHaveLength(1);
    const target = result.drainTargets[0]!;
    expect(target.tokenId).toBe(TOKEN_ID);
    expect(target.activePositionId).not.toBeNull();
    expect(new Set(target.orders.map((o) => String(o.orderId)))).toEqual(
      new Set([
        String(staleSellNullId),
        String(staleSellMismatchId),
        String(staleSellLocallyCancelledId),
      ]),
    );
  });

  it("FAIL CLOSED (Gap 2): an unreliable fill snapshot (ok:false) aborts startup and mutates nothing", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    seedMarket(marketRepo);

    const getFillsResult = vi.fn().mockResolvedValue({ ok: false, reason: "timeout", attempts: 3 });

    await expect(
      runStartupPositionAdoption({
        gateway: {
          getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
          getFillsResult,
        },
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
      }),
    ).rejects.toBeInstanceOf(StartupSnapshotUnreliableError);

    // Ledger untouched: no positions/orders/fills created (throw happened BEFORE cleanup/mutation).
    expect(positionRepo.findOpen()).toHaveLength(0);
    expect(fillRepo.findByTokenId(TOKEN_ID)).toHaveLength(0);
    expect(getFillsResult).toHaveBeenCalledOnce();
  });

  it("forwards fillCompletionTolerance=0 through import and startup exact resolution", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    seedMarket(marketRepo);

    const orderId = createOrderId("ord-known");
    orderRepo.save({
      orderId,
      clientOrderId: "plk_known" as ClientOrderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      side: "buy",
      orderType: "GTC",
      price: 0.4,
      size: 10, // fill below is 9.97 → 0.3% short
      sizeUsdc: 4,
      status: "pending",
      exchangeOrderId: "ex-known",
      signalId: null,
      signalReason: "probe-entry",
      botRunId: createBotRunId("run-1"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await runStartupPositionAdoption({
      gateway: {
        getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getFillsResult: vi.fn().mockResolvedValue({
          ok: true,
          data: [
            makeExchangeFill({
              fillId: "fill-known",
              orderId: "ex-known",
              clientOrderId: "plk_known",
              size: 9.97,
            }),
          ],
        }),
        getOrderResult: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            orderId: "ex-known",
            clientOrderId: "plk_known",
            tokenId: TOKEN_ID,
            side: "buy",
            price: 0.4,
            sizeTotal: 10,
            sizeFilled: 9.97,
            sizeRemaining: 0.03,
            status: "CANCELLED",
            createdAt: Date.now(),
          },
        }),
      },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
      fillCompletionTolerance: 0,
    });

    // With the default 0.5% heuristic this exact path would normalize 9.97/10 to
    // filled. The explicit rollback value 0 must preserve the exact cancelled-partial.
    expect(orderRepo.findById(orderId)?.status).toBe("cancelled");
  });

  it("rebuilds the same startup-adopted state across repeated startups", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    seedMarket(marketRepo);

    const gateway = {
      getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      getFillsResult: vi.fn().mockResolvedValue({ ok: true, data: [makeExchangeFill()] }),
    };

    const first = await runStartupPositionAdoption({
      gateway,
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
    });
    const second = await runStartupPositionAdoption({
      gateway,
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-2"),
    });

    expect(first.appliedFills).toBe(1);
    expect(second.cleanedSyntheticOrders).toBe(1);
    expect(second.cleanedSyntheticFills).toBe(1);
    expect(second.appliedFills).toBe(1);
    expect(positionRepo.findOpen()).toHaveLength(1);
    expect(fillRepo.findByTokenId(TOKEN_ID)).toHaveLength(1);
  });

  it("skips orphan fills whose token is not classified into a market family", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);

    const result = await runStartupPositionAdoption({
      gateway: {
        getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getFillsResult: vi.fn().mockResolvedValue({ ok: true, data: [makeExchangeFill()] }),
      },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
    });

    expect(result.appliedFills).toBe(0);
    expect(result.skippedNoMarket).toBe(1);
    expect(positionRepo.findOpen()).toHaveLength(0);
  });

  it("skips invalid-timestamp fills instead of crashing startup", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    seedMarket(marketRepo);

    const result = await runStartupPositionAdoption({
      gateway: {
        getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getFillsResult: vi
          .fn()
          .mockResolvedValue({ ok: true, data: [makeExchangeFill({ timestamp: Number.NaN })] }),
      },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
    });

    expect(result.appliedFills).toBe(0);
    expect(result.skippedInvalidTimestamp).toBe(1);
    expect(positionRepo.findOpen()).toHaveLength(0);
    expect(fillRepo.findByTokenId(TOKEN_ID)).toHaveLength(0);
  });

  it("cleans previous startup-adoption artifacts before rebuilding corrected positions", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    seedMarket(marketRepo);

    orderRepo.save({
      orderId: createOrderId("bad-order"),
      clientOrderId: "adopt-bad" as ClientOrderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),

      side: "buy",
      orderType: "GTC",
      postOnly: false,
      price: 0.9,
      size: 334.37188,
      sizeUsdc: 300.934692,
      status: "filled",
      exchangeOrderId: "bad-order",
      signalId: null,
      signalReason: "startup-adoption",
      botRunId: createBotRunId("bad-run"),
      createdAt: "2026-04-05T00:00:00Z",
      updatedAt: "2026-04-05T00:00:00Z",
    });
    fillRepo.save({
      fillId: createFillId("bad-fill"),
      orderId: createOrderId("bad-order"),
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),

      side: "buy",
      price: 0.9,
      size: 334.37188,
      sizeUsdc: 300.934692,
      liquidityRole: "maker",
      fee: 0,
      feeRateBps: 0,
      filledAt: "2026-04-05T00:00:00Z",
    });
    positionRepo.save({
      positionId: createPositionId("bad-position"),
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),

      side: "buy",
      size: 334.37188,
      avgEntryPrice: 0.9,
      costBasisUsdc: 300.934692,
      currentValueUsdc: 255.79,
      realizedPnl: 0,
      status: "open",
      entryStyle: "probe",
      openedAt: "2026-04-05T00:00:00Z",
      closedAt: null,
      updatedAt: "2026-04-05T00:00:00Z",
    });
    inventoryLotRepo.save({
      lotId: createLotId("bad-lot"),
      positionId: createPositionId("bad-position"),
      tokenId: TOKEN_ID,

      side: "buy",
      size: 334.37188,
      remainingSize: 334.37188,
      entryPrice: 0.9,
      costUsdc: 300.934692,
      fillId: createFillId("bad-fill"),
      createdAt: "2026-04-05T00:00:00Z",
    });

    const result = await runStartupPositionAdoption({
      gateway: {
        getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getFillsResult: vi.fn().mockResolvedValue({
          ok: true,
          data: [
            makeExchangeFill({
              fillId: "good-fill",
              orderId: "good-order",
              clientOrderId: "",
              size: 43.47,
              price: 0.11,
            }),
          ],
        }),
      },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
    });

    expect(result.cleanedSyntheticOrders).toBe(1);
    expect(result.cleanedSyntheticFills).toBe(1);
    expect(result.appliedFills).toBe(1);

    const position = positionRepo.findByTokenId(TOKEN_ID);
    expect(position).not.toBeNull();
    expect(position?.size).toBeCloseTo(43.47, 6);
    expect(position?.avgEntryPrice).toBeCloseTo(0.11, 6);
    expect(position?.costBasisUsdc).toBeCloseTo(4.7817, 6);
  });

  describe("leg-state rebuild", () => {
    function seedOrder(orderRepo: SqliteOrderRepository, orderId: string): void {
      orderRepo.save({
        orderId: createOrderId(orderId),
        clientOrderId: `coid-${orderId}` as ClientOrderId,
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),

        side: "buy",
        orderType: "GTC",
        postOnly: false,
        price: 0.42,
        size: 10,
        sizeUsdc: 4.2,
        status: "filled",
        exchangeOrderId: orderId,
        signalId: null,
        signalReason: "probe-entry",
        botRunId: createBotRunId("run-seed"),
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
      });
    }

    function seedOpenPosition(
      positionRepo: SqlitePositionRepository,
      overrides?: Partial<Parameters<SqlitePositionRepository["save"]>[0]>,
    ): void {
      positionRepo.save({
        positionId: createPositionId("pos-1"),
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),

        side: "buy",
        size: 10,
        avgEntryPrice: 0.42,
        costBasisUsdc: 4.2,
        currentValueUsdc: 4.2,
        realizedPnl: 0,
        status: "open",
        entryStyle: "probe",
        openedAt: "2026-04-01T00:00:00Z",
        closedAt: null,
        updatedAt: "2026-04-01T00:00:00Z",
        ...overrides,
      });
    }

    function seedFill(
      fillRepo: SqliteFillRepository,
      overrides: Omit<Partial<Parameters<SqliteFillRepository["save"]>[0]>, "fillId"> & {
        fillId: string;
      },
    ): void {
      const { fillId, ...rest } = overrides;
      fillRepo.save({
        fillId: createFillId(fillId),
        orderId: createOrderId("ord-seed"),
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),

        side: "buy",
        price: 0.42,
        size: 10,
        sizeUsdc: 4.2,
        liquidityRole: "maker",
        fee: 0,
        feeRateBps: 0,
        filledAt: "2026-04-01T00:00:00Z",
        ...rest,
      });
    }

    async function runRebuild(conn: ReturnType<typeof bootstrapLedgerDb>): Promise<{
      result: Awaited<ReturnType<typeof runStartupPositionAdoption>>;
      legStateRepo: SqliteLegStateRepository;
    }> {
      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
      const legStateRepo = new SqliteLegStateRepository(conn.db);
      const result = await runStartupPositionAdoption({
        gateway: {
          getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
          getFillsResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        },
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
      });
      return { result, legStateRepo };
    }

    function primeLedger(conn: ReturnType<typeof bootstrapLedgerDb>): {
      marketRepo: SqliteMarketRepository;
      orderRepo: SqliteOrderRepository;
      fillRepo: SqliteFillRepository;
      positionRepo: SqlitePositionRepository;
    } {
      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      seedMarket(marketRepo);
      seedOrder(orderRepo, "ord-seed");
      return { marketRepo, orderRepo, fillRepo, positionRepo };
    }

    it("seeds leg_state for open position with matching fills", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo);
      seedFill(fillRepo, { fillId: "f-1", price: 0.42, filledAt: "2026-04-01T00:00:00Z" });

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(1);
      expect(result.alreadyPresentLegStates).toBe(0);
      expect(result.positionsWithoutFills).toEqual([]);
      const state = legStateRepo.get(TOKEN_ID);
      expect(state).not.toBeNull();
      expect(state?.buyCount).toBe(1);
      expect(state?.sellCount).toBe(0);
      expect(state?.lastAction).toBe("BUY");
      expect(state?.firstTradePrice).toBe(0.42);
      expect(state?.firstTradeAt).toBe("2026-04-01T00:00:00Z");
    });

    it("is idempotent: second run does not overwrite existing leg_state", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo);
      seedFill(fillRepo, { fillId: "f-1", price: 0.42, filledAt: "2026-04-01T00:00:00Z" });

      const first = await runRebuild(conn);
      expect(first.result.seededLegStates).toBe(1);
      const firstState = first.legStateRepo.get(TOKEN_ID);

      const second = await runRebuild(conn);
      expect(second.result.seededLegStates).toBe(0);
      expect(second.result.alreadyPresentLegStates).toBe(1);
      const secondState = second.legStateRepo.get(TOKEN_ID);
      expect(secondState).toEqual(firstState);
    });

    it("counts buy and sell fills across multiple fills of each side", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo);
      seedFill(fillRepo, {
        fillId: "f-1",
        side: "buy",
        price: 0.42,
        filledAt: "2026-04-01T00:00:00Z",
      });
      seedFill(fillRepo, {
        fillId: "f-2",
        side: "buy",
        price: 0.11,
        filledAt: "2026-04-02T00:00:00Z",
      });
      seedFill(fillRepo, {
        fillId: "f-3",
        side: "sell",
        price: 0.55,
        filledAt: "2026-04-03T00:00:00Z",
      });

      const { legStateRepo } = await runRebuild(conn);

      const state = legStateRepo.get(TOKEN_ID);
      expect(state?.buyCount).toBe(2);
      expect(state?.sellCount).toBe(1);
      expect(state?.lastAction).toBe("SELL");
      expect(state?.lastTradeAt).toBe("2026-04-03T00:00:00Z");
    });

    it("uses first BUY fill for firstTradePrice (ordered by filled_at ASC, fill_id ASC)", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo);
      seedFill(fillRepo, { fillId: "f-b", price: 0.99, filledAt: "2026-04-01T00:00:00Z" });
      seedFill(fillRepo, { fillId: "f-a", price: 0.42, filledAt: "2026-04-01T00:00:00Z" });
      seedFill(fillRepo, { fillId: "f-c", price: 0.11, filledAt: "2026-04-02T00:00:00Z" });

      const { legStateRepo } = await runRebuild(conn);

      const state = legStateRepo.get(TOKEN_ID);
      expect(state?.firstTradePrice).toBe(0.42);
      expect(state?.firstTradeAt).toBe("2026-04-01T00:00:00Z");
    });

    it("reports positionsWithoutFills for an open position with zero fills", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo);

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.positionsWithoutFills).toEqual([TOKEN_ID]);
      expect(result.seededLegStates).toBe(0);
      expect(legStateRepo.get(TOKEN_ID)).toBeNull();
    });

    it("falls back to position.avgEntryPrice when the first BUY fill has price=0", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo, { avgEntryPrice: 0.37, costBasisUsdc: 3.7 });
      seedFill(fillRepo, { fillId: "f-1", price: 0, filledAt: "2026-04-01T00:00:00Z" });

      const { legStateRepo } = await runRebuild(conn);

      const state = legStateRepo.get(TOKEN_ID);
      expect(state?.firstTradePrice).toBe(0.37);
    });

    it("seeds leg_state for dust positions (not just open)", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo, { status: "dust" });
      seedFill(fillRepo, { fillId: "f-1", price: 0.42, filledAt: "2026-04-01T00:00:00Z" });

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(1);
      expect(legStateRepo.get(TOKEN_ID)?.buyCount).toBe(1);
    });

    it("skips closed positions", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo, {
        status: "closed",
        closedAt: "2026-04-02T00:00:00Z",
      });
      seedFill(fillRepo, { fillId: "f-1", price: 0.42, filledAt: "2026-04-01T00:00:00Z" });

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(0);
      expect(result.positionsWithoutFills).toEqual([]);
      expect(legStateRepo.get(TOKEN_ID)).toBeNull();
    });

    it("scopes replay past prior closed-leg fills — prior fills don't leak into rebuilt leg_state", async () => {
      // ADR-027 §D-B — a token can have a prior CLOSED leg and a later
      // reopened active position with no leg_state row (e.g. control DB
      // migrated independently). The rebuild must scope fills to
      // `filled_at > MAX(prior closed_at)`. opened_at is wall-clock and can
      // race ahead of an exchange-supplied filled_at; closed_at is always
      // strictly after the prior leg's last fill, so it gives a clean strict
      // lower bound that excludes the old leg without dropping the active
      // leg's opening fill.
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);

      // Prior closed leg with its own fills — must be ignored by the rebuild:
      positionRepo.save({
        positionId: createPositionId("pos-prior"),
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        size: 0,
        avgEntryPrice: 0.1,
        costBasisUsdc: 0,
        currentValueUsdc: 0,
        realizedPnl: 0,
        status: "closed",
        entryStyle: "probe",
        openedAt: "2026-03-01T00:00:00Z",
        closedAt: "2026-03-15T00:00:00Z",
        updatedAt: "2026-03-15T00:00:00Z",
      });
      seedFill(fillRepo, { fillId: "f-old-1", price: 0.1, filledAt: "2026-03-01T00:00:00Z" });
      seedFill(fillRepo, {
        fillId: "f-old-2",
        side: "sell",
        price: 0.15,
        filledAt: "2026-03-02T00:00:00Z",
      });

      // Active position with one BUY whose exchange filled_at is BEFORE its
      // wall-clock opened_at — exercises the clock-skew gap that broke the
      // earlier opened_at-based scope.
      seedOpenPosition(positionRepo, { openedAt: "2026-04-01T00:00:01Z" });
      seedFill(fillRepo, {
        fillId: "f-new-1",
        side: "buy",
        price: 0.42,
        filledAt: "2026-04-01T00:00:00Z",
      });

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(1);
      const state = legStateRepo.get(TOKEN_ID);
      // Without scoping: buyCount=2, sellCount=1, firstTradePrice=0.10.
      // With prior-close scoping (`filled_at > "2026-03-15"`): only the
      // active leg's BUY survives, even though its filled_at < opened_at.
      expect(state?.buyCount).toBe(1);
      expect(state?.sellCount).toBe(0);
      expect(state?.firstTradePrice).toBe(0.42);
      expect(state?.firstTradeAt).toBe("2026-04-01T00:00:00Z");
    });

    it("ignores synthetic late closed_at (post-active-leg) when scoping replay", async () => {
      // Bootstrap's duplicate-open repair (`ensureUniqueOpenPositionIndex`)
      // closes losing duplicates with `closed_at = datetime('now')`, which
      // can be AFTER the active leg's actual fills. The replay scope must
      // pick the largest `closed_at < active.opened_at`, not a global MAX,
      // or that synthetic timestamp would mask out the active leg's own
      // fills and leave the position without a leg_state row.
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);

      // Active position opened 2026-04-01 — its first BUY fill is here:
      seedOpenPosition(positionRepo, {
        positionId: createPositionId("pos-active"),
        openedAt: "2026-04-01T00:00:00Z",
      });
      seedFill(fillRepo, {
        fillId: "f-active-1",
        side: "buy",
        price: 0.42,
        filledAt: "2026-04-01T00:00:01Z",
      });

      // Synthetic late-closed duplicate row: opened earlier (2026-03-25) but
      // closed_at synthesised at "2026-05-10" by the dup-open repair. With
      // an unfiltered MAX(closed_at), this would set the lower bound past
      // the active leg's fill and orphan the position.
      positionRepo.save({
        positionId: createPositionId("pos-dup"),
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        size: 0,
        avgEntryPrice: 0.1,
        costBasisUsdc: 0,
        currentValueUsdc: 0,
        realizedPnl: 0,
        status: "closed",
        entryStyle: "probe",
        openedAt: "2026-03-25T00:00:00Z",
        closedAt: "2026-05-10T00:00:00Z",
        updatedAt: "2026-05-10T00:00:00Z",
      });

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(1);
      expect(result.positionsWithoutFills).toEqual([]);
      const state = legStateRepo.get(TOKEN_ID);
      expect(state?.buyCount).toBe(1);
      expect(state?.firstTradePrice).toBe(0.42);
    });

    it("uses time parsing (not lexical sort) when comparing mixed-format timestamps", async () => {
      // bootstrap.ts:600 (`ensureUniqueOpenPositionIndex`) writes
      // `closed_at = datetime('now')`, which yields SQLite's compact format
      // `YYYY-MM-DD HH:MM:SS` (space separator), while runtime opens/fills
      // are ISO strings `...T...Z`. Lexical ordering disagrees with
      // chronological ordering across the two formats because space (0x20)
      // sorts before T (0x54). With raw text comparison, an ISO timestamp
      // at 08:00 sorts AFTER an SQLite-format timestamp at 10:00 on the
      // same date — so a stale prior-leg fill at 08:00 ISO would slip past
      // a `filled_at > "YYYY-MM-DD 10:00:00"` predicate and leak into the
      // active leg's rebuilt counts. We use julianday() to compare both
      // sides numerically.
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);

      // Active position opened the next day.
      seedOpenPosition(positionRepo, {
        positionId: createPositionId("pos-active"),
        openedAt: "2026-04-02T00:00:00.000Z",
      });
      seedFill(fillRepo, {
        fillId: "f-active",
        side: "buy",
        price: 0.42,
        filledAt: "2026-04-02T00:00:01.000Z",
      });

      // Stale fill from the prior leg, BEFORE the synthetic close at 10:00
      // SQLite-format. Should be excluded by the replay scope. With raw
      // text comparison, "2026-04-01T08:00:00.000Z" > "2026-04-01 10:00:00"
      // (T > space at char 10) — so the broken impl wrongly includes it.
      seedFill(fillRepo, {
        fillId: "f-stale",
        side: "buy",
        price: 0.99,
        filledAt: "2026-04-01T08:00:00.000Z",
      });

      // Bypass repository writes to inject SQLite's space-format timestamp
      // directly, mirroring what `ensureUniqueOpenPositionIndex` produces
      // via `datetime('now')`.
      const insertPriorClose = conn.db.prepare(
        `INSERT INTO positions (
           position_id, token_id, condition_id, side, size,
           avg_entry_price, cost_basis_usdc, current_value_usdc,
           realized_pnl, status, entry_style,
           opened_at, closed_at, updated_at
         ) VALUES (?, ?, ?, 'buy', 0, 0.1, 0, 0, 0, 'closed', 'probe', ?, ?, ?)`,
      );
      insertPriorClose.run(
        "pos-prior",
        TOKEN_ID,
        "cond-1",
        "2026-04-01T07:00:00.000Z",
        "2026-04-01 10:00:00",
        "2026-04-01 10:00:00",
      );

      // Second qualifying prior close, same calendar date, rendered in ISO form (with a
      // 'T' separator) and chronologically EARLIER than pos-prior's 10:00. Lexical
      // `MAX(closed_at)` picks whichever STRING sorts highest, and 'T' (0x54) always beats
      // ' ' (0x20) at the same character position — so a lexical MAX would wrongly pick
      // THIS 06:00 row over pos-prior's later 10:00 one, regardless of the actual clock
      // time. That drags the replay boundary down to 06:00, which would let f-stale (08:00)
      // wrongly slip past it as "after" the (wrong) prior close — reusing f-stale as the
      // trap for this failure mode too, so no separate trap fill is needed.
      insertPriorClose.run(
        "pos-prior-2",
        TOKEN_ID,
        "cond-1",
        "2026-04-01T05:00:00.000Z",
        "2026-04-01T06:00:00.000Z",
        "2026-04-01T06:00:00.000Z",
      );

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(1);
      const state = legStateRepo.get(TOKEN_ID);
      // Only the active fill should count — the stale 08:00 ISO fill must not bleed past
      // the correctly-selected 10:00 prior-close boundary (a lexical-max bug would instead
      // select pos-prior-2's 06:00 row and let it through).
      expect(state?.buyCount).toBe(1);
      expect(state?.firstTradePrice).toBe(0.42);
    });

    it("dedups tokens with coexisting open + dust rows (counts fills once)", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      positionRepo.save({
        positionId: createPositionId("pos-dust"),
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),

        side: "buy",
        size: 1,
        avgEntryPrice: 0.3,
        costBasisUsdc: 0.3,
        currentValueUsdc: 0.3,
        realizedPnl: 0,
        status: "dust",
        entryStyle: "probe",
        openedAt: "2026-03-30T00:00:00Z",
        closedAt: null,
        updatedAt: "2026-03-30T00:00:00Z",
      });
      seedOpenPosition(positionRepo, { positionId: createPositionId("pos-open") });
      seedFill(fillRepo, { fillId: "f-1", price: 0.42, filledAt: "2026-04-01T00:00:00Z" });

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(1);
      expect(legStateRepo.get(TOKEN_ID)?.buyCount).toBe(1);
    });
  });

  describe("maker entryStyle propagation through adoption", () => {
    it("carries 'maker' entryStyle from a local order into the created position", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);

      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
      const legStateRepo = new SqliteLegStateRepository(conn.db);
      seedMarket(marketRepo);

      const orderId = createOrderId("ord-maker");
      orderRepo.save({
        orderId,
        clientOrderId: "plk_maker" as ClientOrderId,
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        orderType: "GTC",
        price: 0.4,
        size: 10,
        sizeUsdc: 4,
        status: "open",
        exchangeOrderId: "ex-maker",
        signalId: null,
        signalReason: "maker-entry",
        entryStyle: "maker",
        botRunId: createBotRunId("run-1"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await runStartupPositionAdoption({
        gateway: {
          getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
          getFillsResult: vi.fn().mockResolvedValue({
            ok: true,
            data: [makeExchangeFill({ orderId: "ex-maker", clientOrderId: "plk_maker" })],
          }),
        },
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
      });

      const position = positionRepo.findByTokenId(TOKEN_ID);
      expect(position).not.toBeNull();
      expect(position?.entryStyle).toBe("maker");
    });

    it("defaults position to 'probe' when order has no entryStyle (byte-identical for non-maker path)", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);

      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
      const legStateRepo = new SqliteLegStateRepository(conn.db);
      seedMarket(marketRepo);

      // No entryStyle on the order — probe default
      await runStartupPositionAdoption({
        gateway: {
          getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
          getFillsResult: vi.fn().mockResolvedValue({ ok: true, data: [makeExchangeFill()] }),
        },
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
      });

      const position = positionRepo.findByTokenId(TOKEN_ID);
      expect(position).not.toBeNull();
      expect(position?.entryStyle).toBe("probe");
    });

    it("preserves 'maker' entryStyle through a second startup (reconcileAndRepairPosition path)", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);

      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
      const legStateRepo = new SqliteLegStateRepository(conn.db);
      seedMarket(marketRepo);

      const gateway = {
        getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getFillsResult: vi.fn().mockResolvedValue({
          ok: true,
          data: [makeExchangeFill({ orderId: "ex-restart", clientOrderId: "plk_restart" })],
        }),
      };

      const orderId = createOrderId("ord-restart");
      orderRepo.save({
        orderId,
        clientOrderId: "plk_restart" as ClientOrderId,
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        orderType: "GTC",
        price: 0.4,
        size: 10,
        sizeUsdc: 4,
        status: "open",
        exchangeOrderId: "ex-restart",
        signalId: null,
        signalReason: "maker-entry",
        entryStyle: "maker",
        botRunId: createBotRunId("run-1"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // First startup — creates the position with "maker"
      await runStartupPositionAdoption({
        gateway,
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
      });

      expect(positionRepo.findByTokenId(TOKEN_ID)?.entryStyle).toBe("maker");

      // Second startup — goes through reconcileAndRepairPosition which reads entry_style from DB
      await runStartupPositionAdoption({
        gateway,
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-2"),
      });

      const afterRestart = positionRepo.findByTokenId(TOKEN_ID);
      expect(afterRestart?.entryStyle).toBe("maker");
    });
  });

  describe("entry lane propagation through adoption (Phase 3 plumbing)", () => {
    it("carries entryLane='GATE' from a local order's decisionRuleId into the created position", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);

      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
      const legStateRepo = new SqliteLegStateRepository(conn.db);
      seedMarket(marketRepo);

      const orderId = createOrderId("ord-gate");
      orderRepo.save({
        orderId,
        clientOrderId: "plk_gate" as ClientOrderId,
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        orderType: "GTC",
        price: 0.4,
        size: 10,
        sizeUsdc: 4,
        status: "open",
        exchangeOrderId: "ex-gate",
        signalId: null,
        signalReason: "probe-entry",
        decisionRuleId: GATE_ENTRY_RULE_ID,
        botRunId: createBotRunId("run-1"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await runStartupPositionAdoption({
        gateway: {
          getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
          getFillsResult: vi.fn().mockResolvedValue({
            ok: true,
            data: [makeExchangeFill({ orderId: "ex-gate", clientOrderId: "plk_gate" })],
          }),
        },
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
      });

      const position = positionRepo.findByTokenId(TOKEN_ID);
      expect(position).not.toBeNull();
      expect(position?.entryLane).toBe("GATE");
    });

    it("carries entryLane='R23' from a local order's decisionRuleId into the created position", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);

      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
      const legStateRepo = new SqliteLegStateRepository(conn.db);
      seedMarket(marketRepo);

      const orderId = createOrderId("ord-r23");
      orderRepo.save({
        orderId,
        clientOrderId: "plk_r23" as ClientOrderId,
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        orderType: "GTC",
        price: 0.4,
        size: 10,
        sizeUsdc: 4,
        status: "open",
        exchangeOrderId: "ex-r23",
        signalId: null,
        signalReason: "r23-dip-entry",
        decisionRuleId: R23_DIP_TRIGGER_RULE_ID,
        botRunId: createBotRunId("run-1"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await runStartupPositionAdoption({
        gateway: {
          getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
          getFillsResult: vi.fn().mockResolvedValue({
            ok: true,
            data: [makeExchangeFill({ orderId: "ex-r23", clientOrderId: "plk_r23" })],
          }),
        },
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
      });

      const position = positionRepo.findByTokenId(TOKEN_ID);
      expect(position).not.toBeNull();
      expect(position?.entryLane).toBe("R23");
    });

    it("defaults entryLane to null when the order has no/unknown decisionRuleId (legacy path)", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);

      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
      const legStateRepo = new SqliteLegStateRepository(conn.db);
      seedMarket(marketRepo);

      // No decisionRuleId on the order — legacy/unknown path
      await runStartupPositionAdoption({
        gateway: {
          getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
          getFillsResult: vi.fn().mockResolvedValue({ ok: true, data: [makeExchangeFill()] }),
        },
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
      });

      const position = positionRepo.findByTokenId(TOKEN_ID);
      expect(position).not.toBeNull();
      expect(position?.entryLane).toBeNull();
    });

    it("preserves entryLane='GATE' through a second startup (reconcileAndRepairPosition path)", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);

      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
      const legStateRepo = new SqliteLegStateRepository(conn.db);
      seedMarket(marketRepo);

      const gateway = {
        getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getFillsResult: vi.fn().mockResolvedValue({
          ok: true,
          data: [
            makeExchangeFill({ orderId: "ex-gate-restart", clientOrderId: "plk_gate_restart" }),
          ],
        }),
      };

      const orderId = createOrderId("ord-gate-restart");
      orderRepo.save({
        orderId,
        clientOrderId: "plk_gate_restart" as ClientOrderId,
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        orderType: "GTC",
        price: 0.4,
        size: 10,
        sizeUsdc: 4,
        status: "open",
        exchangeOrderId: "ex-gate-restart",
        signalId: null,
        signalReason: "probe-entry",
        decisionRuleId: GATE_ENTRY_RULE_ID,
        botRunId: createBotRunId("run-1"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // First startup — creates the position with entryLane='GATE'
      await runStartupPositionAdoption({
        gateway,
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
      });

      expect(positionRepo.findByTokenId(TOKEN_ID)?.entryLane).toBe("GATE");

      // Second startup — goes through reconcileAndRepairPosition which reads entry_lane from DB
      await runStartupPositionAdoption({
        gateway,
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-2"),
      });

      const afterRestart = positionRepo.findByTokenId(TOKEN_ID);
      expect(afterRestart?.entryLane).toBe("GATE");
    });
  });
});

describe("cleanupPriorStartupAdoptionArtifacts — orphan-loop guard", () => {
  const connections: Array<ReturnType<typeof bootstrapLedgerDb>> = [];

  afterEach(() => {
    while (connections.length > 0) {
      connections.pop()!.close();
    }
  });

  type LedgerDb = ReturnType<typeof bootstrapLedgerDb>["db"];

  function makeDeps(db: LedgerDb): Parameters<typeof cleanupPriorStartupAdoptionArtifacts>[0] {
    return { db, log: silentLog } as unknown as Parameters<
      typeof cleanupPriorStartupAdoptionArtifacts
    >[0];
  }

  function rowExists(db: LedgerDb, table: string, column: string, value: string): boolean {
    return db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(value) !== undefined;
  }

  function insertSyntheticOrder(db: LedgerDb, token: string, orderId: string): void {
    db.prepare(
      `INSERT INTO orders
         (order_id, client_order_id, token_id, condition_id, side, order_type,
          price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at)
       VALUES (?, ?, ?, 'cond-1', 'sell', 'GTC', 0.023, 7.43, 0.17089, 'filled',
               'startup-adoption', 'run-1', '2026-06-05T03:48:51Z', '2026-06-05T03:48:51Z')`,
    ).run(orderId, `coid-${orderId}`, token);
  }

  function seedSyntheticArtifact(
    db: LedgerDb,
    opts: {
      token: string;
      orderId: string;
      fillId: string;
      positionId: string;
      lotId: string;
      reconciled: 0 | 1;
      withLegStateTransition: boolean;
    },
  ): void {
    insertSyntheticOrder(db, opts.token, opts.orderId);
    db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, status, opened_at, updated_at)
       VALUES (?, ?, 'cond-1', 'buy', 7.43, 0.006, 0.04458, 'open',
               '2026-06-05T03:48:51Z', '2026-06-05T03:48:51Z')`,
    ).run(opts.positionId, opts.token);
    db.prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
          liquidity_role, reconciled, filled_at)
       VALUES (?, ?, ?, 'cond-1', 'sell', 0.023, 7.43, 0.17089, 'maker', ?,
               '2026-06-05T03:48:51Z')`,
    ).run(opts.fillId, opts.orderId, opts.token, opts.reconciled);
    db.prepare(
      `INSERT INTO inventory_lots
         (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
       VALUES (?, ?, ?, 'buy', 7.43, 7.43, 0.006, 0.04458, ?, '2026-06-05T03:48:51Z')`,
    ).run(opts.lotId, opts.positionId, opts.token, opts.fillId);
    if (opts.withLegStateTransition) {
      db.prepare(
        `INSERT INTO leg_state_transitions
           (token_id, position_id, fill_id, order_id, from_phase, to_phase, action,
            from_buy_count, from_sell_count, to_buy_count, to_sell_count, reason, occurred_at)
         VALUES (?, ?, ?, ?, 'S2', 'S2', 'SELL', 1, 3, 1, 4, 'orphan-reconciled', '2026-06-05T03:48:51Z')`,
      ).run(opts.token, opts.positionId, opts.fillId, opts.orderId);
    }
  }

  function bindMergeLeg(
    db: LedgerDb,
    status: "pending" | "onchain" | "applied",
    positionId: string,
  ): void {
    db.prepare(
      `INSERT INTO merge_ledger
         (merge_id, condition_id, merged_amount, spread_pnl, merged_at, status,
          yes_token_id, no_token_id, yes_position_id, no_position_id)
       VALUES (?, 'cond-merge', 1, 0, '2026-06-06T00:00:00.000Z', ?,
               'tok-merge-yes', 'tok-merge-no', ?, 'pos-other-leg')`,
    ).run(`merge-${status}-${positionId}`, status, positionId);
  }

  it("preserves a reconciled orphan adoption order already reflected in leg state (loop fix → NOT re-adopted)", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    seedSyntheticArtifact(conn.db, {
      token: "tok-loop",
      orderId: "ord-loop",
      fillId: "fill-loop",
      positionId: "pos-loop",
      lotId: "lot-loop",
      reconciled: 1,
      withLegStateTransition: true,
    });

    const result = cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db));

    expect(result.orderIds).toEqual([]);
    expect(rowExists(conn.db, "orders", "order_id", "ord-loop")).toBe(true);
    expect(rowExists(conn.db, "fills", "fill_id", "fill-loop")).toBe(true);
    expect(rowExists(conn.db, "inventory_lots", "lot_id", "lot-loop")).toBe(true);
    expect(rowExists(conn.db, "positions", "position_id", "pos-loop")).toBe(true);
  });

  it.each([
    ["pending", "inventory_lots"],
    ["onchain", "inventory_lots"],
    ["applied", "inventory_lots"],
    ["pending", "pnl_ledger"],
    ["onchain", "pnl_ledger"],
    ["applied", "pnl_ledger"],
  ] as const)("preserves a whole merge-bound order for %s via %s", (status, attribution) => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    seedSyntheticArtifact(conn.db, {
      token: "tok-bound",
      orderId: "ord-bound",
      fillId: "fill-bound",
      positionId: "pos-bound",
      lotId: "lot-bound",
      reconciled: 0,
      withLegStateTransition: false,
    });
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-bound-sibling', 'ord-bound', 'tok-bound', 'cond-1', 'sell', 0.02, 1, 0.02,
                 '2026-06-05T03:49:00.000Z')`,
      )
      .run();
    if (attribution === "pnl_ledger") {
      conn.db.prepare("DELETE FROM inventory_lots WHERE lot_id = 'lot-bound'").run();
      conn.db
        .prepare(
          `INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at)
           VALUES ('fill-bound', 'pos-bound', 0.01, '2026-06-05T03:48:51.000Z')`,
        )
        .run();
    }
    bindMergeLeg(conn.db, status, "pos-bound");

    expect(cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db)).orderIds).toEqual([]);
    expect(rowExists(conn.db, "orders", "order_id", "ord-bound")).toBe(true);
    expect(rowExists(conn.db, "fills", "fill_id", "fill-bound-sibling")).toBe(true);
  });

  it("still removes unrelated synthetic artifacts beside a merge-bound order", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    seedSyntheticArtifact(conn.db, {
      token: "tok-protected",
      orderId: "ord-protected",
      fillId: "fill-protected",
      positionId: "pos-protected",
      lotId: "lot-protected",
      reconciled: 0,
      withLegStateTransition: false,
    });
    bindMergeLeg(conn.db, "onchain", "pos-protected");
    seedSyntheticArtifact(conn.db, {
      token: "tok-unrelated",
      orderId: "ord-unrelated",
      fillId: "fill-unrelated",
      positionId: "pos-unrelated",
      lotId: "lot-unrelated",
      reconciled: 0,
      withLegStateTransition: false,
    });

    expect(cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db)).orderIds).toEqual([
      "ord-unrelated",
    ]);
    expect(rowExists(conn.db, "orders", "order_id", "ord-protected")).toBe(true);
    expect(rowExists(conn.db, "orders", "order_id", "ord-unrelated")).toBe(false);
  });

  it("removes an unreconciled orphan adoption order, and one with no fill (backward compat → existing behavior)", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    // (a) reconciled = 0 even though it has a leg-state transition → still removed.
    seedSyntheticArtifact(conn.db, {
      token: "tok-bw",
      orderId: "ord-bw",
      fillId: "fill-bw",
      positionId: "pos-bw",
      lotId: "lot-bw",
      reconciled: 0,
      withLegStateTransition: true,
    });
    // (b) a synthetic order with no fill at all → guard sees a null fill id and
    //     stays out of the way; existing behavior removes it.
    insertSyntheticOrder(conn.db, "tok-nofill", "ord-nofill");

    const result = cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db));

    expect(result.orderIds.sort()).toEqual(["ord-bw", "ord-nofill"]);
    expect(rowExists(conn.db, "orders", "order_id", "ord-bw")).toBe(false);
    expect(rowExists(conn.db, "fills", "fill_id", "fill-bw")).toBe(false);
    expect(rowExists(conn.db, "inventory_lots", "lot_id", "lot-bw")).toBe(false);
    expect(rowExists(conn.db, "orders", "order_id", "ord-nofill")).toBe(false);

    // The husk goes with it. Once its lots, fills, P&L and order are gone the position
    // has no accounting footprint left, so it is DELETED, not closed — closing it would
    // mint a zero-realized_pnl closed row that the dashboard winrate counts as a loss
    // and buildPositionCycles returns as a cycle.
    expect(rowExists(conn.db, "positions", "position_id", "pos-bw")).toBe(false);
  });

  it("removes a reconciled orphan adoption order that is not reflected in leg state (missing leg-state entry → removal)", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    seedSyntheticArtifact(conn.db, {
      token: "tok-noleg",
      orderId: "ord-noleg",
      fillId: "fill-noleg",
      positionId: "pos-noleg",
      lotId: "lot-noleg",
      reconciled: 1,
      withLegStateTransition: false,
    });

    const result = cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db));

    expect(result.orderIds).toEqual(["ord-noleg"]);
    expect(rowExists(conn.db, "orders", "order_id", "ord-noleg")).toBe(false);
    expect(rowExists(conn.db, "fills", "fill_id", "fill-noleg")).toBe(false);
    expect(rowExists(conn.db, "inventory_lots", "lot_id", "lot-noleg")).toBe(false);
  });

  it("is safe and removes nothing when there are no startup-adoption artifacts (fill not found)", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    // A non-synthetic order — outside the cleanup's signal_reason scope.
    conn.db
      .prepare(
        `INSERT INTO orders
           (order_id, client_order_id, token_id, condition_id, side, order_type,
            price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at)
         VALUES ('ord-real', 'coid-real', 'tok-real', 'cond-1', 'buy', 'GTC', 0.4, 10, 4, 'filled',
                 'first_entry', 'run-1', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
      )
      .run();

    let result: ReturnType<typeof cleanupPriorStartupAdoptionArtifacts> | undefined;
    expect(() => {
      result = cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db));
    }).not.toThrow();

    expect(result?.orderIds).toEqual([]);
    expect(rowExists(conn.db, "orders", "order_id", "ord-real")).toBe(true);
  });

  it("rebuildTokenPosition ranks by instant, not raw text: a same-day space-form time beats an earlier ISO time (else the chronologically newer position is the one deleted)", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const token = "tok-instant-race";

    // Chronologically OLDER (09:00), rendered ISO. Under a raw-text ORDER BY,
    // 'T' (0x54) at the date/time separator outranks the space-form row below
    // regardless of the hour digits, so this row wrongly sorts FIRST under the
    // broken (pre-ledgerInstant) ordering.
    //
    // Seeded 'open' against a newer 'dust' row on purpose — that pair is legal
    // under idx_positions_unique_open_per_token (partial, WHERE status='open')
    // and it is what negative-pins the retire-before-promote ordering: reverting
    // to promote-then-retire flips the winner to 'open' while THIS row is still
    // 'open' and raises SQLITE_CONSTRAINT out of the adoption transaction.
    const isoOlderId = "pos-z-iso-older";
    conn.db
      .prepare(
        `INSERT INTO positions
           (position_id, token_id, condition_id, side, size, avg_entry_price,
            cost_basis_usdc, status, opened_at, updated_at)
         VALUES (?, ?, 'cond-1', 'buy', 5, 0.3, 1.5, 'open', ?, ?)`,
      )
      .run(isoOlderId, token, "2026-08-05T09:00:00.000Z", "2026-08-05T09:00:00.000Z");

    // Chronologically NEWER (10:00 > 09:00), rendered space-form the way the
    // legacy `datetime('now')` DEFAULT/partial-UPDATE path writes it. Give it
    // the textually-SMALLER position_id: under `position_id DESC` tie-break,
    // if it ever engaged, it would ALSO favor isoOlderId — same as the broken
    // raw-text primary sort — so this test can only pass because of
    // ledgerInstant(), never because the tie-break happens to rescue it.
    const spaceNewerId = "pos-a-space-newer";
    conn.db
      .prepare(
        `INSERT INTO positions
           (position_id, token_id, condition_id, side, size, avg_entry_price,
            cost_basis_usdc, status, opened_at, updated_at)
         VALUES (?, ?, 'cond-1', 'buy', 7, 0.4, 2.8, 'dust', ?, ?)`,
      )
      .run(spaceNewerId, token, "2026-08-05 10:00:00", "2026-08-05 10:00:00");

    // A real BUY fill + lot so remainingLots.length > 0 — rebuildTokenPosition
    // must NOT take the "no remaining lots -> retire everything" early return,
    // or the ranking logic under test never runs.
    conn.db
      .prepare(
        `INSERT INTO orders
           (order_id, client_order_id, token_id, condition_id, side, order_type,
            price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at)
         VALUES ('ord-real', 'coid-real', ?, 'cond-1', 'buy', 'GTC', 0.35, 12, 4.2, 'filled',
                 'probe-entry', 'run-1', '2026-08-05T09:30:00.000Z', '2026-08-05T09:30:00.000Z')`,
      )
      .run(token);
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-real', 'ord-real', ?, 'cond-1', 'buy', 0.35, 12, 4.2, '2026-08-05T09:30:00.000Z')`,
      )
      .run(token);
    conn.db
      .prepare(
        `INSERT INTO inventory_lots
           (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
         VALUES ('lot-real', ?, ?, 'buy', 12, 12, 0.35, 4.2, 'fill-real', '2026-08-05T09:30:00.000Z')`,
      )
      .run(spaceNewerId, token);

    // A FULLY-CONSUMED lot owned by the LOSER. `remaining_size = 0` keeps it out
    // of the `remaining_size > 0` scan, so it never influences the winner's
    // totals — but it is part of the loser's history, so the merge must hand it
    // to the winner along with everything else (see the assertion below).
    conn.db
      .prepare(
        `INSERT INTO inventory_lots
           (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
         VALUES ('lot-loser-spent', ?, ?, 'buy', 5, 0, 0.3, 1.5, 'fill-real', '2026-08-05T08:00:00.000Z')`,
      )
      .run(isoOlderId, token);

    // TERMINAL order history owned by the LOSER. `orders.position_id` is the one
    // reference class the merge deliberately leaves behind (it is the exit-owner
    // servicing key), but a `filled` order is history, not live state — it must NOT
    // keep the emptied loser alive as a husk (see the assertion below).
    conn.db
      .prepare(
        `INSERT INTO orders
           (order_id, client_order_id, token_id, condition_id, side, order_type,
            price, size, size_usdc, status, signal_reason, bot_run_id, position_id, created_at, updated_at)
         VALUES ('ord-loser-history', 'coid-loser-history', ?, 'cond-1', 'sell', 'GTC', 0.3, 5, 1.5,
                 'filled', 'probe-entry', 'run-1', ?, '2026-08-05T08:30:00.000Z', '2026-08-05T08:30:00.000Z')`,
      )
      .run(token, isoOlderId);

    // Synthetic-adoption order + matching fill — the only thing that makes
    // cleanupPriorStartupAdoptionArtifacts pick up `token` and call
    // rebuildTokenPosition for it (a trigger order with no fill contributes no
    // token — see the "no fill" case in the test above).
    insertSyntheticOrder(conn.db, token, "ord-trigger");
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-trigger', 'ord-trigger', ?, 'cond-1', 'sell', 0.023, 7.43, 0.17089, '2026-06-05T03:48:51Z')`,
      )
      .run(token);

    expect(() => cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db))).not.toThrow();

    const remaining = conn.db
      .prepare(`SELECT position_id FROM positions WHERE token_id = ? AND status != 'closed'`)
      .all(token) as Array<{ position_id: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.position_id).toBe(spaceNewerId);

    // The merge empties the loser, and its only remaining reference is a TERMINAL
    // order — so it is DELETED, not left behind. Closing it instead would publish a
    // zero-P&L closed row that `readClosedWinrate` scores as a fresh LOSS (it filters
    // on nothing but status/closed_at, and derives losses as total - wins) and that
    // `buildPositionCycles` returns as a phantom CLOSED_PROFIT cycle with no fills.
    expect(rowExists(conn.db, "positions", "position_id", isoOlderId)).toBe(false);
    // The order row itself survives — only the position it pointed at is gone, and
    // that pointer is inert: every consumer of `orders.position_id` is an in-memory
    // equality/membership check, and the I2 active-sell invariant fires only for
    // WORKING sells, which are exactly what the delete guard keeps alive.
    expect(rowExists(conn.db, "orders", "order_id", "ord-loser-history")).toBe(true);

    // Its fully-consumed lot went WITH it to the winner. Leaving the spent half of
    // a round trip behind while the live half moves is what splits one cycle across
    // two positions in buildPositionCycles.
    const spentLotOwner = conn.db
      .prepare(`SELECT position_id FROM inventory_lots WHERE lot_id = 'lot-loser-spent'`)
      .get() as { position_id: string } | undefined;
    expect(spentLotOwner?.position_id).toBe(spaceNewerId);
  });

  it("rebuildTokenPosition reparents the lots it consolidates: the winner owns every lot its size and cost basis claim", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const token = "tok-lot-ownership";

    // Same legal pair as the ranking test: older 'open' + newer 'dust' under the
    // partial unique index. The newer row wins and absorbs BOTH lots below.
    const loserId = "pos-lot-loser";
    const winnerId = "pos-lot-winner";
    const insertPosition = conn.db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, status, opened_at, updated_at)
       VALUES (?, ?, 'cond-1', 'buy', ?, ?, ?, ?, ?, ?)`,
    );
    const older = "2026-08-05T09:00:00.000Z";
    const newer = "2026-08-05T10:00:00.000Z";
    insertPosition.run(loserId, token, 6, 0.25, 1.5, "open", older, older);
    insertPosition.run(winnerId, token, 4, 0.5, 2, "dust", newer, newer);

    conn.db
      .prepare(
        `INSERT INTO orders
           (order_id, client_order_id, token_id, condition_id, side, order_type,
            price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at)
         VALUES ('ord-own', 'coid-own', ?, 'cond-1', 'buy', 'GTC', 0.35, 10, 3.5, 'filled',
                 'probe-entry', 'run-1', '2026-08-05T08:00:00.000Z', '2026-08-05T08:00:00.000Z')`,
      )
      .run(token);
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-own', 'ord-own', ?, 'cond-1', 'buy', 0.35, 10, 3.5, '2026-08-05T08:00:00.000Z')`,
      )
      .run(token);

    // Both lots are live (remaining_size > 0), so BOTH are summed into the winner —
    // but one of them is owned by the loser. Every consumer downstream filters lots by
    // position_id, not by token, so leaving it behind would make the winner claim
    // inventory that its own SELL cannot spend.
    const insertLot = conn.db.prepare(
      `INSERT INTO inventory_lots
         (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
       VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, 'fill-own', ?)`,
    );
    insertLot.run("lot-on-loser", loserId, token, 6, 6, 0.25, 1.5, older);
    insertLot.run("lot-on-winner", winnerId, token, 4, 4, 0.5, 2, newer);

    insertSyntheticOrder(conn.db, token, "ord-own-trigger");
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-own-trigger', 'ord-own-trigger', ?, 'cond-1', 'sell', 0.02, 1, 0.02, '2026-08-05T11:00:00.000Z')`,
      )
      .run(token);

    expect(() => cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db))).not.toThrow();

    const lotOwners = conn.db
      .prepare(`SELECT lot_id, position_id FROM inventory_lots WHERE token_id = ? ORDER BY lot_id`)
      .all(token) as Array<{ lot_id: string; position_id: string }>;
    expect(lotOwners).toEqual([
      { lot_id: "lot-on-loser", position_id: winnerId },
      { lot_id: "lot-on-winner", position_id: winnerId },
    ]);

    const winner = conn.db
      .prepare(`SELECT status, size, cost_basis_usdc FROM positions WHERE position_id = ?`)
      .get(winnerId) as { status: string; size: number; cost_basis_usdc: number };
    expect(winner.status).not.toBe("closed");
    expect(winner.size).toBe(10);
    expect(winner.cost_basis_usdc).toBeCloseTo(3.5, 10);

    // Handing over its only lot leaves the loser with no accounting footprint and no
    // order of its own, so it is deleted rather than left as a phantom closed row.
    expect(rowExists(conn.db, "positions", "position_id", loserId)).toBe(false);
  });

  it("rebuildTokenPosition sets the merged position's opened_at to the EARLIEST source, not the winner's own", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const token = "tok-opened-at-floor";

    // Same legal pair as the ranking test: older 'open' + newer 'dust' under the partial
    // unique index — the newer row wins by opened_at DESC. Its own opened_at is AFTER the
    // loser's, so if the merge kept only the winner's opened_at, the loser's absorbed
    // BUY/SELL history would land before the merged position's cycle boundary.
    const loserId = "pos-openedat-loser";
    const winnerId = "pos-openedat-winner";
    const insertPosition = conn.db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, status, opened_at, updated_at)
       VALUES (?, ?, 'cond-1', 'buy', ?, ?, ?, ?, ?, ?)`,
    );
    const loserOpenedAt = "2026-08-01T00:00:00.000Z";
    const winnerOpenedAt = "2026-08-05T10:00:00.000Z";
    insertPosition.run(loserId, token, 6, 0.25, 1.5, "open", loserOpenedAt, loserOpenedAt);
    insertPosition.run(winnerId, token, 4, 0.5, 2, "dust", winnerOpenedAt, winnerOpenedAt);

    conn.db
      .prepare(
        `INSERT INTO orders
           (order_id, client_order_id, token_id, condition_id, side, order_type,
            price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at)
         VALUES ('ord-openedat', 'coid-openedat', ?, 'cond-1', 'buy', 'GTC', 0.35, 10, 3.5, 'filled',
                 'probe-entry', 'run-1', '2026-08-01T00:30:00.000Z', '2026-08-01T00:30:00.000Z')`,
      )
      .run(token);
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-openedat', 'ord-openedat', ?, 'cond-1', 'buy', 0.35, 10, 3.5, '2026-08-01T00:30:00.000Z')`,
      )
      .run(token);

    // Both lots are live, so both feed remainingLots — one on each side of the merge.
    const insertLot = conn.db.prepare(
      `INSERT INTO inventory_lots
         (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
       VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, 'fill-openedat', ?)`,
    );
    insertLot.run("lot-openedat-loser", loserId, token, 6, 6, 0.25, 1.5, loserOpenedAt);
    insertLot.run("lot-openedat-winner", winnerId, token, 4, 4, 0.5, 2, winnerOpenedAt);

    insertSyntheticOrder(conn.db, token, "ord-openedat-trigger");
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-openedat-trigger', 'ord-openedat-trigger', ?, 'cond-1', 'sell', 0.02, 1, 0.02, '2026-08-05T11:00:00.000Z')`,
      )
      .run(token);

    expect(() => cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db))).not.toThrow();

    const winner = conn.db
      .prepare(`SELECT opened_at FROM positions WHERE position_id = ?`)
      .get(winnerId) as { opened_at: string };
    // The loser's opened_at (earlier) survives the merge on the winner — not the winner's
    // own (later) opened_at. Keeping the winner's own value here would understate the
    // merged position's hold duration and drop the loser's absorbed fills out of any
    // `filled_at >= opened_at` read.
    expect(winner.opened_at).toBe(loserOpenedAt);
  });

  it("rebuildTokenPosition reads the CLOSED winner's own opened_at from `positions`, not the live lot's created_at, when no non-closed row exists", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const token = "tok-closed-winner-opened-at";

    // No non-closed position exists for this token at all, so `openRows` comes back empty and
    // `activePositionId` falls back to `remainingLots[0]`'s owner — which is itself CLOSED here
    // (reconciliation/bootstrap can close a position without consuming its live lot). Being the
    // winner, it is also excluded from `mergeSourceIds`, so pre-fix neither `openRows` nor the
    // merge-source query ever read its opened_at — the code fell back to the lot's `created_at`.
    const winnerId = "pos-closed-owns-live-lot";
    const winnerOpenedAt = "2026-08-01T00:00:00.000Z";
    const lotCreatedAt = "2026-08-05T10:00:00.000Z"; // AFTER opened_at — the buggy fallback value
    conn.db
      .prepare(
        `INSERT INTO positions
           (position_id, token_id, condition_id, side, size, avg_entry_price,
            cost_basis_usdc, status, opened_at, closed_at, updated_at)
         VALUES (?, ?, 'cond-1', 'buy', 0, 0, 0, 'closed', ?, ?, ?)`,
      )
      .run(winnerId, token, winnerOpenedAt, winnerOpenedAt, winnerOpenedAt);

    conn.db
      .prepare(
        `INSERT INTO orders
           (order_id, client_order_id, token_id, condition_id, side, order_type,
            price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at)
         VALUES ('ord-closed-winner', 'coid-closed-winner', ?, 'cond-1', 'buy', 'GTC', 0.35, 10, 3.5,
                 'filled', 'probe-entry', 'run-1', ?, ?)`,
      )
      .run(token, winnerOpenedAt, winnerOpenedAt);
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-closed-winner', 'ord-closed-winner', ?, 'cond-1', 'buy', 0.35, 10, 3.5, ?)`,
      )
      .run(token, winnerOpenedAt);

    // The live lot survives under the closed position with a `created_at` well AFTER its
    // opened_at — exactly the value the pre-fix fallback picked instead of the position's own.
    conn.db
      .prepare(
        `INSERT INTO inventory_lots
           (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
         VALUES ('lot-closed-winner', ?, ?, 'buy', 10, 10, 0.35, 3.5, 'fill-closed-winner', ?)`,
      )
      .run(winnerId, token, lotCreatedAt);

    insertSyntheticOrder(conn.db, token, "ord-closed-winner-trigger");
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-closed-winner-trigger', 'ord-closed-winner-trigger', ?, 'cond-1', 'sell', 0.02, 1, 0.02, '2026-08-05T11:00:00.000Z')`,
      )
      .run(token);

    expect(() => cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db))).not.toThrow();

    const winner = conn.db
      .prepare(`SELECT opened_at, status FROM positions WHERE position_id = ?`)
      .get(winnerId) as { opened_at: string; status: string };
    expect(winner.status).not.toBe("closed");
    // Must be the position's OWN original opened_at, read from `positions` — not the live lot's
    // created_at, which is what the pre-fix fallback used when `activeRow` was undefined.
    expect(winner.opened_at).toBe(winnerOpenedAt);
  });

  it("rebuildTokenPosition moves a PARTIALLY consumed lot together with the realized rows that consumed it", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const token = "tok-partial-lot";

    const loserId = "pos-partial-loser";
    const winnerId = "pos-partial-winner";
    const insertPosition = conn.db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, realized_pnl, status, opened_at, updated_at)
       VALUES (?, ?, 'cond-1', 'buy', ?, ?, ?, ?, ?, ?, ?)`,
    );
    const older = "2026-08-05T09:00:00.000Z";
    const newer = "2026-08-05T10:00:00.000Z";
    insertPosition.run(loserId, token, 4, 0.35, 1.4, 1.2, "open", older, older);
    insertPosition.run(winnerId, token, 0, 0, 0, 0, "dust", newer, newer);

    const insertOrder = conn.db.prepare(
      `INSERT INTO orders
         (order_id, client_order_id, token_id, condition_id, side, order_type,
          price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at)
       VALUES (?, ?, ?, 'cond-1', ?, 'GTC', ?, ?, ?, 'filled', 'probe-entry', 'run-1', ?, ?)`,
    );
    const insertFill = conn.db.prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
       VALUES (?, ?, ?, 'cond-1', ?, ?, ?, ?, ?)`,
    );
    insertOrder.run("ord-buy10", "coid-buy10", token, "buy", 0.35, 10, 3.5, older, older);
    insertFill.run("fill-buy10", "ord-buy10", token, "buy", 0.35, 10, 3.5, older);
    insertOrder.run("ord-sell6", "coid-sell6", token, "sell", 0.55, 6, 3.3, older, older);
    insertFill.run(
      "fill-sell6",
      "ord-sell6",
      token,
      "sell",
      0.55,
      6,
      3.3,
      "2026-08-05T09:30:00.000Z",
    );

    // The defect this pins: one lot that bought 10 and still holds 4. `loadBuyRows`
    // (apps/api/src/routes/position-cycles.ts) groups BUYs by inventory_lots.position_id
    // but carries fills.size — the FULL 10 — so moving the lot alone hands the winner a
    // 10-share BUY it never made and leaves the loser a SELL with no BUY (UNKNOWN_ACCT).
    conn.db
      .prepare(
        `INSERT INTO inventory_lots
           (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
         VALUES ('lot-partial', ?, ?, 'buy', 10, 4, 0.35, 3.5, 'fill-buy10', ?)`,
      )
      .run(loserId, token, older);
    conn.db
      .prepare(
        `INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at)
         VALUES ('fill-sell6', ?, 1.2, '2026-08-05T09:30:00.000Z')`,
      )
      .run(loserId);

    insertSyntheticOrder(conn.db, token, "ord-partial-trigger");
    insertFill.run(
      "fill-partial-trigger",
      "ord-partial-trigger",
      token,
      "sell",
      0.02,
      1,
      0.02,
      "2026-08-05T11:00:00.000Z",
    );

    expect(() => cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db))).not.toThrow();

    // Lot AND the realized row that consumed part of it land on the same position, so
    // the winner's cycle reads BUY 10 / SELL 6 / 4 live instead of a split round trip.
    const lotOwner = conn.db
      .prepare(`SELECT position_id FROM inventory_lots WHERE lot_id = 'lot-partial'`)
      .get() as { position_id: string } | undefined;
    expect(lotOwner?.position_id).toBe(winnerId);
    const realizedOwner = conn.db
      .prepare(`SELECT position_id FROM pnl_ledger WHERE fill_id = 'fill-sell6'`)
      .get() as { position_id: string } | undefined;
    expect(realizedOwner?.position_id).toBe(winnerId);

    // The winner's realized total is read AFTER the merge, so it carries what it absorbed.
    const winner = conn.db
      .prepare(`SELECT size, cost_basis_usdc, realized_pnl FROM positions WHERE position_id = ?`)
      .get(winnerId) as { size: number; cost_basis_usdc: number; realized_pnl: number };
    expect(winner.size).toBe(4);
    expect(winner.cost_basis_usdc).toBeCloseTo(1.4, 10);
    expect(winner.realized_pnl).toBeCloseTo(1.2, 10);

    expect(rowExists(conn.db, "positions", "position_id", loserId)).toBe(false);
  });

  it("retiring a position with no remaining lots re-accounts it instead of leaving a stale basis and an orphaned realized total", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const token = "tok-retire-all";
    const positionId = "pos-retire-all";

    // Seeded with a basis, a liquidation value, and a realized total that no longer match
    // its ledger rows — exactly what cleanupPriorStartupAdoptionArtifacts leaves behind
    // when it deletes the synthetic fills' P&L rows a moment before the retire.
    conn.db
      .prepare(
        `INSERT INTO positions
           (position_id, token_id, condition_id, side, size, avg_entry_price,
            cost_basis_usdc, current_value_usdc, liquidation_value_usdc, realized_pnl,
            status, opened_at, updated_at)
         VALUES (?, ?, 'cond-1', 'buy', 8, 0.3125, 2.5, 2.5, 1.75, 4, 'open', ?, ?)`,
      )
      .run(positionId, token, "2026-08-05T09:00:00.000Z", "2026-08-05T09:00:00.000Z");

    conn.db
      .prepare(
        `INSERT INTO orders
           (order_id, client_order_id, token_id, condition_id, side, order_type,
            price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at)
         VALUES ('ord-spent', 'coid-spent', ?, 'cond-1', 'buy', 'GTC', 0.3125, 8, 2.5, 'filled',
                 'probe-entry', 'run-1', '2026-08-05T09:00:00.000Z', '2026-08-05T09:00:00.000Z')`,
      )
      .run(token);
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-spent', 'ord-spent', ?, 'cond-1', 'buy', 0.3125, 8, 2.5, '2026-08-05T09:00:00.000Z')`,
      )
      .run(token);

    // remaining_size = 0 on every lot of the token, so rebuildTokenPosition takes the
    // "no remaining lots -> retire everything" early return. The lot also FK-pins the
    // CLOSE branch: a DELETE here raises SQLITE_CONSTRAINT_FOREIGNKEY and aborts the boot.
    conn.db
      .prepare(
        `INSERT INTO inventory_lots
           (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
         VALUES ('lot-spent', ?, ?, 'buy', 8, 0, 0.3125, 2.5, 'fill-spent', '2026-08-05T09:00:00.000Z')`,
      )
      .run(positionId, token);
    conn.db
      .prepare(
        `INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at)
         VALUES ('fill-spent', ?, 0.75, '2026-08-05T09:30:00.000Z')`,
      )
      .run(positionId);

    insertSyntheticOrder(conn.db, token, "ord-retire-trigger");
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-retire-trigger', 'ord-retire-trigger', ?, 'cond-1', 'sell', 0.02, 1, 0.02, '2026-08-05T11:00:00.000Z')`,
      )
      .run(token);

    expect(() => cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db))).not.toThrow();

    const retired = conn.db
      .prepare(
        `SELECT status, size, cost_basis_usdc, current_value_usdc, liquidation_value_usdc,
                realized_pnl
           FROM positions WHERE position_id = ?`,
      )
      .get(positionId) as {
      status: string;
      size: number;
      cost_basis_usdc: number;
      current_value_usdc: number;
      liquidation_value_usdc: number;
      realized_pnl: number;
    };
    expect(retired.status).toBe("closed");
    expect(retired.size).toBe(0);
    expect(retired.cost_basis_usdc).toBe(0);
    expect(retired.current_value_usdc).toBe(0);
    // Zero, not the seeded 1.75 — a closed husk must not keep reporting a liquidatable value.
    expect(retired.liquidation_value_usdc).toBe(0);
    // 0.75 from the one surviving pnl_ledger row — NOT the seeded 4, which no ledger
    // row backs any more and which readClosedWinrate would have scored as a win.
    expect(retired.realized_pnl).toBeCloseTo(0.75, 10);

    expect(rowExists(conn.db, "inventory_lots", "lot_id", "lot-spent")).toBe(true);
  });

  // The three tests below each seed EXACTLY ONE of retirePositions' three `NOT EXISTS`
  // guards (inventory_lots / pnl_ledger / settlement_ledger) — no lot+pnl double cover like
  // the fixture above, so each one individually pins its guard: deleting that guard's clause
  // from production (and no other change) flips that test's "still closed" assertion to a
  // failed lookup, because the DELETE would then go through.

  it("retirePositions DELETE guard: a fully-consumed inventory_lots row alone blocks deletion", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const token = "tok-guard-lot-only";
    const positionId = "pos-guard-lot-only";

    conn.db
      .prepare(
        `INSERT INTO positions
           (position_id, token_id, condition_id, side, size, avg_entry_price,
            cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, updated_at)
         VALUES (?, ?, 'cond-1', 'buy', 8, 0.3125, 2.5, 2.5, 0, 'open', ?, ?)`,
      )
      .run(positionId, token, "2026-08-05T09:00:00.000Z", "2026-08-05T09:00:00.000Z");

    // inventory_lots.fill_id FKs to fills(fill_id), which FKs to orders(order_id).
    conn.db
      .prepare(
        `INSERT INTO orders
           (order_id, client_order_id, token_id, condition_id, side, order_type,
            price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at)
         VALUES ('ord-guard-lot', 'coid-guard-lot', ?, 'cond-1', 'buy', 'GTC', 0.3125, 8, 2.5, 'filled',
                 'probe-entry', 'run-1', '2026-08-05T09:00:00.000Z', '2026-08-05T09:00:00.000Z')`,
      )
      .run(token);
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-guard-lot', 'ord-guard-lot', ?, 'cond-1', 'buy', 0.3125, 8, 2.5, '2026-08-05T09:00:00.000Z')`,
      )
      .run(token);

    // No pnl_ledger row and no settlement_ledger row at all — the fully-consumed lot below
    // is the ONLY thing that can be keeping the DELETE from firing.
    conn.db
      .prepare(
        `INSERT INTO inventory_lots
           (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
         VALUES ('lot-guard-lot', ?, ?, 'buy', 8, 0, 0.3125, 2.5, 'fill-guard-lot', '2026-08-05T09:00:00.000Z')`,
      )
      .run(positionId, token);

    insertSyntheticOrder(conn.db, token, "ord-guard-lot-trigger");
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-guard-lot-trigger', 'ord-guard-lot-trigger', ?, 'cond-1', 'sell', 0.02, 1, 0.02, '2026-08-05T11:00:00.000Z')`,
      )
      .run(token);

    expect(() => cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db))).not.toThrow();

    expect(rowExists(conn.db, "positions", "position_id", positionId)).toBe(true);
    expect(rowExists(conn.db, "inventory_lots", "lot_id", "lot-guard-lot")).toBe(true);
  });

  it("retirePositions DELETE guard: a pnl_ledger row alone (no inventory_lots row at all) blocks deletion", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const token = "tok-guard-pnl-only";
    const positionId = "pos-guard-pnl-only";

    conn.db
      .prepare(
        `INSERT INTO positions
           (position_id, token_id, condition_id, side, size, avg_entry_price,
            cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, updated_at)
         VALUES (?, ?, 'cond-1', 'buy', 0, 0, 0, 0, 1.1, 'open', ?, ?)`,
      )
      .run(positionId, token, "2026-08-05T09:00:00.000Z", "2026-08-05T09:00:00.000Z");

    // pnl_ledger.fill_id FKs to fills(fill_id), which FKs to orders(order_id). No
    // inventory_lots row is created from this fill (deliberately — this fixture pins the
    // pnl_ledger clause alone), so no lot references it.
    conn.db
      .prepare(
        `INSERT INTO orders
           (order_id, client_order_id, token_id, condition_id, side, order_type,
            price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at)
         VALUES ('ord-guard-pnl', 'coid-guard-pnl', ?, 'cond-1', 'sell', 'GTC', 0.55, 4, 2.2, 'filled',
                 'probe-entry', 'run-1', '2026-08-05T09:30:00.000Z', '2026-08-05T09:30:00.000Z')`,
      )
      .run(token);
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-guard-pnl', 'ord-guard-pnl', ?, 'cond-1', 'sell', 0.55, 4, 2.2, '2026-08-05T09:30:00.000Z')`,
      )
      .run(token);

    // No inventory_lots row at all (not even a consumed one) and no settlement_ledger — the
    // pnl_ledger row below is the ONLY thing that can be keeping the DELETE from firing.
    conn.db
      .prepare(
        `INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at)
         VALUES ('fill-guard-pnl', ?, 1.1, '2026-08-05T09:30:00.000Z')`,
      )
      .run(positionId);

    insertSyntheticOrder(conn.db, token, "ord-guard-pnl-trigger");
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-guard-pnl-trigger', 'ord-guard-pnl-trigger', ?, 'cond-1', 'sell', 0.02, 1, 0.02, '2026-08-05T11:00:00.000Z')`,
      )
      .run(token);

    expect(() => cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db))).not.toThrow();

    const retired = conn.db
      .prepare(`SELECT status, realized_pnl FROM positions WHERE position_id = ?`)
      .get(positionId) as { status: string; realized_pnl: number } | undefined;
    expect(retired?.status).toBe("closed");
    // Recomputed from the surviving pnl_ledger row, confirming it's still there post-retire.
    expect(retired?.realized_pnl).toBeCloseTo(1.1, 10);
    expect(rowExists(conn.db, "pnl_ledger", "fill_id", "fill-guard-pnl")).toBe(true);
  });

  it("retirePositions DELETE guard: a settlement_ledger row alone (no inventory_lots, no pnl_ledger) blocks deletion", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const token = "tok-guard-settlement-only";
    const positionId = "pos-guard-settlement-only";

    // Status must be non-'closed' to reach retirePositions at all (an already-closed
    // position sits outside openRows and is never picked up for retirement). A NOT-closed
    // position already holding a settlement_ledger row can't occur in production — settleAll
    // always closes what it settles first — but the DELETE guard checks the clause
    // unconditionally, so seed it directly to pin that clause in isolation.
    conn.db
      .prepare(
        `INSERT INTO positions
           (position_id, token_id, condition_id, side, size, avg_entry_price,
            cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, updated_at)
         VALUES (?, ?, 'cond-1', 'buy', 0, 0, 0, 0, 0, 'open', ?, ?)`,
      )
      .run(positionId, token, "2026-08-05T09:00:00.000Z", "2026-08-05T09:00:00.000Z");

    // settlement_ledger.condition_id FKs to market_resolutions(condition_id).
    conn.db
      .prepare(
        `INSERT INTO market_resolutions (condition_id, resolution, resolved_at, detected_at, source)
         VALUES ('cond-1', 'YES', '2026-08-05T09:40:00.000Z', '2026-08-05T09:40:00.000Z', 'gamma')`,
      )
      .run();

    // No inventory_lots row and no pnl_ledger row — the settlement row below is the ONLY
    // thing that can be keeping the DELETE from firing.
    conn.db
      .prepare(
        `INSERT INTO settlement_ledger
           (settlement_id, condition_id, position_id, token_id, resolution, settlement_price, size, delta, settled_at)
         VALUES ('settle-guard', 'cond-1', ?, ?, 'YES', 1, 0, 0.5, '2026-08-05T09:45:00.000Z')`,
      )
      .run(positionId, token);

    insertSyntheticOrder(conn.db, token, "ord-guard-settlement-trigger");
    conn.db
      .prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
         VALUES ('fill-guard-settlement-trigger', 'ord-guard-settlement-trigger', ?, 'cond-1', 'sell', 0.02, 1, 0.02, '2026-08-05T11:00:00.000Z')`,
      )
      .run(token);

    expect(() => cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db))).not.toThrow();

    expect(rowExists(conn.db, "positions", "position_id", positionId)).toBe(true);
    expect(rowExists(conn.db, "settlement_ledger", "settlement_id", "settle-guard")).toBe(true);
  });

  it("merges an already-CLOSED sibling's partially consumed lot together with the realized rows that consumed it", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const token = "tok-closed-sibling";
    const closedSiblingId = "pos-cs-closed";
    const winnerId = "pos-cs-winner";

    // A CLOSED position that still owns a LIVE lot is an ordinary state, not a
    // corruption: reconciliation force-closes a position that vanished remotely
    // without touching its lots, bootstrap's unique-open repair and migration 032
    // close duplicate opens the same way, and resolution recovery searches for
    // exactly this shape. It is therefore invisible to the `status != 'closed'`
    // scan yet fully inside the token-wide lot scan.
    conn.db
      .prepare(
        `INSERT INTO positions
           (position_id, token_id, condition_id, side, size, avg_entry_price,
            cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, closed_at, updated_at)
         VALUES (?, ?, 'cond-1', 'buy', 4, 0.35, 1.4, 1.4, 1.2, 'closed', ?, ?, ?)`,
      )
      .run(
        closedSiblingId,
        token,
        "2026-08-05T09:00:00.000Z",
        "2026-08-05T09:45:00.000Z",
        "2026-08-05T09:45:00.000Z",
      );
    conn.db
      .prepare(
        `INSERT INTO positions
           (position_id, token_id, condition_id, side, size, avg_entry_price,
            cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, updated_at)
         VALUES (?, ?, 'cond-1', 'buy', 0, 0, 0, 0, 0, 'dust', ?, ?)`,
      )
      .run(winnerId, token, "2026-08-05T10:00:00.000Z", "2026-08-05T10:00:00.000Z");

    const insertOrder = conn.db.prepare(
      `INSERT INTO orders
         (order_id, client_order_id, token_id, condition_id, side, order_type,
          price, size, size_usdc, status, signal_reason, bot_run_id, position_id, created_at, updated_at)
       VALUES (?, ?, ?, 'cond-1', ?, 'GTC', ?, ?, ?, 'filled', 'probe-entry', 'run-1', ?, ?, ?)`,
    );
    const insertFill = conn.db.prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
       VALUES (?, ?, ?, 'cond-1', ?, ?, ?, ?, ?)`,
    );
    const older = "2026-08-05T09:00:00.000Z";
    insertOrder.run(
      "ord-cs-buy10",
      "coid-cs-buy10",
      token,
      "buy",
      0.35,
      10,
      3.5,
      closedSiblingId,
      older,
      older,
    );
    insertFill.run("fill-cs-buy10", "ord-cs-buy10", token, "buy", 0.35, 10, 3.5, older);
    insertOrder.run(
      "ord-cs-sell6",
      "coid-cs-sell6",
      token,
      "sell",
      0.55,
      6,
      3.3,
      closedSiblingId,
      older,
      older,
    );
    insertFill.run(
      "fill-cs-sell6",
      "ord-cs-sell6",
      token,
      "sell",
      0.55,
      6,
      3.3,
      "2026-08-05T09:30:00.000Z",
    );

    conn.db
      .prepare(
        `INSERT INTO inventory_lots
           (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
         VALUES ('lot-cs', ?, ?, 'buy', 10, 4, 0.35, 3.5, 'fill-cs-buy10', ?)`,
      )
      .run(closedSiblingId, token, older);
    conn.db
      .prepare(
        `INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at)
         VALUES ('fill-cs-sell6', ?, 1.2, '2026-08-05T09:30:00.000Z')`,
      )
      .run(closedSiblingId);

    insertSyntheticOrder(conn.db, token, "ord-cs-trigger");
    insertFill.run(
      "fill-cs-trigger",
      "ord-cs-trigger",
      token,
      "sell",
      0.02,
      1,
      0.02,
      "2026-08-05T11:00:00.000Z",
    );

    expect(() => cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db))).not.toThrow();

    // Moving the live lot alone — which is what a token-wide `remaining_size > 0`
    // reparent does — hands the winner a 10-share BUY (loadBuyRows carries fills.size,
    // never remaining_size) while the SELL that consumed 6 of it stays on the sibling.
    // Both halves must land on the same position or the round trip is split in two.
    const lotOwner = conn.db
      .prepare(`SELECT position_id FROM inventory_lots WHERE lot_id = 'lot-cs'`)
      .get() as { position_id: string } | undefined;
    expect(lotOwner?.position_id).toBe(winnerId);
    const realizedOwner = conn.db
      .prepare(`SELECT position_id FROM pnl_ledger WHERE fill_id = 'fill-cs-sell6'`)
      .get() as { position_id: string } | undefined;
    expect(realizedOwner?.position_id).toBe(winnerId);

    const winner = conn.db
      .prepare(`SELECT size, cost_basis_usdc, realized_pnl FROM positions WHERE position_id = ?`)
      .get(winnerId) as { size: number; cost_basis_usdc: number; realized_pnl: number };
    expect(winner.size).toBe(4);
    expect(winner.cost_basis_usdc).toBeCloseTo(1.4, 10);
    expect(winner.realized_pnl).toBeCloseTo(1.2, 10);

    // Emptied by the merge and pinned by nothing but terminal orders, so the sibling
    // goes rather than lingering with a basis and a realized total it no longer backs.
    expect(rowExists(conn.db, "positions", "position_id", closedSiblingId)).toBe(false);
  });

  it("deletes a retired position pinned by nothing but a WORKING order — orders.position_id has no FK and does not block the DELETE guard", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const token = "tok-working-order-pin";
    const loserId = "pos-wp-loser";
    const winnerId = "pos-wp-winner";

    const insertPosition = conn.db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, updated_at)
       VALUES (?, ?, 'cond-1', 'buy', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const older = "2026-08-05T09:00:00.000Z";
    const newer = "2026-08-05T10:00:00.000Z";
    // Seeded basis and realized total are STALE: both are handed to the winner below.
    insertPosition.run(loserId, token, 4, 0.35, 3.5, 3.5, 9.9, "open", older, older);
    insertPosition.run(winnerId, token, 0, 0, 0, 0, 0, "dust", newer, newer);

    const insertOrder = conn.db.prepare(
      `INSERT INTO orders
         (order_id, client_order_id, token_id, condition_id, side, order_type,
          price, size, size_usdc, status, signal_reason, bot_run_id, position_id, created_at, updated_at)
       VALUES (?, ?, ?, 'cond-1', ?, 'GTC', ?, ?, ?, ?, 'probe-entry', 'run-1', ?, ?, ?)`,
    );
    const insertFill = conn.db.prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
       VALUES (?, ?, ?, 'cond-1', ?, ?, ?, ?, ?)`,
    );
    insertOrder.run(
      "ord-wp-buy10",
      "coid-wp-buy10",
      token,
      "buy",
      0.35,
      10,
      3.5,
      "filled",
      loserId,
      older,
      older,
    );
    insertFill.run("fill-wp-buy10", "ord-wp-buy10", token, "buy", 0.35, 10, 3.5, older);
    // The live exit the executor is still servicing on this position. `orders.position_id`
    // (088_orders_position_id.sql) declares no FK, so it can't block the DELETE — and I2
    // only requires the pointed-to position to be `status <> 'closed'`, which a MISSING row
    // satisfies exactly as trivially as a present-but-open one. This order does not pin it.
    insertOrder.run(
      "ord-wp-working",
      "coid-wp-working",
      token,
      "sell",
      0.55,
      4,
      2.2,
      "open",
      loserId,
      older,
      older,
    );

    conn.db
      .prepare(
        `INSERT INTO inventory_lots
           (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
         VALUES ('lot-wp', ?, ?, 'buy', 10, 4, 0.35, 3.5, 'fill-wp-buy10', ?)`,
      )
      .run(loserId, token, older);
    conn.db
      .prepare(
        `INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at)
         VALUES ('fill-wp-buy10', ?, 0.8, '2026-08-05T09:30:00.000Z')`,
      )
      .run(loserId);

    insertSyntheticOrder(conn.db, token, "ord-wp-trigger");
    insertFill.run(
      "fill-wp-trigger",
      "ord-wp-trigger",
      token,
      "sell",
      0.02,
      1,
      0.02,
      "2026-08-05T11:00:00.000Z",
    );

    expect(() => cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db))).not.toThrow();

    // Merge hands the lot and the pnl_ledger row to the winner, leaving the loser pinned by
    // NOTHING the DELETE guard checks — so it is deleted outright, not kept as a closed husk.
    expect(rowExists(conn.db, "positions", "position_id", loserId)).toBe(false);

    // The working order survives with its position_id now dangling — orders.position_id has
    // no FK, so the DELETE didn't (and couldn't) cascade into it. The P6 fence drains orders
    // like this one later; that cleanup is out of scope for this test.
    const workingOrder = conn.db
      .prepare(`SELECT status, position_id FROM orders WHERE order_id = 'ord-wp-working'`)
      .get() as { status: string; position_id: string } | undefined;
    expect(workingOrder?.status).toBe("open");
    expect(workingOrder?.position_id).toBe(loserId);

    const winner = conn.db
      .prepare(`SELECT size, cost_basis_usdc, realized_pnl FROM positions WHERE position_id = ?`)
      .get(winnerId) as { size: number; cost_basis_usdc: number; realized_pnl: number };
    expect(winner.size).toBe(4);
    expect(winner.cost_basis_usdc).toBeCloseTo(1.4, 10);
    expect(winner.realized_pnl).toBeCloseTo(0.8, 10);
  });

  /**
   * The ordering the test above cannot show, because it stops at the cleanup: on a census-owned
   * ledger the consolidation's dangling SELL reaches the boot's ownership gate as an I2, and that
   * gate runs BEFORE the P6 drain that cancels it. Both directions are pinned here — deferring the
   * exact quarantined order, and hard-stopping on the same row when nobody is draining it — so the
   * tolerance cannot later widen into "ignore I2".
   */
  it("boot gate defers the consolidation's dangling SELL only for the exact order the startup drain quarantined", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const control = bootstrapControlDb(":memory:");
    connections.push(control);
    control.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();

    const token = "tok-drain-defer";
    const loserId = "pos-dd-loser";
    const winnerId = "pos-dd-winner";
    const workingOrderId = "ord-dd-working";
    const older = "2026-08-05T09:00:00.000Z";
    const newer = "2026-08-05T10:00:00.000Z";

    // Census-assigned owners on BOTH rows — the state a bounce-for-all ledger is actually in, and
    // the only state in which the gate below runs at all.
    const insertPosition = conn.db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, current_value_usdc, realized_pnl, status, exit_owner, opened_at, updated_at)
       VALUES (?, ?, 'cond-1', 'buy', ?, ?, ?, ?, 0, ?, 'profile', ?, ?)`,
    );
    insertPosition.run(loserId, token, 4, 0.35, 3.5, 3.5, "open", older, older);
    insertPosition.run(winnerId, token, 0, 0, 0, 0, "dust", newer, newer);

    const insertOrder = conn.db.prepare(
      `INSERT INTO orders
         (order_id, client_order_id, token_id, condition_id, side, order_type, price, size,
          size_usdc, status, signal_reason, decision_rule_id, bot_run_id, position_id, created_at, updated_at)
       VALUES (?, ?, ?, 'cond-1', ?, 'GTC', ?, ?, ?, ?, 'probe-entry', 'PROFILE_LADDER', 'run-1', ?, ?, ?)`,
    );
    const insertFill = conn.db.prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
       VALUES (?, ?, ?, 'cond-1', ?, ?, ?, ?, ?)`,
    );
    insertOrder.run(
      "ord-dd-buy10",
      "coid-dd-buy10",
      token,
      "buy",
      0.35,
      10,
      3.5,
      "filled",
      loserId,
      older,
      older,
    );
    insertFill.run("fill-dd-buy10", "ord-dd-buy10", token, "buy", 0.35, 10, 3.5, older);
    // Sized to the merged inventory exactly, so I3 stays clean and I2 is the single class under test.
    insertOrder.run(
      workingOrderId,
      "coid-dd-working",
      token,
      "sell",
      0.55,
      4,
      2.2,
      "open",
      loserId,
      older,
      older,
    );

    conn.db
      .prepare(
        `INSERT INTO inventory_lots
           (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
         VALUES ('lot-dd', ?, ?, 'buy', 10, 4, 0.35, 3.5, 'fill-dd-buy10', ?)`,
      )
      .run(loserId, token, older);

    insertSyntheticOrder(conn.db, token, "ord-dd-trigger");
    insertFill.run(
      "fill-dd-trigger",
      "ord-dd-trigger",
      token,
      "sell",
      0.02,
      1,
      0.02,
      "2026-08-05T11:00:00.000Z",
    );

    cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db));
    expect(rowExists(conn.db, "positions", "position_id", loserId)).toBe(false);

    // The RAW read is untouched — the census and the API gate must keep seeing the real ledger.
    const raw = readOwnershipInvariantViolations(conn.db);
    expect(raw.counts.stalePointerSells).toBe(1);
    expect(raw.rows.stalePointerSells.map((r) => r.order_id)).toEqual([workingOrderId]);

    const bootGate = (drainedOrderIds?: ReadonlySet<string>) => () =>
      runOwnershipInvariantStartupGate({
        ledgerDb: conn.db,
        controlDb: control.db,
        applyToAllMarkets: true,
        log: silentLog,
        // Spread rather than a plain assignment: `exactOptionalPropertyTypes` distinguishes
        // "absent" from "explicitly undefined", and the no-argument case must be the former.
        ...(drainedOrderIds ? { drainedOrderIds } : {}),
      });

    expect(bootGate(new Set([workingOrderId]))).not.toThrow();
    // Same row, nobody draining it → the pre-existing hard-stop, unchanged.
    expect(bootGate(new Set())).toThrow(BounceForAllNullOwnerError);
    expect(bootGate(undefined)).toThrow(BounceForAllNullOwnerError);
    // A drained id that is NOT the offending one buys the offender nothing.
    expect(bootGate(new Set(["ord-dd-some-other"]))).toThrow(BounceForAllNullOwnerError);

    const readOrderStatus = (orderId: string) =>
      (
        conn.db.prepare("SELECT status FROM orders WHERE order_id = ?").get(orderId) as
          | { status: string }
          | undefined
      )?.status;
    const fenceGate = (isTransitionTarget: () => boolean) => () =>
      runDrainedOrderFenceGate({
        controlDb: control.db,
        drainedOrderIds: new Set([workingOrderId]),
        readOrderStatus,
        isTransitionTarget,
        log: silentLog,
      });

    // The deferral is only honest if the barrier really took the order before the fence lifts.
    expect(fenceGate(() => false)).toThrow(DrainedOrderUnfencedError);
    expect(fenceGate(() => true)).not.toThrow();

    // A confirmed cancel removes it from the active-SELL relation, so no barrier is owed.
    conn.db
      .prepare("UPDATE orders SET status = 'cancelled' WHERE order_id = ?")
      .run(workingOrderId);
    expect(fenceGate(() => false)).not.toThrow();
  });

  it("T26 — startup adoption rolls back its real SQLite reconciliation claim when inventory application throws", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    seedMarket(marketRepo);
    const originalSave = positionRepo.save.bind(positionRepo);
    positionRepo.save = vi.fn((_position) => {
      const row = conn.db
        .prepare("SELECT reconciled FROM fills WHERE fill_id = ?")
        .get("fill-t26") as { reconciled: number } | undefined;
      expect(row?.reconciled).toBe(1);
      throw new Error("injected inventory failure");
    });

    const result = await runStartupPositionAdoption({
      gateway: {
        getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getFillsResult: vi
          .fn()
          .mockResolvedValue({ ok: true, data: [makeExchangeFill({ fillId: "fill-t26" })] }),
      },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-t26"),
    });

    expect(result.skippedInventoryDrift).toBe(1);
    expect(result.appliedFills).toBe(0);
    expect(fillRepo.findUnreconciled().map((fill) => String(fill.fillId))).toEqual(["fill-t26"]);
    expect(positionRepo.findOpen()).toHaveLength(0);
    positionRepo.save = originalSave;
  });
});
