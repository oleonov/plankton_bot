import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  bootstrapDatabase,
  SqliteOperatorCommandRepository,
  SqliteOperatorActionRepository,
  SqliteFamilyStateRepository,
  SqliteFamilyCatalogRepository,
} from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import { createFamilyId } from "@plankton/domain";
import type { FamilyIdentity, OperatorActionType } from "@plankton/domain";
import { CommandPoller } from "../supervisor/command-poller.js";

const log = pino({ level: "silent" });

let conn: DbConnection;
let tmpDir: string;
let cmdRepo: SqliteOperatorCommandRepository;
let actionRepo: SqliteOperatorActionRepository;
let familyStateRepo: SqliteFamilyStateRepository;
let catalogRepo: SqliteFamilyCatalogRepository;
let bus: InProcessEventBus;
let paused: boolean;

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

function seedFamily(familyId: string): void {
  catalogRepo.upsert(makeIdentity(familyId));
  familyStateRepo.save({
    familyId: createFamilyId(familyId),
    runtimeMode: "active",
    openValueUsdc: 0,
    openPositionCount: 0,
    openDustCount: 0,
    activeMarketCount: 0,
    currentTailCostUsdc: 0,
    tailAdjustedPnlLive: 0,
    lastEntryTs: null,
    lastExitTs: null,
    quarantineReason: null,
    updatedAt: new Date().toISOString(),
  });
}

function insertCommand(action: OperatorActionType, targetId?: string, reason?: string): number {
  return cmdRepo.insert({
    action,
    targetId: targetId ?? null,
    reason: reason ?? null,
    createdAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  cmdRepo = new SqliteOperatorCommandRepository(conn.db);
  actionRepo = new SqliteOperatorActionRepository(conn.db);
  familyStateRepo = new SqliteFamilyStateRepository(conn.db);
  catalogRepo = new SqliteFamilyCatalogRepository(conn.db);
  bus = new InProcessEventBus();
  paused = false;
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("CommandPoller", () => {
  function createPoller(): CommandPoller {
    return new CommandPoller({
      commandRepo: cmdRepo,
      actionRepo,
      familyStateRepo,
      bus,
      log,
      getPaused: () => paused,
      setPaused: (p) => {
        paused = p;
      },
      pollIntervalMs: 60_000, // high interval so tests control poll timing
    });
  }

  it("applies pause command and writes audit", async () => {
    insertCommand("pause", undefined, "maintenance");
    const poller = createPoller();

    await poller.poll();

    expect(paused).toBe(true);
    const actions = actionRepo.findRecent(10);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe("pause");
    expect(actions[0]!.targetType).toBe("bot");

    const pending = cmdRepo.getPending();
    expect(pending).toHaveLength(0);
  });

  it("applies resume command", async () => {
    paused = true;
    insertCommand("resume");
    const poller = createPoller();

    await poller.poll();

    expect(paused).toBe(false);
  });

  it("applies family_quarantine and updates runtime state", async () => {
    seedFamily("fam-1");
    insertCommand("family_quarantine", "fam-1", "tail exceeded");
    const poller = createPoller();

    await poller.poll();

    const state = familyStateRepo.get(createFamilyId("fam-1"));
    expect(state!.runtimeMode).toBe("quarantine");
    expect(state!.quarantineReason).toBe("tail exceeded");
  });

  it("applies family_reduce_only", async () => {
    seedFamily("fam-1");
    insertCommand("family_reduce_only", "fam-1");
    const poller = createPoller();

    await poller.poll();

    const state = familyStateRepo.get(createFamilyId("fam-1"));
    expect(state!.runtimeMode).toBe("reduce-only");
  });

  it("applies family_activate and clears quarantine reason", async () => {
    seedFamily("fam-1");
    // First quarantine
    insertCommand("family_quarantine", "fam-1", "some reason");
    const poller = createPoller();
    await poller.poll();

    // Then activate
    insertCommand("family_activate", "fam-1");
    await poller.poll();

    const state = familyStateRepo.get(createFamilyId("fam-1"));
    expect(state!.runtimeMode).toBe("active");
    expect(state!.quarantineReason).toBeNull();
  });

  it("rejects command when family not found", async () => {
    insertCommand("family_quarantine", "nonexistent", "reason");
    const poller = createPoller();

    await poller.poll();

    const pending = cmdRepo.getPending();
    expect(pending).toHaveLength(0);

    // Should have been marked rejected (no audit action for rejected)
    const actions = actionRepo.findRecent(10);
    expect(actions).toHaveLength(0);
  });

  it("rejects family command without targetId", async () => {
    insertCommand("family_quarantine", undefined, "reason");
    const poller = createPoller();

    await poller.poll();

    const pending = cmdRepo.getPending();
    expect(pending).toHaveLength(0);
  });

  it("publishes OperatorCommandApplied event on success", async () => {
    const events: unknown[] = [];
    bus.subscribe("OperatorCommandApplied", async (payload) => {
      events.push(payload);
    });

    insertCommand("pause", undefined, "test");
    const poller = createPoller();

    await poller.poll();

    expect(events).toHaveLength(1);
  });

  it("processes multiple commands in one poll", async () => {
    seedFamily("fam-1");
    insertCommand("pause");
    insertCommand("family_quarantine", "fam-1", "reason");

    const poller = createPoller();
    await poller.poll();

    expect(paused).toBe(true);
    const state = familyStateRepo.get(createFamilyId("fam-1"));
    expect(state!.runtimeMode).toBe("quarantine");
    expect(cmdRepo.getPending()).toHaveLength(0);
  });

  it("concurrent poll calls are serialized by guard", async () => {
    insertCommand("pause");
    const poller = createPoller();

    // Fire two polls concurrently — second should be skipped
    const [_r1, _r2] = await Promise.all([poller.poll(), poller.poll()]);

    // Only one audit action should exist (not two)
    const actions = actionRepo.findRecent(10);
    expect(actions).toHaveLength(1);
  });

  it("start/stop lifecycle works", async () => {
    const poller = createPoller();

    await poller.start();
    const health = await poller.healthCheck();
    expect(health.ok).toBe(true);

    await poller.stop();
  });
});
