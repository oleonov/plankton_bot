/**
 * Exposure-formula parity test.
 *
 * Two code paths currently compute live-lite "open exposure":
 *
 *   1. Runtime (ExecutionModule):
 *      `calculateTotalExposure(positionRepo, orderRepo, additionalNotional)`
 *      — see `apps/runtime/src/exposure-calculator.ts`.
 *
 *   2. Preflight (ProfilePreflight):
 *      raw SQL in `apps/runtime/src/profile-preflight.ts runLiveLiteChecks`:
 *        SELECT SUM(cost_basis_usdc) FROM positions WHERE status IN ('open','dust')
 *        SELECT SUM(size_usdc)      FROM orders    WHERE side = 'buy' AND status IN
 *                                                       ('open','pending','partially-filled')
 *
 * These are expected to produce byte-identical results against the same
 * ledger. If they drift, preflight becomes a one-shot check that cannot
 * protect against post-launch cap violations (or, inversely, blocks startup
 * under a cap that runtime still respects). ADR-009 identifies this drift
 * risk; this test guards against it.
 *
 * The test builds a small in-memory ledger with a mix of:
 *   - open and closed positions
 *   - buy/sell orders across every status
 *   - one position that is closed but has a matching open buy order (edge
 *     case: open BUY notional counts even when the underlying position is
 *     closed — it is still reserved wallet)
 *   - positions with zero-size / dust (status = 'dust' → excluded)
 *
 * The reference SQL below is copied verbatim from profile-preflight.ts and
 * must be updated together with it. If preflight changes its query shape,
 * this test fails until the reference here is updated — forcing the
 * reviewer to confirm the runtime helper still agrees.
 */

import { describe, expect, it, afterEach } from "vitest";
import { bootstrapDatabase, SqlitePositionRepository, SqliteOrderRepository } from "@krabs/db";
import type { Order, Position, OrderStatus } from "@krabs/domain";
import {
  createBotRunId,
  createConditionId,
  createOrderId,
  createPositionId,
  createTokenId,
  type ClientOrderId,
} from "@krabs/domain";
import { calculateTotalExposure } from "../exposure-calculator.js";

// ─── Reference SQL — MUST stay in lock-step with profile-preflight.ts ────────

