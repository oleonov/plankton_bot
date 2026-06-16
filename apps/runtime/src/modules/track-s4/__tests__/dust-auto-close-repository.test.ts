import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createTokenId } from "@krabs/domain";

import { SqliteDustAutoCloseRepository } from "../dust-auto-close-repository.js";

let tmpDir: string;
let db: Database.Database;
let repo: SqliteDustAutoCloseRepository;

const tokenId = createTokenId("dust-auto-close-token");

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-dust-auto-close-repo-"));
  db = new Database(path.join(tmpDir, "ledger.db"));
  const migration = readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../../../../packages/db/src/migrations/074_dust_auto_close_state.sql",
    ),
    "utf8",
  );
  db.exec(migration);
  repo = new SqliteDustAutoCloseRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteDustAutoCloseRepository", () => {
  it("marks an attempted close and exposes the next retry time", () => {
    repo.markAttempted(tokenId, "qualified", 1_800_000_000_000, 1_800_086_400_000);

    expect(repo.getState(tokenId)).toEqual({
      tokenId,
      status: "attempted",
      lastAttemptAtMs: 1_800_000_000_000,
      lastAttemptReason: "qualified",
      nextRetryAtMs: 1_800_086_400_000,
      consecutiveAttempts: 1,
      createdAtMs: 1_800_000_000_000,
      updatedAtMs: 1_800_000_000_000,
    });
    expect(repo.getNextRetryAt(tokenId)).toBe(1_800_086_400_000);
  });

  it("upserts repeated attempts and increments the consecutive counter", () => {
    repo.markAttempted(tokenId, "qualified", 1_800_000_000_000, 1_800_086_400_000);
    repo.markAttempted(tokenId, "exchange_reject", 1_800_086_400_001, 1_800_172_800_000);

    expect(repo.getState(tokenId)).toMatchObject({
      status: "attempted",
      lastAttemptAtMs: 1_800_086_400_001,
      lastAttemptReason: "exchange_reject",
      nextRetryAtMs: 1_800_172_800_000,
      consecutiveAttempts: 2,
      createdAtMs: 1_800_000_000_000,
      updatedAtMs: 1_800_086_400_001,
    });
  });

  it("marks non-closeable rows with timed retry backoff", () => {
    repo.markNonCloseable(tokenId, "below_min_order_size", 1_800_000_000_000, 1_800_086_400_000);

    expect(repo.getState(tokenId)).toMatchObject({
      status: "non_closeable",
      lastAttemptReason: "below_min_order_size",
      nextRetryAtMs: 1_800_086_400_000,
      consecutiveAttempts: 1,
    });
  });

  it("deletes retry state after a successful close", () => {
    repo.markAttempted(tokenId, "qualified", 1_800_000_000_000, 1_800_086_400_000);

    repo.markSuccessful(tokenId);

    expect(repo.getState(tokenId)).toBeNull();
    expect(repo.getNextRetryAt(tokenId)).toBeNull();
  });

  it("returns null for missing rows", () => {
    expect(repo.getState(createTokenId("missing-s4-state"))).toBeNull();
    expect(repo.getNextRetryAt(createTokenId("missing-s4-state"))).toBeNull();
  });
});
