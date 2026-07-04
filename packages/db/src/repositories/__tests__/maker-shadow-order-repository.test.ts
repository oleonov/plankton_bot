import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapLedgerDb } from "../../bootstrap.js";
import type { DbConnection } from "../../connection.js";
import { SqliteMakerShadowOrderRepository } from "../maker-shadow-order-repository.js";
import type { MakerShadowOrder } from "@krabs/domain";
import { createTokenId } from "@krabs/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteMakerShadowOrderRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-maker-shadow-"));
  conn = bootstrapLedgerDb(path.join(tmpDir, "ledger.db"));
  repo = new SqliteMakerShadowOrderRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeOrder(overrides: Partial<MakerShadowOrder> = {}): MakerShadowOrder {
  return {
    shadowOrderId: "abc123def456abc123def456abc123de",
    tokenId: createTokenId("tok-1"),
    conditionId: "cond-1",
    buyPx: 0.31,
    harvestPx: 0.47,
    postedAt: "2026-07-04T10:00:00.000Z",
    fillDeadline: "2026-07-04T10:05:00.000Z",
    stage: "pending",
    fillKind: null,
    fillPx: null,
    markPx: null,
    netMark: null,
    updatedAt: "2026-07-04T10:00:00.000Z",
    ...overrides,
  };
}

