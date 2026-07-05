/**
 * SqliteMakerShadowOrderRepository tests (Phase 1).
 *
 * Covers:
 *  1. findLadder: returns all rows for a ladderId sorted by level_index
 *  2. upsert: persists ladderId / levelIndex / filledAt
 *  3. updateStage: sets filled_at when provided
 *  4. migration 084: safe_add_column idempotence + backfill
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../migrations/runner.js";
import { applySafeAddColumnStatements } from "../migrations/runner.js";
import { SqliteMakerShadowOrderRepository } from "../repositories/maker-shadow-order-repository.js";
import { createTokenId } from "@krabs/domain";
import type { MakerShadowOrder } from "@krabs/domain";

const TOKEN_ID = createTokenId("tok-ldr");
const COND_ID = "cond-ldr-1";
const LADDER_ID = "ladder-id-abc123";

function makeShadow(overrides: Partial<MakerShadowOrder> = {}): MakerShadowOrder {
  const now = "2026-07-05T10:00:00.000Z";
  return {
    shadowOrderId: `shadow-${Math.random().toString(36).slice(2)}`,
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    buyPx: 0.5,
    harvestPx: 0.6,
    postedAt: now,
    fillDeadline: "2026-07-05T12:00:00.000Z",
    stage: "pending",
    fillKind: null,
    fillPx: null,
    markPx: null,
    netMark: null,
    updatedAt: now,
    ladderId: LADDER_ID,
    levelIndex: 0,
    filledAt: null,
    ...overrides,
  };
}

let tmpDir: string;
let db: Database.Database;
let repo: SqliteMakerShadowOrderRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-maker-ldr-"));
  db = new Database(path.join(tmpDir, "test.db"));
  runMigrations(db);
  repo = new SqliteMakerShadowOrderRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── upsert + round-trip ──────────────────────────────────────────────────────

describe("upsert / findOpen", () => {
  it("persists ladderId, levelIndex, filledAt and round-trips", () => {
    const shadow = makeShadow({ ladderId: LADDER_ID, levelIndex: 2, filledAt: null });
    repo.upsert(shadow);
    const open = repo.findOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.ladderId).toBe(LADDER_ID);
    expect(open[0]!.levelIndex).toBe(2);
    expect(open[0]!.filledAt).toBeNull();
  });
});

// ─── findLadder ───────────────────────────────────────────────────────────────

describe("findLadder", () => {
  it("returns all rows for a ladderId sorted by level_index ascending", () => {
    const level2 = makeShadow({
      ladderId: LADDER_ID,
      levelIndex: 2,
      buyPx: 0.3,
      shadowOrderId: "sid-2",
    });
    const level0 = makeShadow({
      ladderId: LADDER_ID,
      levelIndex: 0,
      buyPx: 0.5,
      shadowOrderId: "sid-0",
    });
    const level1 = makeShadow({
      ladderId: LADDER_ID,
      levelIndex: 1,
      buyPx: 0.4,
      shadowOrderId: "sid-1",
    });
    repo.upsert(level2);
    repo.upsert(level0);
    repo.upsert(level1);

    const ladder = repo.findLadder(LADDER_ID);
    expect(ladder).toHaveLength(3);
    expect(ladder.map((r) => r.levelIndex)).toEqual([0, 1, 2]);
  });

  it("includes terminal rows (marked, expired) as well as open", () => {
    const open = makeShadow({ ladderId: LADDER_ID, levelIndex: 0, shadowOrderId: "sid-open" });
    const terminal = makeShadow({
      ladderId: LADDER_ID,
      levelIndex: 1,
      shadowOrderId: "sid-terminal",
      stage: "expired",
    });
    repo.upsert(open);
    repo.upsert(terminal);

    const ladder = repo.findLadder(LADDER_ID);
    expect(ladder).toHaveLength(2);
    const stages = ladder.map((r) => r.stage);
    expect(stages).toContain("pending");
    expect(stages).toContain("expired");
  });

  it("returns empty array for an unknown ladderId", () => {
    expect(repo.findLadder("nonexistent-ladder")).toEqual([]);
  });

  it("does not cross-contaminate rows from different ladders", () => {
    const ownRow = makeShadow({ ladderId: "ladder-A", levelIndex: 0, shadowOrderId: "sid-a" });
    const otherRow = makeShadow({ ladderId: "ladder-B", levelIndex: 0, shadowOrderId: "sid-b" });
    repo.upsert(ownRow);
    repo.upsert(otherRow);
    expect(repo.findLadder("ladder-A")).toHaveLength(1);
    expect(repo.findLadder("ladder-B")).toHaveLength(1);
  });
});

// ─── updateStage sets filled_at ───────────────────────────────────────────────

describe("updateStage", () => {
  it("sets filled_at when provided in the update", () => {
    const shadow = makeShadow({ shadowOrderId: "sid-fill-test" });
    repo.upsert(shadow);
    const fillIso = "2026-07-05T11:00:00.000Z";
    repo.updateStage("sid-fill-test", {
      stage: "filled",
      fillKind: "touch",
      fillPx: 0.5,
      filledAt: fillIso,
      updatedAt: fillIso,
    });
    const ladder = repo.findLadder(LADDER_ID);
    const row = ladder.find((r) => r.shadowOrderId === "sid-fill-test");
    expect(row).toBeDefined();
    expect(row!.stage).toBe("filled");
    expect(row!.filledAt).toBe(fillIso);
  });

  it("does not overwrite filled_at when not provided (COALESCE semantics)", () => {
    const filledAt = "2026-07-05T10:30:00.000Z";
    const shadow = makeShadow({ shadowOrderId: "sid-coalesce", stage: "filled", filledAt });
    repo.upsert(shadow);
    // Advance to 'harvested' — filledAt not in update, should stay
    repo.updateStage("sid-coalesce", {
      stage: "harvested",
      markPx: 0.6,
      netMark: 0.2,
      updatedAt: "2026-07-05T13:00:00.000Z",
    });
    const ladder = repo.findLadder(LADDER_ID);
    const row = ladder.find((r) => r.shadowOrderId === "sid-coalesce");
    expect(row!.filledAt).toBe(filledAt); // unchanged
  });
});

// ─── migration 084 idempotence ────────────────────────────────────────────────

describe("migration 084", () => {
  it("adds ladder_id, level_index, filled_at columns (idempotent second run)", () => {
    // Migrations already ran in beforeEach; running again must not throw
    runMigrations(db);

    const cols = (
      db.prepare("PRAGMA table_info(maker_shadow_orders)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain("ladder_id");
    expect(cols).toContain("level_index");
    expect(cols).toContain("filled_at");
  });

  it("creates the ladder index", () => {
    const indexes = (
      db.prepare("PRAGMA index_list(maker_shadow_orders)").all() as { name: string }[]
    ).map((i) => i.name);
    expect(indexes).toContain("idx_maker_shadow_orders_ladder");
  });

  it("backfills ladder_id and level_index on a pre-migration row", () => {
    // Simulate a pre-084 row with NULL ladder columns
    db.prepare(
      `INSERT INTO maker_shadow_orders
         (shadow_order_id, token_id, condition_id, buy_px, harvest_px,
          posted_at, fill_deadline, stage, updated_at)
       VALUES ('pre-migr-id', 'tok-pre', 'cond-pre', 0.5, 0.6,
               '2026-07-01T00:00:00.000Z', '2026-07-01T02:00:00.000Z',
               'pending', '2026-07-01T00:00:00.000Z')`,
    ).run();

    // Run migration 084 SQL manually
    const sql = readFileSync(
      path.join(import.meta.dirname, "..", "migrations", "084_maker_shadow_ladder.sql"),
      "utf-8",
    );
    db.exec(applySafeAddColumnStatements(db, sql));

    const row = db
      .prepare(
        "SELECT ladder_id, level_index FROM maker_shadow_orders WHERE shadow_order_id = 'pre-migr-id'",
      )
      .get() as { ladder_id: string; level_index: number };
    expect(row.ladder_id).toBe("pre-migr-id");
    expect(row.level_index).toBe(0);
  });
});
