import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteOperatorCommandRepository } from "../repositories/operator-command-repository.js";
import { SqliteOperatorActionRepository } from "../repositories/operator-action-repository.js";

let conn: DbConnection;
let tmpDir: string;
let cmdRepo: SqliteOperatorCommandRepository;
let actionRepo: SqliteOperatorActionRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  cmdRepo = new SqliteOperatorCommandRepository(conn.db);
  actionRepo = new SqliteOperatorActionRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteOperatorCommandRepository", () => {
  it("insert returns auto-incremented id", () => {
    const id1 = cmdRepo.insert({
      action: "pause",
      targetId: null,
      reason: "maintenance",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const id2 = cmdRepo.insert({
      action: "resume",
      targetId: null,
      reason: null,
      createdAt: "2026-01-01T00:01:00Z",
    });

    expect(id1).toBe(1);
    expect(id2).toBe(2);
  });

  it("getPending returns pending commands in order", () => {
    cmdRepo.insert({
      action: "pause",
      targetId: null,
      reason: "reason-1",
      createdAt: "2026-01-01T00:00:00Z",
    });
    cmdRepo.insert({
      action: "rules_reload",
      targetId: null,
      reason: "reason-2",
      createdAt: "2026-01-01T00:01:00Z",
    });

    const pending = cmdRepo.getPending();
    expect(pending).toHaveLength(2);
    expect(pending[0]!.action).toBe("pause");
    expect(pending[0]!.status).toBe("pending");
    expect(pending[0]!.appliedAt).toBeNull();
    expect(pending[1]!.action).toBe("rules_reload");
    expect(pending[1]!.targetId).toBeNull();
  });

  it("updateStatus marks as applied", () => {
    const id = cmdRepo.insert({
      action: "pause",
      targetId: null,
      reason: null,
      createdAt: "2026-01-01T00:00:00Z",
    });

    cmdRepo.updateStatus(id, "applied", "2026-01-01T00:05:00Z");

    const pending = cmdRepo.getPending();
    expect(pending).toHaveLength(0);
  });

  it("updateStatus marks as rejected", () => {
    const id = cmdRepo.insert({
      action: "rules_reload",
      targetId: null,
      reason: "test",
      createdAt: "2026-01-01T00:00:00Z",
    });

    cmdRepo.updateStatus(id, "rejected", "2026-01-01T00:05:00Z");

    const pending = cmdRepo.getPending();
    expect(pending).toHaveLength(0);
  });

  it("round-trips initiatorType and initiator", () => {
    cmdRepo.insert({
      action: "rules_reload",
      targetId: null,
      reason: "auto-promote",
      createdAt: "2026-01-01T00:00:00Z",
      initiatorType: "system",
      initiator: "rules-import",
    });

    const pending = cmdRepo.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.initiatorType).toBe("system");
    expect(pending[0]!.initiator).toBe("rules-import");
  });

  it("defaults initiatorType to operator when omitted", () => {
    cmdRepo.insert({
      action: "pause",
      targetId: null,
      reason: null,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const pending = cmdRepo.getPending();
    expect(pending[0]!.initiatorType).toBe("operator");
    expect(pending[0]!.initiator).toBeNull();
  });

  it("getPending does not return applied/rejected commands", () => {
    const id1 = cmdRepo.insert({
      action: "pause",
      targetId: null,
      reason: null,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const id2 = cmdRepo.insert({
      action: "resume",
      targetId: null,
      reason: null,
      createdAt: "2026-01-01T00:01:00Z",
    });
    cmdRepo.insert({
      action: "rules_reload",
      targetId: null,
      reason: null,
      createdAt: "2026-01-01T00:02:00Z",
    });

    cmdRepo.updateStatus(id1, "applied", "2026-01-01T00:03:00Z");
    cmdRepo.updateStatus(id2, "rejected", "2026-01-01T00:03:00Z");

    const pending = cmdRepo.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.action).toBe("rules_reload");
  });
});

describe("SqliteOperatorActionRepository", () => {
  it("insert creates action with generated actionId", () => {
    actionRepo.insert({
      action: "pause",
      targetType: "bot",
      targetId: "bot-1",
      reason: "maintenance",
      performedAt: "2026-01-01T00:00:00Z",
    });

    const recent = actionRepo.findRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.actionId).toBeTruthy();
    expect(recent[0]!.action).toBe("pause");
    expect(recent[0]!.targetType).toBe("bot");
    expect(recent[0]!.targetId).toBe("bot-1");
    expect(recent[0]!.reason).toBe("maintenance");
  });

  it("findRecent returns newest first", () => {
    actionRepo.insert({
      action: "pause",
      targetType: "bot",
      targetId: "bot-1",
      reason: null,
      performedAt: "2026-01-01T00:00:00Z",
    });
    actionRepo.insert({
      action: "resume",
      targetType: "bot",
      targetId: "bot-1",
      reason: null,
      performedAt: "2026-01-02T00:00:00Z",
    });
    actionRepo.insert({
      action: "rules_reload",
      targetType: "bot",
      targetId: "runtime",
      reason: "rules updated",
      performedAt: "2026-01-03T00:00:00Z",
    });

    const recent = actionRepo.findRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.action).toBe("rules_reload");
    expect(recent[1]!.action).toBe("resume");
  });
});
