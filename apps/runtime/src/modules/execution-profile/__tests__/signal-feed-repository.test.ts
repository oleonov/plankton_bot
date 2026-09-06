import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import type { OhlcBucket } from "@krabs/domain";
import { createTokenId } from "@krabs/domain";

import { SqliteSignalFeedRepository } from "../signal-feed-repository.js";

let tmpDir: string;
let db: Database.Database;
let repo: SqliteSignalFeedRepository;

const tokenId = createTokenId("signal-feed-token");
const otherTokenId = createTokenId("other-signal-feed-token");

function bucket(overrides: Partial<OhlcBucket> = {}): OhlcBucket {
  return {
    tokenId,
    bucketStartMs: 60_000,
    bucketGranularityMs: 60_000,
    openMid: 0.1,
    highMid: 0.2,
    lowMid: 0.05,
    closeMid: 0.15,
    sampleCount: 4,
    tradeCount: 0,
    notionalSum: 0,
    persisted: false,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-signal-feed-repo-"));
  db = new Database(path.join(tmpDir, "ledger.db"));
  const migration = readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../../../../packages/db/src/migrations/071_signal_feed_buckets.sql",
    ),
    "utf8",
  );
  db.exec(migration);
  repo = new SqliteSignalFeedRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteSignalFeedRepository", () => {
  it("upserts and reads persisted bucket rows", () => {
    repo.upsertBucket(bucket(), 1_700_000_000_000);
    repo.upsertBucket(bucket({ closeMid: 0.18, sampleCount: 5 }), 1_700_000_001_000);

    expect(repo.selectBucketsForToken({ tokenId, bucketGranularityMs: 60_000 })).toEqual([
      {
        tokenId,
        bucketStartMs: 60_000,
        bucketGranularityMs: 60_000,
        openMid: 0.1,
        highMid: 0.2,
        lowMid: 0.05,
        closeMid: 0.18,
        sampleCount: 5,
        tradeCount: 0,
        notionalSum: 0,
        persisted: true,
      },
    ]);
  });

  it("selects by token, granularity, since, and recent limit while returning ascending order", () => {
    repo.upsertBuckets(
      [
        bucket({ bucketStartMs: 0 }),
        bucket({ bucketStartMs: 60_000 }),
        bucket({ bucketStartMs: 120_000 }),
        bucket({ bucketStartMs: 180_000 }),
        bucket({ tokenId: otherTokenId, bucketStartMs: 180_000 }),
        bucket({ bucketStartMs: 180_000, bucketGranularityMs: 3_600_000 }),
      ],
      1_700_000_000_000,
    );

    expect(
      repo
        .selectBucketsForToken({
          tokenId,
          bucketGranularityMs: 60_000,
          sinceMs: 60_000,
          limit: 2,
        })
        .map((row) => row.bucketStartMs),
    ).toEqual([120_000, 180_000]);
  });

  it("rolls back the whole batch when a later bucket violates a constraint", () => {
    expect(() =>
      repo.upsertBuckets(
        [bucket(), bucket({ bucketStartMs: 120_000, closeMid: null as unknown as number })],
        1_700_000_000_000,
      ),
    ).toThrow();

    expect(repo.selectBucketsForToken({ tokenId, bucketGranularityMs: 60_000 })).toEqual([]);
  });

  it("deletes old buckets by granularity and keeps newer or different granularity rows", () => {
    repo.upsertBuckets(
      [
        bucket({ bucketStartMs: 0 }),
        bucket({ bucketStartMs: 60_000 }),
        bucket({ bucketStartMs: 120_000 }),
        bucket({ bucketStartMs: 0, bucketGranularityMs: 3_600_000 }),
      ],
      1_700_000_000_000,
    );

    expect(repo.deleteBucketsBefore(60_000, 120_000)).toBe(2);
    expect(
      repo
        .selectBucketsForToken({ tokenId, bucketGranularityMs: 60_000 })
        .map((row) => row.bucketStartMs),
    ).toEqual([120_000]);
    expect(repo.selectBucketsForToken({ tokenId, bucketGranularityMs: 3_600_000 })).toHaveLength(1);
  });
});
