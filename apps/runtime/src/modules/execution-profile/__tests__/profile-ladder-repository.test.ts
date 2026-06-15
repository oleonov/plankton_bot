import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createConditionId, createTokenId, type LadderRung, type LadderState } from "@krabs/domain";

import { SqliteProfileLadderRepository } from "../profile-ladder-repository.js";

let tmpDir: string;
let db: Database.Database;
let repo: SqliteProfileLadderRepository;

const tokenId = createTokenId("ladder-repo-token");
const conditionId = createConditionId("ladder-repo-condition");

function rung(overrides: Partial<LadderRung> = {}): LadderRung {
  return {
    rungIndex: 0,
    price: 0.11,
    sizeShares: 10,
    notionalUsd: 1.1,
    multiplier: 1.1,
    sizingFraction: 1,
    lifecycle: "planned",
    orderId: null,
    filledSizeShares: 0,
    ...overrides,
  };
}

function state(overrides: Partial<LadderState> = {}): LadderState {
  return {
    tokenId,
    conditionId,
    ladderId: "profile_ladder_1",
    band: "medium_low",
    phase: 1,
    status: "active",
    activeRungs: [rung()],
    filledRungs: [],
    lastAvgEntry: 0.1,
    lastCostBasisUsdc: 25,
    lastMode: "flat",
    lastBboReferenceJson: JSON.stringify({ bestBid: 0.09, bestAsk: 0.11 }),
    lastRebuildAtMs: 1_797_376_400_000,
    lastFillAtMs: null,
    staleCheckedAtMs: null,
    qdHandoffAtMs: null,
    createdAtMs: 1_797_376_400_000,
    updatedAtMs: 1_797_376_400_000,
    metadataJson: "{}",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-profile-ladder-repo-"));
  db = new Database(path.join(tmpDir, "ledger.db"));
  const migration = readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../../../../packages/db/src/migrations/072_profile_ladder_state.sql",
    ),
    "utf8",
  );
  db.exec(migration);
  repo = new SqliteProfileLadderRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteProfileLadderRepository", () => {
  it("upserts and reads ladder state rows", () => {
    repo.upsertLadder(state({ activeRungs: [rung({ rungIndex: 0 }), rung({ rungIndex: 1 })] }));
    repo.upsertLadder(
      state({
        ladderId: "profile_ladder_updated",
        activeRungs: [rung({ price: 0.13, multiplier: 1.3 })],
        lastCostBasisUsdc: 30,
        updatedAtMs: 1_797_376_500_000,
      }),
    );

    expect(repo.getLadder(tokenId)).toMatchObject({
      tokenId,
      conditionId,
      ladderId: "profile_ladder_updated",
      band: "medium_low",
      activeRungs: [{ price: 0.13, multiplier: 1.3 }],
      lastCostBasisUsdc: 30,
      updatedAtMs: 1_797_376_500_000,
    });
  });

  it("finds active ladders and excludes terminal statuses", () => {
    repo.upsertLadder(state({ tokenId: createTokenId("active-1"), status: "active" }));
    repo.upsertLadder(state({ tokenId: createTokenId("rebuild-1"), status: "rebuilding" }));
    repo.upsertLadder(state({ tokenId: createTokenId("closed-1"), status: "closed" }));
    repo.upsertLadder(state({ tokenId: createTokenId("cancelled-1"), status: "cancelled" }));

    expect(
      repo
        .findActive()
        .map((row) => String(row.tokenId))
        .sort(),
    ).toEqual(["active-1", "rebuild-1"]);
  });

  it("reports profile-ladder ownership only for non-terminal ladders", () => {
    repo.upsertLadder(state({ tokenId: createTokenId("owned-active"), status: "active" }));
    repo.upsertLadder(state({ tokenId: createTokenId("owned-closed"), status: "closed" }));

    expect((repo as any).isProfileLadderOwned(createTokenId("owned-active"))).toBe(true);
    expect((repo as any).isProfileLadderOwned(createTokenId("owned-closed"))).toBe(false);
    expect((repo as any).isProfileLadderOwned(createTokenId("owned-missing"))).toBe(false);
  });

  it("deletes ladder rows by token", () => {
    repo.upsertLadder(state());

    repo.deleteLadder(tokenId);

    expect(repo.getLadder(tokenId)).toBeNull();
  });

  it("rolls back transaction failures", () => {
    expect(() =>
      repo.runInTransaction(() => {
        repo.upsertLadder(state({ tokenId: createTokenId("tx-ladder") }));
        db.prepare("INSERT INTO profile_ladder_state (token_id) VALUES (?)").run("broken");
      }),
    ).toThrow();

    expect(repo.getLadder(createTokenId("tx-ladder"))).toBeNull();
  });
});