describe("SqliteMakerShadowOrderRepository", () => {
  // ─── upsert + findOpen ─────────────────────────────────────────────────────

  it("persists a pending row and returns it via findOpen", () => {
    const order = makeOrder();
    repo.upsert(order);
    const open = repo.findOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!).toMatchObject({
      shadowOrderId: order.shadowOrderId,
      tokenId: order.tokenId,
      buyPx: 0.31,
      harvestPx: 0.47,
      stage: "pending",
      fillKind: null,
    });
  });

  it("findOpen excludes terminal stages", () => {
    repo.upsert(makeOrder({ shadowOrderId: "pend0001", stage: "pending" }));
    repo.upsert(
      makeOrder({
        shadowOrderId: "fill0001",
        stage: "filled",
        fillKind: "trade_through",
        fillPx: 0.3,
      }),
    );
    repo.upsert(
      makeOrder({ shadowOrderId: "harv0001", stage: "harvested", markPx: 0.47, netMark: 0.516 }),
    );
    repo.upsert(
      makeOrder({ shadowOrderId: "mark0001", stage: "marked", markPx: 0.25, netMark: -0.193 }),
    );
    repo.upsert(makeOrder({ shadowOrderId: "expi0001", stage: "expired" }));

    const open = repo.findOpen();
    const stages = open.map((o) => o.stage);
    expect(stages).toContain("pending");
    expect(stages).toContain("filled");
    expect(stages).not.toContain("harvested");
    expect(stages).not.toContain("marked");
    expect(stages).not.toContain("expired");
  });

  it("findOpenByToken filters to a specific token", () => {
    repo.upsert(makeOrder({ shadowOrderId: "tok1aaaa", tokenId: createTokenId("tok-1") }));
    repo.upsert(makeOrder({ shadowOrderId: "tok2aaaa", tokenId: createTokenId("tok-2") }));

    const forTok1 = repo.findOpenByToken(createTokenId("tok-1"));
    expect(forTok1).toHaveLength(1);
    expect(forTok1[0]!.shadowOrderId).toBe("tok1aaaa");
  });

  it("upsert is idempotent on same shadowOrderId", () => {
    const order = makeOrder();
    repo.upsert(order);
    repo.upsert(order); // no error, single row
    expect(repo.findOpen()).toHaveLength(1);
  });

  // ─── updateStage ───────────────────────────────────────────────────────────

  it("pending → filled (trade_through)", () => {
    repo.upsert(makeOrder());
    repo.updateStage("abc123def456abc123def456abc123de", {
      stage: "filled",
      fillKind: "trade_through",
      fillPx: 0.295,
      updatedAt: "2026-07-04T10:01:00.000Z",
    });
    const row = repo.findOpen()[0]!;
    expect(row.stage).toBe("filled");
    expect(row.fillKind).toBe("trade_through");
    expect(row.fillPx).toBeCloseTo(0.295);
  });

  it("pending → filled (touch)", () => {
    repo.upsert(makeOrder());
    repo.updateStage("abc123def456abc123def456abc123de", {
      stage: "filled",
      fillKind: "touch",
      fillPx: 0.31,
      updatedAt: "2026-07-04T10:01:00.000Z",
    });
    const row = repo.findOpen()[0]!;
    expect(row.fillKind).toBe("touch");
  });

  it("filled → harvested removes row from findOpen", () => {
    repo.upsert(makeOrder({ stage: "filled", fillKind: "trade_through", fillPx: 0.31 }));
    repo.updateStage("abc123def456abc123def456abc123de", {
      stage: "harvested",
      markPx: 0.47,
      netMark: 0.516,
      updatedAt: "2026-07-04T10:03:00.000Z",
    });
    expect(repo.findOpen()).toHaveLength(0);
  });

  it("filled → marked with negative net_mark", () => {
    repo.upsert(makeOrder({ stage: "filled", fillKind: "touch", fillPx: 0.31 }));
    repo.updateStage("abc123def456abc123def456abc123de", {
      stage: "marked",
      markPx: 0.2,
      netMark: -0.355,
      updatedAt: "2026-07-04T10:05:00.000Z",
    });
    const row = conn.db
      .prepare("SELECT * FROM maker_shadow_orders WHERE shadow_order_id = ?")
      .get("abc123def456abc123def456abc123de") as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.stage).toBe("marked");
    expect(row!.mark_px).toBeCloseTo(0.2);
    expect(row!.net_mark).toBeCloseTo(-0.355, 3);
  });

  // ─── pruneExpired ──────────────────────────────────────────────────────────

  it("prunes expired rows older than cutoff and leaves newer ones", () => {
    repo.upsert(
      makeOrder({
        shadowOrderId: "old00001",
        stage: "expired",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    repo.upsert(
      makeOrder({
        shadowOrderId: "new00001",
        stage: "expired",
        updatedAt: "2026-07-04T00:00:00.000Z",
      }),
    );

    const pruned = repo.pruneExpired("2026-07-03T00:00:00.000Z");
    expect(pruned).toBe(1);

    // new00001 should still exist
    const remaining = conn.db
      .prepare("SELECT COUNT(*) as cnt FROM maker_shadow_orders WHERE stage='expired'")
      .get() as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });

  it("does not prune non-expired rows", () => {
    repo.upsert(makeOrder({ shadowOrderId: "pend0001", stage: "pending" }));
    repo.upsert(
      makeOrder({
        shadowOrderId: "fill0001",
        stage: "filled",
        fillKind: "touch",
        fillPx: 0.31,
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
    );
    const pruned = repo.pruneExpired("2026-12-31T00:00:00.000Z");
    expect(pruned).toBe(0);
    expect(repo.findOpen()).toHaveLength(2);
  });

  // ─── pending → filled → harvested lifecycle ────────────────────────────────

  it("full lifecycle: pending → filled → harvested persists correctly", () => {
    repo.upsert(makeOrder());

    // pending → filled
    repo.updateStage("abc123def456abc123def456abc123de", {
      stage: "filled",
      fillKind: "trade_through",
      fillPx: 0.3,
      updatedAt: "2026-07-04T10:01:30.000Z",
    });
    expect(repo.findOpen()[0]!.stage).toBe("filled");

    // filled → harvested
    repo.updateStage("abc123def456abc123def456abc123de", {
      stage: "harvested",
      markPx: 0.47,
      netMark: 0.5667,
      updatedAt: "2026-07-04T10:03:00.000Z",
    });
    expect(repo.findOpen()).toHaveLength(0);

    const row = conn.db
      .prepare("SELECT stage, net_mark FROM maker_shadow_orders WHERE shadow_order_id = ?")
      .get("abc123def456abc123def456abc123de") as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.stage).toBe("harvested");
    expect(Number(row!.net_mark)).toBeCloseTo(0.5667, 3);
  });

  it("fill_kind and fill_px survive the filled → harvested transition", () => {
    repo.upsert(makeOrder());

    repo.updateStage("abc123def456abc123def456abc123de", {
      stage: "filled",
      fillKind: "trade_through",
      fillPx: 0.295,
      updatedAt: "2026-07-04T10:01:00.000Z",
    });

    repo.updateStage("abc123def456abc123def456abc123de", {
      stage: "harvested",
      markPx: 0.47,
      netMark: 0.5667,
      updatedAt: "2026-07-04T10:02:00.000Z",
    });

    const row = conn.db
      .prepare("SELECT * FROM maker_shadow_orders WHERE shadow_order_id = ?")
      .get("abc123def456abc123def456abc123de") as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.fill_kind).toBe("trade_through");
    expect(Number(row!.fill_px)).toBeCloseTo(0.295, 5);
    expect(Number(row!.mark_px)).toBeCloseTo(0.47, 5);
    expect(Number(row!.net_mark)).toBeCloseTo(0.5667, 3);
  });

  it("fill_kind survives a filled → marked transition", () => {
    repo.upsert(makeOrder());

    repo.updateStage("abc123def456abc123def456abc123de", {
      stage: "filled",
      fillKind: "touch",
      fillPx: 0.31,
      updatedAt: "2026-07-04T10:01:00.000Z",
    });

    repo.updateStage("abc123def456abc123def456abc123de", {
      stage: "marked",
      markPx: 0.2,
      netMark: -0.355,
      updatedAt: "2026-07-04T10:05:00.000Z",
    });

    const row = conn.db
      .prepare("SELECT * FROM maker_shadow_orders WHERE shadow_order_id = ?")
      .get("abc123def456abc123def456abc123de") as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.fill_kind).toBe("touch");
  });

  // ─── restart re-hydration ──────────────────────────────────────────────────

  it("open rows survive a re-open of the same DB (re-hydration)", () => {
    // Simulate a restart: write then re-open the DB file
    const dbPath = path.join(tmpDir, "ledger.db");
    conn.close();
    conn = bootstrapLedgerDb(dbPath);
    const repo2 = new SqliteMakerShadowOrderRepository(conn.db);

    repo2.upsert(makeOrder());
    repo2.upsert(
      makeOrder({
        shadowOrderId: "fill1111",
        stage: "filled",
        fillKind: "touch",
        fillPx: 0.31,
      }),
    );

    // Simulate process restart by opening a new repo on the same file
    conn.close();
    conn = bootstrapLedgerDb(dbPath);
    const repo3 = new SqliteMakerShadowOrderRepository(conn.db);

    const open = repo3.findOpen();
    expect(open).toHaveLength(2);
    const stages = open.map((o) => o.stage).sort();
    expect(stages).toEqual(["filled", "pending"]);
  });
});
