import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteFamilyStateRepository } from "../repositories/family-state-repository.js";
import { SqliteFamilyCatalogRepository } from "../repositories/family-catalog-repository.js";
import { createFamilyId } from "@plankton/domain";
import type { FamilyState, FamilyIdentity } from "@plankton/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteFamilyStateRepository;
let catalogRepo: SqliteFamilyCatalogRepository;

function makeIdentity(familyId: string): FamilyIdentity {
  return {
    familyId: createFamilyId(familyId),
    familyKey: "test-key",
    primaryCategory: "test",
    regime: "threshold",
    horizon: "daily",
    cadence: "daily",
    strategyProfile: "scalp",
    topicKey: null,
    slugPattern: null,
    notes: null,
  };
}

function makeState(overrides?: Partial<FamilyState>): FamilyState {
  const now = new Date().toISOString();
  return {
    familyId: createFamilyId("fam-1"),
    runtimeMode: "active",
    openValueUsdc: 100,
    openPositionCount: 3,
    openDustCount: 1,
    activeMarketCount: 2,
    currentTailCostUsdc: 10,
    tailAdjustedPnlLive: 5,
    lastEntryTs: null,
    lastExitTs: null,
    quarantineReason: null,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteFamilyStateRepository(conn.db);
  catalogRepo = new SqliteFamilyCatalogRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteFamilyStateRepository", () => {
  it("save + get round-trip", () => {
    catalogRepo.upsert(makeIdentity("fam-1"));
    const state = makeState();
    repo.save(state);

    const found = repo.get(createFamilyId("fam-1"));
    expect(found).not.toBeNull();
    expect(found!.familyId).toBe("fam-1");
    expect(found!.runtimeMode).toBe("active");
    expect(found!.openValueUsdc).toBe(100);
    expect(found!.openPositionCount).toBe(3);
    expect(found!.openDustCount).toBe(1);
    expect(found!.activeMarketCount).toBe(2);
    expect(found!.currentTailCostUsdc).toBe(10);
    expect(found!.tailAdjustedPnlLive).toBe(5);
    expect(found!.lastEntryTs).toBeNull();
    expect(found!.quarantineReason).toBeNull();
  });

  it("get returns null for unknown family", () => {
    expect(repo.get(createFamilyId("nonexistent"))).toBeNull();
  });

  it("findAll returns all families", () => {
    catalogRepo.upsert(makeIdentity("fam-1"));
    catalogRepo.upsert(makeIdentity("fam-2"));

    repo.save(makeState({ familyId: createFamilyId("fam-1") }));
    repo.save(makeState({ familyId: createFamilyId("fam-2") }));

    expect(repo.findAll()).toHaveLength(2);
  });

  it("findByMode filters correctly", () => {
    catalogRepo.upsert(makeIdentity("fam-1"));
    catalogRepo.upsert(makeIdentity("fam-2"));
    catalogRepo.upsert(makeIdentity("fam-3"));

    repo.save(makeState({ familyId: createFamilyId("fam-1"), runtimeMode: "active" }));
    repo.save(makeState({ familyId: createFamilyId("fam-2"), runtimeMode: "quarantine" }));
    repo.save(makeState({ familyId: createFamilyId("fam-3"), runtimeMode: "active" }));

    const active = repo.findByMode("active");
    expect(active).toHaveLength(2);

    const quarantine = repo.findByMode("quarantine");
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]!.familyId).toBe("fam-2");
  });

  it("findQuarantined returns only quarantined families", () => {
    catalogRepo.upsert(makeIdentity("fam-1"));
    catalogRepo.upsert(makeIdentity("fam-2"));
    catalogRepo.upsert(makeIdentity("fam-3"));

    repo.save(makeState({ familyId: createFamilyId("fam-1"), runtimeMode: "active" }));
    repo.save(
      makeState({
        familyId: createFamilyId("fam-2"),
        runtimeMode: "quarantine",
        quarantineReason: "tail exceeded",
      }),
    );
    repo.save(makeState({ familyId: createFamilyId("fam-3"), runtimeMode: "reduce-only" }));

    const quarantined = repo.findQuarantined();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]!.familyId).toBe("fam-2");
    expect(quarantined[0]!.quarantineReason).toBe("tail exceeded");
  });

  it("save updates existing state (upsert)", () => {
    catalogRepo.upsert(makeIdentity("fam-1"));

    repo.save(makeState({ openValueUsdc: 100 }));
    repo.save(makeState({ openValueUsdc: 200 }));

    const all = repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.openValueUsdc).toBe(200);
  });
});