function preflightExposure(db: import("better-sqlite3").Database): number {
  const pos = db
    .prepare(
      "SELECT COALESCE(SUM(cost_basis_usdc), 0) as total FROM positions WHERE status IN ('open','dust')",
    )
    .get() as { total: number };
  const buy = db
    .prepare(
      "SELECT COALESCE(SUM(size_usdc), 0) as total FROM orders " +
        "WHERE side = 'buy' AND status IN ('open','pending','partially-filled')",
    )
    .get() as { total: number };
  return pos.total + buy.total;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
function nextId(): string {
  seq++;
  return `parity-${seq}`;
}

function makeOpenPosition(overrides: Partial<Position> = {}): Position {
  const id = nextId();
  const now = new Date().toISOString();
  return {
    positionId: createPositionId(`pos-${id}`),
    tokenId: createTokenId(`tok-${id}`),
    conditionId: createConditionId(`cond-${id}`),
    side: "buy",
    size: 10,
    avgEntryPrice: 0.5,
    costBasisUsdc: 5,
    currentValueUsdc: 5,
    realizedPnl: 0,
    status: "open",
    entryStyle: "probe",
    openedAt: now,
    closedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

function makeOpenBuyOrder(overrides: Partial<Order> = {}): Order {
  const id = nextId();
  const now = new Date().toISOString();
  return {
    orderId: createOrderId(`ord-${id}`),
    clientOrderId: `cloid-${id}` as ClientOrderId,
    tokenId: createTokenId(`tok-${id}`),
    conditionId: createConditionId(`cond-${id}`),
    side: "buy",
    orderType: "GTC",
    postOnly: false,
    price: 0.4,
    size: 10,
    sizeUsdc: 4,
    status: "open",
    exchangeOrderId: null,
    signalId: null,
    signalReason: null,
    botRunId: createBotRunId("parity-run"),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─── Test ────────────────────────────────────────────────────────────────────

describe("exposure formula parity (runtime helper ↔ preflight SQL)", () => {
  const connections: Array<ReturnType<typeof bootstrapDatabase>> = [];

  afterEach(() => {
    while (connections.length > 0) {
      connections.pop()!.close();
    }
  });

  function open(): {
    db: import("better-sqlite3").Database;
    positionRepo: SqlitePositionRepository;
    orderRepo: SqliteOrderRepository;
  } {
    const conn = bootstrapDatabase(":memory:");
    connections.push(conn);
    return {
      db: conn.db,
      positionRepo: new SqlitePositionRepository(conn.db),
      orderRepo: new SqliteOrderRepository(conn.db),
    };
  }

  it("empty ledger: both paths return 0", () => {
    const { db, positionRepo, orderRepo } = open();
    expect(calculateTotalExposure(positionRepo, orderRepo)).toBe(0);
    expect(preflightExposure(db)).toBe(0);
  });

  it("open positions only — both agree", () => {
    const { db, positionRepo, orderRepo } = open();
    positionRepo.save(makeOpenPosition({ costBasisUsdc: 7.5 }));
    positionRepo.save(makeOpenPosition({ costBasisUsdc: 2.25 }));
    positionRepo.save(makeOpenPosition({ costBasisUsdc: 10.5 }));

    const runtime = calculateTotalExposure(positionRepo, orderRepo);
    const preflight = preflightExposure(db);
    expect(runtime).toBe(preflight);
    expect(runtime).toBeCloseTo(20.25, 5);
  });

  it("open buy orders only — both agree", () => {
    const { db, positionRepo, orderRepo } = open();
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 3, status: "open" }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 1.5, status: "pending" }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 2.75, status: "partially-filled" }));

    const runtime = calculateTotalExposure(positionRepo, orderRepo);
    const preflight = preflightExposure(db);
    expect(runtime).toBe(preflight);
    expect(runtime).toBeCloseTo(7.25, 5);
  });

  it("closed positions and filled/cancelled orders are excluded; dust remains active exposure", () => {
    const { db, positionRepo, orderRepo } = open();

    // Real contributors
    positionRepo.save(makeOpenPosition({ costBasisUsdc: 5 }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 3, status: "open" }));

    // Non-contributors
    positionRepo.save(
      makeOpenPosition({
        costBasisUsdc: 999,
        status: "closed",
        closedAt: new Date().toISOString(),
      }),
    );
    // Dust is still live wallet inventory and remains part of exposure.
    positionRepo.save(makeOpenPosition({ costBasisUsdc: 999, status: "dust" }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 999, status: "filled" as OrderStatus }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 999, status: "cancelled" as OrderStatus }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 999, status: "rejected" as OrderStatus }));

    const runtime = calculateTotalExposure(positionRepo, orderRepo);
    const preflight = preflightExposure(db);
    expect(runtime).toBe(preflight);
    expect(runtime).toBeCloseTo(1007, 5); // 5 open + 999 dust + 3 open buy
  });

  it("open and dust rows sharing the same token both contribute to exposure", () => {
    // Migration 032's partial unique index allows one `open` row to coexist with dust rows on the
    // SAME token — capital at risk is the sum over every non-closed row, not one winner per token.
    // Regression guard for calculateTotalExposure/findActivePositionRows (apps/runtime/src/
    // exposure-calculator.ts, active-positions.ts): a dedup back to one row per token would silently
    // drop the dust row's cost basis and under-report exposure.
    const { db, positionRepo, orderRepo } = open();
    const sharedToken = createTokenId(`tok-shared-${nextId()}`);

    positionRepo.save(makeOpenPosition({ tokenId: sharedToken, costBasisUsdc: 5 }));
    positionRepo.save(makeOpenPosition({ tokenId: sharedToken, costBasisUsdc: 3, status: "dust" }));

    const runtime = calculateTotalExposure(positionRepo, orderRepo);
    const preflight = preflightExposure(db);
    expect(runtime).toBe(preflight);
    expect(runtime).toBeCloseTo(8, 5);
  });

  it("sell orders are excluded from exposure", () => {
    const { db, positionRepo, orderRepo } = open();
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 4, status: "open" }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 999, side: "sell", status: "open" }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 999, side: "sell", status: "partially-filled" }));

    const runtime = calculateTotalExposure(positionRepo, orderRepo);
    const preflight = preflightExposure(db);
    expect(runtime).toBe(preflight);
    expect(runtime).toBeCloseTo(4, 5);
  });

  it("additionalNotional parameter adds only on the runtime side — test parity against preflight+delta", () => {
    const { db, positionRepo, orderRepo } = open();
    positionRepo.save(makeOpenPosition({ costBasisUsdc: 10 }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 5, status: "open" }));

    const runtimeWithCandidate = calculateTotalExposure(positionRepo, orderRepo, 2.5);
    const preflightBase = preflightExposure(db);

    // Preflight does not know about a candidate order — that is the runtime's
    // job. Invariant: runtime(base, candidate) === preflight(base) + candidate.
    expect(runtimeWithCandidate).toBeCloseTo(preflightBase + 2.5, 5);
  });

  it("combined mixed ledger — byte-identical", () => {
    const { db, positionRepo, orderRepo } = open();

    positionRepo.save(makeOpenPosition({ costBasisUsdc: 0.01 }));
    positionRepo.save(makeOpenPosition({ costBasisUsdc: 12.345 }));
    positionRepo.save(makeOpenPosition({ costBasisUsdc: 100 }));
    positionRepo.save(makeOpenPosition({ costBasisUsdc: 50, status: "closed" }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 0.5, status: "pending" }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 4.4, status: "open" }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 7.77, status: "partially-filled" }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 200, status: "filled" as OrderStatus }));
    orderRepo.save(makeOpenBuyOrder({ sizeUsdc: 200, side: "sell", status: "open" }));

    const runtime = calculateTotalExposure(positionRepo, orderRepo);
    const preflight = preflightExposure(db);
    expect(runtime).toBe(preflight);
  });
});
