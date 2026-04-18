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
  SqliteStateTransitionRepository,
} from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { OperatorActionType, ProfileId } from "@plankton/domain";
import { CommandPoller } from "../supervisor/command-poller.js";
import type {
  DeploymentToggler,
  PatternRebuilder,
  ReloadableRules,
} from "../supervisor/command-poller.js";

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

function makeToggler(): DeploymentToggler & {
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
} {
  return {
    enable: vi.fn((_targetId: string, _profile: ProfileId) => {}),
    disable: vi.fn((_targetId: string, _profile: ProfileId, _reason: string | null) => {}),
  };
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

  // ── Family enable/disable ───────────────────────────────────────────────

  it("applies family_enable via DeploymentToggler and writes audit", async () => {
    const toggler = makeToggler();

    insertCommand("family_enable", "fam-1", "ready to trade");
    const poller = createPoller({
      deploymentToggler: toggler,
      activeProfile: "paper",
    });

    await poller.poll();

    expect(toggler.enable).toHaveBeenCalledWith("fam-1", "paper");
    expect(toggler.disable).not.toHaveBeenCalled();

    const actions = actionRepo.findRecent(10);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe("family_enable");
    expect(actions[0]!.targetType).toBe("family");
    expect(actions[0]!.targetId).toBe("fam-1");
  });

  it("applies family_disable via DeploymentToggler and writes audit", async () => {
    const toggler = makeToggler();

    insertCommand("family_disable", "fam-1", "tail exceeded");
    const poller = createPoller({
      deploymentToggler: toggler,
      activeProfile: "paper",
    });

    await poller.poll();

    expect(toggler.disable).toHaveBeenCalledWith("fam-1", "paper", "tail exceeded");
    expect(toggler.enable).not.toHaveBeenCalled();

    const actions = actionRepo.findRecent(10);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe("family_disable");
    expect(actions[0]!.targetType).toBe("family");
  });

  it("rejects family_enable without targetId", async () => {
    insertCommand("family_enable", undefined, "reason");
    const poller = createPoller({ deploymentToggler: makeToggler(), activeProfile: "paper" });

    await poller.poll();

    // rejected commands don't write audit entries
    expect(cmdRepo.getPending()).toHaveLength(0);
    expect(actionRepo.findRecent(10)).toHaveLength(0);
  });

  it("rejects family_disable without targetId", async () => {
    insertCommand("family_disable", undefined, "reason");
    const poller = createPoller({ deploymentToggler: makeToggler(), activeProfile: "paper" });

    await poller.poll();

    expect(cmdRepo.getPending()).toHaveLength(0);
    expect(actionRepo.findRecent(10)).toHaveLength(0);
  });

  it("works without deploymentToggler or activeProfile (no-op, still writes audit)", async () => {
    insertCommand("family_enable", "fam-1", "reason");

    const poller = createPoller();
    await poller.poll();

    expect(cmdRepo.getPending()).toHaveLength(0);
    const actions = actionRepo.findRecent(10);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe("family_enable");
  });

  it("writes state_transition for family_enable when repo is provided", async () => {
    const transitionRepo = new SqliteStateTransitionRepository(conn.db);

    insertCommand("family_enable", "fam-1", "operator enable", {
      initiatorType: "operator",
      initiator: "admin-user",
    });
    const poller = createPoller({
      deploymentToggler: makeToggler(),
      stateTransitionRepo: transitionRepo,
      activeProfile: "paper",
    });

    await poller.poll();

    const transitions = transitionRepo.findByEntity("family", "fam-1");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.fromState).toBe("disabled");
    expect(transitions[0]!.toState).toBe("enabled");
    expect(transitions[0]!.triggerType).toBe("operator");
    expect(transitions[0]!.initiator).toBe("admin-user");
    expect(transitions[0]!.profile).toBe("paper");
  });

  it("writes state_transition for family_disable when repo is provided", async () => {
    const transitionRepo = new SqliteStateTransitionRepository(conn.db);

    insertCommand("family_disable", "fam-1", "operator disable", {
      initiatorType: "operator",
      initiator: "admin-user",
    });
    const poller = createPoller({
      deploymentToggler: makeToggler(),
      stateTransitionRepo: transitionRepo,
      activeProfile: "paper",
    });

    await poller.poll();

    const transitions = transitionRepo.findByEntity("family", "fam-1");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.fromState).toBe("enabled");
    expect(transitions[0]!.toState).toBe("disabled");
    expect(transitions[0]!.triggerType).toBe("operator");
    expect(transitions[0]!.initiator).toBe("admin-user");
    expect(transitions[0]!.profile).toBe("paper");
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

  it("publishes OperatorCommandApplied on family_enable", async () => {
    const events: Array<{ action: string }> = [];
    bus.subscribe("OperatorCommandApplied", async (payload) => {
      events.push({ action: payload.action });
    });

    insertCommand("family_enable", "fam-1", "enable");
    const poller = createPoller({ deploymentToggler: makeToggler(), activeProfile: "paper" });

    await poller.poll();

    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("family_enable");
  });

  // ── Multi-command processing ────────────────────────────────────────────

  it("processes multiple commands in one poll", async () => {
    const toggler = makeToggler();
    insertCommand("pause");
    insertCommand("family_disable", "fam-1", "reason");

    const poller = createPoller({ deploymentToggler: toggler, activeProfile: "paper" });
    await poller.poll();

    expect(paused).toBe(true);
    expect(toggler.disable).toHaveBeenCalledOnce();
    expect(cmdRepo.getPending()).toHaveLength(0);
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
});
