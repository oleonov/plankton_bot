import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFamilyId } from "@plankton/domain";
import type { FamilyProfileRuntimeState } from "@plankton/domain";
import { SqliteFamilyProfileRuntimeStateRepository } from "../repositories/family-profile-runtime-state-repository.js";

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "ledger.sql");

function makeState(overrides?: Partial<FamilyProfileRuntimeState>): FamilyProfileRuntimeState {
  return {
    familyId: createFamilyId("fam-1"),
    openValueUsdc: 100,
    openPositionCount: 3,
    openDustCount: 1,
    activeMarketCount: 2,
    currentTailCostUsdc: 10,
    tailAdjustedPnlLive: 5,
    lastEntryTs: null,
    lastExitTs: null,
    firstNegativeTailAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("SqliteFamilyProfileRuntimeStateRepository", () => {
  let db: Database.Database;
  let repo: SqliteFamilyProfileRuntimeStateRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(readFileSync(schemaPath, "utf-8"));
    repo = new SqliteFamilyProfileRuntimeStateRepository(db);
  });

  afterEach(() => db.close());

  it("save and get round-trip", () => {
    const state = makeState({
      lastEntryTs: "2026-03-30T10:00:00.000Z",
    });
    repo.save(state);

    const found = repo.get(createFamilyId("fam-1"));
    expect(found).not.toBeNull();
    expect(found!.familyId).toBe("fam-1");
    expect(found!.openValueUsdc).toBe(100);
    expect(found!.openPositionCount).toBe(3);
    expect(found!.openDustCount).toBe(1);
    expect(found!.activeMarketCount).toBe(2);
    expect(found!.currentTailCostUsdc).toBe(10);
    expect(found!.tailAdjustedPnlLive).toBe(5);
    expect(found!.lastEntryTs).toBe("2026-03-30T10:00:00.000Z");
    expect(found!.lastExitTs).toBeNull();
    expect(found!.firstNegativeTailAt).toBeNull();
  });

  it("save updates existing state (upsert)", () => {
    repo.save(makeState({ openValueUsdc: 100 }));
    repo.save(makeState({ openValueUsdc: 250 }));

    const all = repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.openValueUsdc).toBe(250);
  });

  it("findAll returns all states", () => {
    repo.save(makeState({ familyId: createFamilyId("fam-1") }));
    repo.save(makeState({ familyId: createFamilyId("fam-2") }));
    repo.save(makeState({ familyId: createFamilyId("fam-3") }));

    expect(repo.findAll()).toHaveLength(3);
  });

  it("get returns null for missing familyId", () => {
    expect(repo.get(createFamilyId("nonexistent"))).toBeNull();
  });
});
