import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConditionId, createTokenId, type AlgoTokenModeState } from "@krabs/domain";
import { SqliteAlgoTokenModeStateRepository } from "./algo-token-mode-state-repository.js";

describe("SqliteAlgoTokenModeStateRepository", () => {
  it("persists mode state across repository restarts", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-token-mode-"));
    const dbPath = path.join(tmpDir, "ledger.db");
    try {
      const db1 = new Database(dbPath);
      db1.exec(readMigration());
      const repo1 = new SqliteAlgoTokenModeStateRepository(db1);
      repo1.upsert(state());
      db1.close();

      const db2 = new Database(dbPath);
      const repo2 = new SqliteAlgoTokenModeStateRepository(db2);
      const loaded = repo2.get(createTokenId("token-1"));
      db2.close();

      expect(loaded?.mode).toBe("BURST");
      expect(loaded?.modeConfidence).toBe("high");
      expect(loaded?.medianGapMs).toBe(20_000);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function readMigration(): string {
  return readFileSync(
    path.join(import.meta.dirname, "..", "migrations", "051_algo_token_mode_state.sql"),
    "utf-8",
  );
}

function state(): AlgoTokenModeState {
  const now = "2026-05-08T00:00:00.000Z";
  return {
    tokenId: createTokenId("token-1"),
    conditionId: createConditionId("condition-1"),
    outcomeIndex: 0,
    mode: "BURST",
    modeConfidence: "high",
    modeStatus: "confirmed",
    modeSince: now,
    modeAssessedAt: now,
    ttlStage: 0,
    lastFillAt: now,
    lastOrderAt: now,
    lastStaleCancelAt: null,
    fillCountWindow: 5,
    orderCountWindow: 3,
    firstFillLatencyMs: 10_000,
    medianGapMs: 20_000,
    p75GapMs: 25_000,
    spanMs: 90_000,
    lastFillTimestampsJson: JSON.stringify([now]),
    transitionCountDay: 1,
    transitionDay: "2026-05-08",
    resetReason: "burst_confirmed_fast_gaps",
    updatedAt: now,
  };
}
