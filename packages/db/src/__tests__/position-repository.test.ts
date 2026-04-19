import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqlitePositionRepository } from "../repositories/position-repository.js";
import { createPositionId, createTokenId, createConditionId } from "@plankton/domain";
import type { Position } from "@plankton/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqlitePositionRepository;

function makePosition(overrides?: Partial<Position>): Position {
  const now = new Date().toISOString();
  return {
    positionId: createPositionId("pos-1"),
    tokenId: createTokenId("tok-1"),
    conditionId: createConditionId("cond-1"),
    side: "buy",
    size: 100,
    avgEntryPrice: 0.55,
    costBasisUsdc: 55,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: now,
    closedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqlitePositionRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqlitePositionRepository", () => {
  it("save + findByTokenId round-trip", () => {
    const pos = makePosition();
    repo.save(pos);

    const found = repo.findByTokenId(createTokenId("tok-1"));
    expect(found).not.toBeNull();
    expect(found!.positionId).toBe("pos-1");
    expect(found!.tokenId).toBe("tok-1");
    expect(found!.side).toBe("buy");
    expect(found!.size).toBe(100);
    expect(found!.avgEntryPrice).toBe(0.55);
    expect(found!.costBasisUsdc).toBe(55);
    expect(found!.currentValueUsdc).toBeNull();
    expect(found!.realizedPnl).toBe(0);
    expect(found!.status).toBe("open");
    expect(found!.closedAt).toBeNull();
  });

  it("findOpen returns only open positions", () => {
    repo.save(
      makePosition({
        positionId: createPositionId("p1"),
        tokenId: createTokenId("t1"),
        status: "open",
      }),
    );
    repo.save(
      makePosition({
        positionId: createPositionId("p2"),
        tokenId: createTokenId("t2"),
        status: "closed",
      }),
    );
    repo.save(
      makePosition({
        positionId: createPositionId("p3"),
        tokenId: createTokenId("t3"),
        status: "dust",
      }),
    );

    const open = repo.findOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.positionId).toBe("p1");
  });

  it("findDust returns only dust positions", () => {
    repo.save(
      makePosition({
        positionId: createPositionId("p1"),
        tokenId: createTokenId("t1"),
        status: "open",
      }),
    );
    repo.save(
      makePosition({
        positionId: createPositionId("p2"),
        tokenId: createTokenId("t2"),
        status: "dust",
      }),
    );
    repo.save(
      makePosition({
        positionId: createPositionId("p3"),
        tokenId: createTokenId("t3"),
        status: "dust",
      }),
    );

    const dust = repo.findDust();
    expect(dust).toHaveLength(2);
  });

  it("findAll returns all statuses", () => {
    repo.save(
      makePosition({
        positionId: createPositionId("p1"),
        tokenId: createTokenId("t1"),
        status: "open",
      }),
    );
    repo.save(
      makePosition({
        positionId: createPositionId("p2"),
        tokenId: createTokenId("t2"),
        status: "closed",
      }),
    );
    repo.save(
      makePosition({
        positionId: createPositionId("p3"),
        tokenId: createTokenId("t3"),
        status: "dust",
      }),
    );

    expect(repo.findAll()).toHaveLength(3);
  });

  it("save updates existing position (upsert)", () => {
    repo.save(makePosition({ size: 100 }));
    repo.save(makePosition({ size: 200 }));

    const all = repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.size).toBe(200);
  });

  it("findByTokenId excludes closed positions", () => {
    repo.save(
      makePosition({
        positionId: createPositionId("p-closed"),
        tokenId: createTokenId("tok-1"),
        status: "closed",
      }),
    );

    const found = repo.findByTokenId(createTokenId("tok-1"));
    expect(found).toBeNull();
  });

  it("findByTokenId returns most recent non-closed position (open + dust coexist)", () => {
    repo.save(
      makePosition({
        positionId: createPositionId("p-old"),
        tokenId: createTokenId("tok-1"),
        status: "open",
        openedAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.save(
      makePosition({
        positionId: createPositionId("p-new"),
        tokenId: createTokenId("tok-1"),
        status: "dust",
        openedAt: "2026-01-02T00:00:00Z",
      }),
    );

    const found = repo.findByTokenId(createTokenId("tok-1"));
    expect(found).not.toBeNull();
    expect(found!.positionId).toBe("p-new");
  });

  it("unique index prevents two open rows for same token", () => {
    repo.save(
      makePosition({
        positionId: createPositionId("p-first"),
        tokenId: createTokenId("tok-1"),
        status: "open",
        openedAt: "2026-01-01T00:00:00Z",
      }),
    );

    expect(() =>
      repo.save(
        makePosition({
          positionId: createPositionId("p-second"),
          tokenId: createTokenId("tok-1"),
          status: "open",
          openedAt: "2026-01-02T00:00:00Z",
        }),
      ),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("partial unique index does not constrain dust rows", () => {
    expect(() => {
      repo.save(
        makePosition({
          positionId: createPositionId("p-dust-a"),
          tokenId: createTokenId("tok-1"),
          status: "dust",
          openedAt: "2026-01-01T00:00:00Z",
        }),
      );
      repo.save(
        makePosition({
          positionId: createPositionId("p-dust-b"),
          tokenId: createTokenId("tok-1"),
          status: "dust",
          openedAt: "2026-01-02T00:00:00Z",
        }),
      );
    }).not.toThrow();
  });

  it("upsert preserves FK integrity with inventory_lots", () => {
    // Save a position, then an inventory lot referencing it
    const pos = makePosition();
    repo.save(pos);

    // Insert FK prerequisites and an inventory lot
    conn.db
      .prepare(
        `INSERT INTO orders (order_id, client_order_id, token_id, side, order_type, price, size, size_usdc, status, bot_run_id, created_at, updated_at) VALUES ('ord-1','cloid-1','tok-1','buy','GTC',0.55,100,55,'open','run-1',datetime('now'),datetime('now'))`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT INTO fills (fill_id, order_id, token_id, side, price, size, size_usdc, fee, filled_at) VALUES ('fill-1','ord-1','tok-1','buy',0.55,50,27.5,0,datetime('now'))`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT INTO inventory_lots (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at) VALUES ('lot-1','pos-1','tok-1','buy',50,50,0.55,27.5,'fill-1',datetime('now'))`,
      )
      .run();

    // Upsert the position — must NOT delete+reinsert (would break FK from inventory_lots)
    repo.save(makePosition({ size: 200 }));

    // Verify inventory lot still exists
    const lot = conn.db.prepare("SELECT * FROM inventory_lots WHERE lot_id = 'lot-1'").get();
    expect(lot).toBeTruthy();

    // Verify position was updated
    const all = repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.size).toBe(200);
  });

  it("findByTokenId returns null for unknown token", () => {
    expect(repo.findByTokenId(createTokenId("nonexistent"))).toBeNull();
  });

  it("persists and loads entryStyle='spray'", () => {
    const pos = makePosition({ entryStyle: "spray" });
    repo.save(pos);

    const found = repo.findByTokenId(createTokenId("tok-1"));
    expect(found).not.toBeNull();
    expect(found!.entryStyle).toBe("spray");
  });

  it("persists and loads entryStyle='probe'", () => {
    const pos = makePosition({
      positionId: createPositionId("pos-probe"),
      tokenId: createTokenId("tok-probe"),
      entryStyle: "probe",
    });
    repo.save(pos);

    const found = repo.findByTokenId(createTokenId("tok-probe"));
    expect(found).not.toBeNull();
    expect(found!.entryStyle).toBe("probe");
  });

  it("defaults entryStyle to null when not set in DB", () => {
    const pos = makePosition({ entryStyle: null });
    repo.save(pos);

    const found = repo.findByTokenId(createTokenId("tok-1"));
    expect(found).not.toBeNull();
    expect(found!.entryStyle).toBeNull();
  });
});
