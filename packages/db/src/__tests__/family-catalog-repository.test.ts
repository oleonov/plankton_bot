import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteFamilyCatalogRepository } from "../repositories/family-catalog-repository.js";
import { createFamilyId } from "@plankton/domain";
import type { FamilyIdentity } from "@plankton/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteFamilyCatalogRepository;

function makeIdentity(overrides?: Partial<FamilyIdentity>): FamilyIdentity {
  return {
    familyId: createFamilyId("fam-1"),
    familyKey: "test-key",
    primaryCategory: "test-category",
    regime: "threshold",
    horizon: "daily",
    cadence: "daily",
    strategyProfile: "scalp",
    topicKey: null,
    slugPattern: null,
    notes: null,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteFamilyCatalogRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteFamilyCatalogRepository", () => {
  it("upsert + findById round-trip", () => {
    const identity = makeIdentity();
    repo.upsert(identity);

    const found = repo.findById(createFamilyId("fam-1"));
    expect(found).not.toBeNull();
    expect(found!.familyId).toBe("fam-1");
    expect(found!.familyKey).toBe("test-key");
    expect(found!.primaryCategory).toBe("test-category");
    expect(found!.regime).toBe("threshold");
    expect(found!.horizon).toBe("daily");
    expect(found!.cadence).toBe("daily");
    expect(found!.strategyProfile).toBe("scalp");
    expect(found!.topicKey).toBeNull();
    expect(found!.slugPattern).toBeNull();
    expect(found!.notes).toBeNull();
  });

  it("upsert updates existing identity", () => {
    repo.upsert(makeIdentity({ primaryCategory: "v1" }));
    repo.upsert(makeIdentity({ primaryCategory: "v2" }));

    const all = repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.primaryCategory).toBe("v2");
  });

  it("upsertAll inserts multiple identities atomically", () => {
    const identities = [
      makeIdentity({ familyId: createFamilyId("fam-1") }),
      makeIdentity({ familyId: createFamilyId("fam-2"), familyKey: "key-2" }),
      makeIdentity({ familyId: createFamilyId("fam-3"), familyKey: "key-3" }),
    ];
    repo.upsertAll(identities);

    const all = repo.findAll();
    expect(all).toHaveLength(3);
  });

  it("findById returns null for unknown family", () => {
    expect(repo.findById(createFamilyId("nonexistent"))).toBeNull();
  });

  it("findAll returns empty array on empty table", () => {
    expect(repo.findAll()).toHaveLength(0);
  });

  it("handles optional fields (topicKey, slugPattern, notes)", () => {
    repo.upsert(
      makeIdentity({
        topicKey: "elections",
        slugPattern: "will-*-win",
        notes: "Political family",
      }),
    );

    const found = repo.findById(createFamilyId("fam-1"));
    expect(found!.topicKey).toBe("elections");
    expect(found!.slugPattern).toBe("will-*-win");
    expect(found!.notes).toBe("Political family");
  });
});
