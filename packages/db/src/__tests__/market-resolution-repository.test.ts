import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteMarketResolutionRepository } from "../repositories/market-resolution-repository.js";
import type { MarketResolution } from "@krabs/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteMarketResolutionRepository;

function makeResolution(overrides?: Partial<MarketResolution>): MarketResolution {
  return {
    conditionId: "cond-1",
    resolution: "unknown",
    resolvedAt: "2026-01-01T00:00:00Z",
    detectedAt: "2026-01-01T00:00:00Z",
    source: "gamma-api",
    rawResponse: null,
    status: "detected",
    ...overrides,
  } as MarketResolution;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteMarketResolutionRepository(conn.db);
});

afterEach(() => {
  conn.db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteMarketResolutionRepository", () => {
  it("saves and retrieves a resolution", () => {
    repo.save(makeResolution());
    const result = repo.findByConditionId("cond-1");
    expect(result).not.toBeNull();
    expect(result?.conditionId).toBe("cond-1");
    expect(result?.resolution).toBe("unknown");
    expect(result?.status).toBe("detected");
  });

  it("updateResolution changes unknown to YES and marks settled", () => {
    repo.save(makeResolution());

    repo.updateResolution("cond-1", "YES", "2026-01-02T00:00:00Z", "gamma-api");

    const result = repo.findByConditionId("cond-1");
    expect(result?.resolution).toBe("YES");
    // Canonicalized by the repository (migration 095's invariant) — not a verbatim passthrough
    // of the 20-char ISO-without-ms value passed in.
    expect(result?.resolvedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(result?.status).toBe("settled");
    expect(result?.source).toBe("gamma-api");
  });

  it("updateResolution changes unknown to NO and marks settled", () => {
    repo.save(makeResolution());

    repo.updateResolution("cond-1", "NO", "2026-01-02T00:00:00Z", "gamma-api");

    const result = repo.findByConditionId("cond-1");
    expect(result?.resolution).toBe("NO");
    expect(result?.resolvedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(result?.status).toBe("settled");
  });

  it("updateResolution on non-existent conditionId is a no-op", () => {
    repo.updateResolution("non-existent", "YES", "2026-01-02T00:00:00Z", "gamma-api");
    const result = repo.findByConditionId("non-existent");
    expect(result).toBeNull();
  });

  // Migration 095 canonicalizes every `resolved_at` rendering to ISO-ms-Z. Without normalizing
  // at this write boundary, `save()` would persist a 20-char ISO-without-ms `endDate` verbatim
  // (production holds 1M+ `markets.end_date` values in that shape) and re-split the column
  // within hours of a delisted market resolving — these two cases FAIL without the
  // `canonicalResolvedAt` normalization in `save()`/`updateResolution()`.
  it("save() canonicalizes a resolvedAt rendering with no sub-second part", () => {
    repo.save(makeResolution({ resolvedAt: "2026-05-18T12:00:00Z" }));
    const result = repo.findByConditionId("cond-1");
    expect(result?.resolvedAt).toBe("2026-05-18T12:00:00.000Z");
  });

  it("updateResolution() canonicalizes a Gamma +00 resolvedAt rendering", () => {
    repo.save(makeResolution());
    repo.updateResolution("cond-1", "YES", "2026-01-02 00:00:00+00", "gamma-api");
    const result = repo.findByConditionId("cond-1");
    expect(result?.resolvedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("atomically promotes only a detected unknown row and preserves detected status", () => {
    repo.save(makeResolution({ source: "gamma-delisted" }));

    expect(
      repo.promoteUnknownResolution(
        "cond-1",
        "No",
        "2026-01-02T00:00:00Z",
        "clob-api",
        '{"proof":"exact"}',
      ),
    ).toBe(true);
    expect(repo.findByConditionId("cond-1")).toMatchObject({
      resolution: "No",
      resolvedAt: "2026-01-02T00:00:00.000Z",
      source: "clob-api",
      rawResponse: '{"proof":"exact"}',
      status: "detected",
    });
  });
});
