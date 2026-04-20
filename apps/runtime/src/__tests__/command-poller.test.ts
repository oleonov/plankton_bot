import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  bootstrapDatabase,
  SqliteOperatorCommandRepository,
  SqliteOperatorActionRepository,
} from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { OperatorActionType } from "@plankton/domain";
import { CommandPoller } from "../supervisor/command-poller.js";
import type { PatternRebuilder, ReloadableRules } from "../supervisor/command-poller.js";

const log = pino({ level: "silent" });

let conn: DbConnection;
let tmpDir: string;
let cmdRepo: SqliteOperatorCommandRepository;
let actionRepo: SqliteOperatorActionRepository;
let bus: InProcessEventBus;
let paused: boolean;

function insertCommand(
  action: OperatorActionType,
  targetId?: string,
  reason?: string,
  opts?: { initiatorType: "operator" | "system"; initiator?: string },
): number {
  const base = {
    action,
    targetId: targetId ?? null,
    reason: reason ?? null,
    createdAt: new Date().toISOString(),
  };
  if (opts) {
    return cmdRepo.insert({
      ...base,
      initiatorType: opts.initiatorType,
      initiator: opts.initiator ?? null,
    });
  }
  return cmdRepo.insert(base);
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  cmdRepo = new SqliteOperatorCommandRepository(conn.db);
  actionRepo = new SqliteOperatorActionRepository(conn.db);
  bus = new InProcessEventBus();
  paused = false;
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("CommandPoller", () => {
  function createPoller(
    extra?: Partial<ConstructorParameters<typeof CommandPoller>[0]>,
  ): CommandPoller {
    return new CommandPoller({
      commandRepo: cmdRepo,
      actionRepo,
      bus,
      log,
      getPaused: () => paused,
      setPaused: (p) => {
        paused = p;
      },
      pollIntervalMs: 60_000,
      ...extra,
    });
  }

  // ── Global pause/resume ─────────────────────────────────────────────────

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

  // ── Event publishing ────────────────────────────────────────────────────

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

  // ── Multi-command processing ────────────────────────────────────────────

  it("processes multiple commands in one poll", async () => {
    insertCommand("pause");
    insertCommand("resume");

    const poller = createPoller();
    await poller.poll();

    expect(paused).toBe(false);
    expect(cmdRepo.getPending()).toHaveLength(0);

    const actions = actionRepo.findRecent(10);
    expect(actions.map((a) => a.action).sort()).toEqual(["pause", "resume"]);
  });

  it("concurrent poll calls are serialized by guard", async () => {
    insertCommand("pause");
    const poller = createPoller();

    const [_r1, _r2] = await Promise.all([poller.poll(), poller.poll()]);

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

  // ── rules_reload ────────────────────────────────────────────────────────

  describe("rules_reload", () => {
    it("calls reload + rebuildPatterns", async () => {
      const rulesManager: ReloadableRules = { reload: vi.fn() };
      const normalizationModule: PatternRebuilder = { rebuildPatterns: vi.fn() };

      insertCommand("rules_reload");
      const poller = createPoller({
        rulesManager,
        normalizationModule,
      });

      await poller.poll();

      expect(rulesManager.reload).toHaveBeenCalledOnce();
      expect(normalizationModule.rebuildPatterns).toHaveBeenCalledOnce();
    });

    it("rejects rules_reload without rulesManager dep", async () => {
      insertCommand("rules_reload");
      const poller = createPoller();

      await poller.poll();

      expect(cmdRepo.getPending()).toHaveLength(0);
      const actions = actionRepo.findRecent(10);
      expect(actions).toHaveLength(0); // rejected commands don't write audit
    });
  });

  // ── Unknown / legacy actions ─────────────────────────────────────────────

  describe("unknown action", () => {
    it("rejects unrecognized action strings, marks status=rejected, no audit, no OperatorCommandApplied", async () => {
      const events: Array<{ action: string }> = [];
      bus.subscribe("OperatorCommandApplied", async (payload) => {
        events.push({ action: payload.action });
      });

      // Simulate a stale row whose action string is not in the current enum
      // (e.g. from an older schema or operator typo). The cast is deliberate —
      // the whole point of the test is that the poller rejects unrecognized
      // strings the type system would normally block.
      const id = cmdRepo.insert({
        action: "legacy_unknown_action" as unknown as OperatorActionType,
        targetId: null,
        reason: "stale payload",
        createdAt: new Date().toISOString(),
      });
      const poller = createPoller();

      await poller.poll();

      const row = conn.db
        .prepare("SELECT status FROM operator_commands WHERE id = ?")
        .get(id) as { status: string } | undefined;
      expect(row?.status).toBe("rejected");
      expect(cmdRepo.getPending()).toHaveLength(0);
      expect(actionRepo.findRecent(10)).toHaveLength(0);
      expect(events).toHaveLength(0);
    });
  });
});
