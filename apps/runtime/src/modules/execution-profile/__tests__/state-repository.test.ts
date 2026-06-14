import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createConditionId, createTokenId } from "@krabs/domain";
import { SqliteExecutionProfileStateRepository } from "../state-repository.js";
import type { ExecutionProfileStateRecord } from "../types.js";

let tmpDir: string;
let db: Database.Database;
let repo: SqliteExecutionProfileStateRepository;

const tokenId = createTokenId("repo-token");
const conditionId = createConditionId("repo-condition");

function migrationSql(): string {
  return readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../../../../packages/db/src/migrations/069_execution_profile_state.sql",
    ),
    "utf8",
  );
}

function state(overrides: Partial<ExecutionProfileStateRecord> = {}): ExecutionProfileStateRecord {
  return {
    tokenId,
    conditionId,
    profile: "medium",
    state: "ACCUMULATING",
    assumedAt: "2026-06-14T00:00:00.000Z",
    lastAvgEntry: 0.12,
    lastTransitionAt: "2026-06-14T00:05:00.000Z",
    activeLadderId: null,
    handoffStartedAt: null,
    metadata: null,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:05:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-profile-state-"));
  db = new Database(path.join(tmpDir, "ledger.db"));
  db.exec(migrationSql());
  repo = new SqliteExecutionProfileStateRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteExecutionProfileStateRepository", () => {
  it("upserts and reads state rows", () => {
    repo.upsertState(state({ metadata: { reason: "test" } }));

    expect(repo.getState(tokenId)).toMatchObject({
      tokenId,
      conditionId,
      profile: "medium",
      state: "ACCUMULATING",
      metadata: { reason: "test" },
    });

    repo.upsertState(state({ profile: "cheap", state: "EXITING", activeLadderId: "ladder-1" }));
    expect(repo.getState(tokenId)).toMatchObject({
      profile: "cheap",
      state: "EXITING",
      activeLadderId: "ladder-1",
    });
  });

  it("finds active rows and excludes CLOSED", () => {
    repo.upsertState(state({ state: "ABANDONED" }));
    repo.upsertState(state({ tokenId: createTokenId("closed-token"), state: "CLOSED" }));

    expect(repo.findAllActive().map((row) => String(row.tokenId))).toEqual(["repo-token"]);
  });

  it("filters by state and deletes", () => {
    repo.upsertState(state({ state: "EXITING" }));
    repo.upsertState(state({ tokenId: createTokenId("probing-token"), state: "PROBING" }));

    expect(repo.findByState("EXITING")).toHaveLength(1);
    repo.delete(tokenId);
    expect(repo.getState(tokenId)).toBeNull();
  });

  it("finds orphaned rows outside the open-token set", () => {
    repo.upsertState(state());
    repo.upsertState(state({ tokenId: createTokenId("orphan-token") }));

    expect(repo.findOrphans([tokenId]).map((row) => String(row.tokenId))).toEqual(["orphan-token"]);
  });

  it("rolls back bulk transaction failures", () => {
    expect(() =>
      repo.runInTransaction(() => {
        repo.upsertState(state({ tokenId: createTokenId("tx-ok") }));
        db.prepare("INSERT INTO execution_profile_state (token_id) VALUES (?)").run("broken");
      }),
    ).toThrow();

    expect(repo.getState(createTokenId("tx-ok"))).toBeNull();
  });
});
