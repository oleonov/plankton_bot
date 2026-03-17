import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteMarketRepository } from "../repositories/market-repository.js";
import { createTokenId, createFamilyId } from "@plankton/domain";
import type { Market } from "@plankton/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteMarketRepository;

function makeMarket(overrides?: Partial<Market>): Market {
  const now = new Date().toISOString();
  return {
    tokenId: createTokenId("tok-1"),
    conditionId: "cond-1",
    slug: "test-slug",
    question: "Will it rain?",
    outcome: "YES" as const,
    familyId: createFamilyId("fam-1"),
    familyKey: "rain-family",
    regime: "threshold",
    horizon: "daily",
    endDate: null,
    active: true,
    tickSize: 0.01,
    negRisk: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteMarketRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteMarketRepository", () => {
  it("save + findByTokenId round-trip", () => {
    const m = makeMarket();
    repo.save(m);

    const found = repo.findByTokenId(createTokenId("tok-1"));
    expect(found).not.toBeNull();
    expect(found!.tokenId).toBe("tok-1");
    expect(found!.conditionId).toBe("cond-1");
    expect(found!.slug).toBe("test-slug");
    expect(found!.question).toBe("Will it rain?");
    expect(found!.outcome).toBe("YES");
    expect(found!.familyId).toBe("fam-1");
    expect(found!.familyKey).toBe("rain-family");
    expect(found!.regime).toBe("threshold");
    expect(found!.active).toBe(true);
    expect(found!.tickSize).toBe(0.01);
    expect(found!.negRisk).toBe(false);
  });

  it("findByConditionId returns YES/NO pair", () => {
    repo.save(makeMarket({ tokenId: createTokenId("tok-yes"), outcome: "YES" }));
    repo.save(makeMarket({ tokenId: createTokenId("tok-no"), outcome: "NO" }));

    const pair = repo.findByConditionId("cond-1");
    expect(pair).toHaveLength(2);

    const outcomes = pair.map((m) => m.outcome).sort();
    expect(outcomes).toEqual(["NO", "YES"]);
  });

  it("findActive filters correctly", () => {
    repo.save(makeMarket({ tokenId: createTokenId("active-1"), active: true }));
    repo.save(makeMarket({ tokenId: createTokenId("inactive-1"), active: false }));

    const active = repo.findActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.tokenId).toBe("active-1");
  });

  it("findByFamily returns correct markets", () => {
    repo.save(makeMarket({ tokenId: createTokenId("t1"), familyId: createFamilyId("fam-A") }));
    repo.save(makeMarket({ tokenId: createTokenId("t2"), familyId: createFamilyId("fam-A") }));
    repo.save(makeMarket({ tokenId: createTokenId("t3"), familyId: createFamilyId("fam-B") }));

    const famA = repo.findByFamily(createFamilyId("fam-A"));
    expect(famA).toHaveLength(2);

    const famB = repo.findByFamily(createFamilyId("fam-B"));
    expect(famB).toHaveLength(1);
  });

  it("findAll returns everything", () => {
    repo.save(makeMarket({ tokenId: createTokenId("t1") }));
    repo.save(makeMarket({ tokenId: createTokenId("t2"), active: false }));

    expect(repo.findAll()).toHaveLength(2);
  });

  it("save updates existing market (upsert)", () => {
    repo.save(makeMarket({ question: "Version 1" }));
    repo.save(makeMarket({ question: "Version 2" }));

    const all = repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.question).toBe("Version 2");
  });

  it("boolean mapping works for active and negRisk", () => {
    repo.save(makeMarket({ tokenId: createTokenId("b1"), active: false, negRisk: true }));

    const found = repo.findByTokenId(createTokenId("b1"));
    expect(found!.active).toBe(false);
    expect(found!.negRisk).toBe(true);
  });

  it("findByTokenId returns null for unknown token", () => {
    const found = repo.findByTokenId(createTokenId("nonexistent"));
    expect(found).toBeNull();
  });

  it("handles null familyId", () => {
    repo.save(makeMarket({ familyId: null, familyKey: null }));

    const found = repo.findByTokenId(createTokenId("tok-1"));
    expect(found!.familyId).toBeNull();
    expect(found!.familyKey).toBeNull();
  });
});
