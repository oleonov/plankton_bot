import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  bootstrapDatabase,
  SqliteOperatorCommandRepository,
  SqliteOperatorActionRepository,
} from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import { createOrderId, type OperatorActionType, type Order } from "@krabs/domain";
import { CommandPoller } from "../supervisor/command-poller.js";
import type { PatternRebuilder, ReloadableRules } from "../supervisor/command-poller.js";
import { MakerBuyFastCancel } from "../modules/execution/maker-buy-fast-cancel.js";

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
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-test-"));
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

  describe("cancel_maker_buys", () => {
    const activationTs = "2026-08-15T00:00:00.000Z";

    function insertRawTarget(targetId: string | null): number {
      return Number(
        conn.db
          .prepare(
            `INSERT INTO operator_commands
               (action, target_id, reason, status, created_at, initiator_type, initiator)
             VALUES ('cancel_maker_buys', ?, 'emergency', 'pending', ?, 'operator', 'test')`,
          )
          .run(targetId, new Date().toISOString()).lastInsertRowid,
      );
    }

    it.each([null, "not-a-date", "2026-02-30T00:00:00.000Z", "2026-08-15T00:00:00Z"])(
      "rejects malformed durable target %s without cancel, audit, applied event, or latch change",
      async (targetId) => {
        const id = insertRawTarget(targetId);
        const cancelSince = vi.fn();
        const coordinator = {
          cancelSince,
          isLatched: () => false,
        } as unknown as MakerBuyFastCancel;
        const events: unknown[] = [];
        bus.subscribe("OperatorCommandApplied", async (event) => {
          events.push(event);
        });

        await createPoller({ makerBuyFastCancel: coordinator }).poll();

        const row = conn.db
          .prepare("SELECT status FROM operator_commands WHERE id = ?")
          .get(id) as { status: string };
        expect(row.status).toBe("rejected");
        expect(cancelSince).not.toHaveBeenCalled();
        expect(actionRepo.findRecent(10)).toHaveLength(0);
        expect(events).toHaveLength(0);
        expect(coordinator.isLatched()).toBe(false);
      },
    );

    it("keeps not-ready work pending without audit or event", async () => {
      const id = insertCommand("cancel_maker_buys", activationTs, "emergency");
      const coordinator = new MakerBuyFastCancel({
        orderRepo: { findOpen: () => [] },
        bus,
        isMakerModeOff: () => true,
        inFlightMakerBuys: () => 0,
      });
      const events: unknown[] = [];
      bus.subscribe("OperatorCommandApplied", async (event) => {
        events.push(event);
      });

      await createPoller({ makerBuyFastCancel: coordinator }).poll();

      expect(cmdRepo.getPending().map((command) => command.id)).toEqual([id]);
      expect(actionRepo.findRecent(10)).toHaveLength(0);
      expect(events).toHaveLength(0);
      expect(coordinator.isLatched()).toBe(false);
    });

    it("writes proof timestamp audit and status before event, then releases the latch", async () => {
      const completedAt = "2026-08-15T00:00:00.007Z";
      const id = insertCommand("cancel_maker_buys", activationTs, "emergency");
      const coordinator = new MakerBuyFastCancel({
        orderRepo: { findOpen: () => [] },
        bus,
        isMakerModeOff: () => true,
        inFlightMakerBuys: () => 0,
        now: () => Date.parse(completedAt),
      });
      coordinator.setReady(true);
      const eventProof: Array<{ status: string; audits: number; latched: boolean }> = [];
      bus.subscribe("OperatorCommandApplied", async () => {
        const row = conn.db
          .prepare("SELECT status FROM operator_commands WHERE id = ?")
          .get(id) as { status: string };
        eventProof.push({
          status: row.status,
          audits: actionRepo.findRecent(10).length,
          latched: coordinator.isLatched(),
        });
      });

      await createPoller({ makerBuyFastCancel: coordinator }).poll();

      const row = conn.db
        .prepare("SELECT status, applied_at FROM operator_commands WHERE id = ?")
        .get(id) as { status: string; applied_at: string };
      expect(row).toEqual({ status: "applied", applied_at: completedAt });
      expect(actionRepo.findRecent(10)[0]).toMatchObject({
        action: "cancel_maker_buys",
        targetType: "bot",
        targetId: activationTs,
        performedAt: completedAt,
      });
      expect(eventProof).toEqual([{ status: "applied", audits: 1, latched: true }]);
      expect(coordinator.isLatched()).toBe(false);
    });

    it("retains the latch on timeout and still processes the next queued command", async () => {
      insertCommand("cancel_maker_buys", activationTs, "emergency");
      insertCommand("pause", undefined, "after failed drain");
      const stuck = {
        orderId: createOrderId("stuck-maker"),
        side: "buy",
        entryStyle: "maker",
        createdAt: activationTs,
      } as unknown as Order;
      const cancels: unknown[] = [];
      bus.subscribe("CancelOrderRequested", async (event) => {
        cancels.push(event);
      });
      const coordinator = new MakerBuyFastCancel({
        orderRepo: { findOpen: () => [stuck] },
        bus,
        isMakerModeOff: () => true,
        inFlightMakerBuys: () => 0,
        deadlineMs: 0,
      });
      coordinator.setReady(true);

      await createPoller({ makerBuyFastCancel: coordinator }).poll();

      const rows = conn.db
        .prepare("SELECT action, status FROM operator_commands ORDER BY id")
        .all() as Array<{ action: string; status: string }>;
      expect(rows).toEqual([
        { action: "cancel_maker_buys", status: "rejected" },
        { action: "pause", status: "applied" },
      ]);
      expect(cancels).toHaveLength(1);
      expect(coordinator.isLatched()).toBe(true);
      expect(paused).toBe(true);
      expect(actionRepo.findRecent(10).map((action) => action.action)).toEqual(["pause"]);
    });
  });

  describe("recover_missing_bounce_exit", () => {
    it("awaits proof before status, audit, and event become applied", async () => {
      const id = insertCommand("recover_missing_bounce_exit", "predecessor-1", "operator repair");
      let finish!: (value: { status: "applied"; completedAt: string }) => void;
      const recovery = vi.fn(
        () =>
          new Promise<{ status: "applied"; completedAt: string }>((resolve) => {
            finish = resolve;
          }),
      );
      const events: unknown[] = [];
      bus.subscribe("OperatorCommandApplied", async (event) => {
        events.push(event);
      });

      const polling = createPoller({ recoverMissingBounceExit: recovery }).poll();
      await Promise.resolve();
      expect(cmdRepo.getPending().map((command) => command.id)).toEqual([id]);
      expect(actionRepo.findRecent(10)).toEqual([]);

      finish({ status: "applied", completedAt: "2026-08-22T00:00:00.000Z" });
      await polling;
      expect(recovery).toHaveBeenCalledWith("predecessor-1", id);
      expect(actionRepo.findRecent(10)[0]).toMatchObject({
        action: "recover_missing_bounce_exit",
        targetType: "order",
        targetId: "predecessor-1",
        performedAt: "2026-08-22T00:00:00.000Z",
      });
      expect(events).toHaveLength(1);
    });

    it.each(["deferred", "rejected"] as const)(
      "handles %s without an applied audit",
      async (status) => {
        const id = insertCommand("recover_missing_bounce_exit", "predecessor-1", "repair");
        await createPoller({
          recoverMissingBounceExit: vi.fn().mockResolvedValue({ status }),
        }).poll();
        const row = conn.db
          .prepare("SELECT status FROM operator_commands WHERE id = ?")
          .get(id) as {
          status: string;
        };
        expect(row.status).toBe(status === "deferred" ? "pending" : "rejected");
        expect(actionRepo.findRecent(10)).toEqual([]);
      },
    );
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

      const row = conn.db.prepare("SELECT status FROM operator_commands WHERE id = ?").get(id) as
        | { status: string }
        | undefined;
      expect(row?.status).toBe("rejected");
      expect(cmdRepo.getPending()).toHaveLength(0);
      expect(actionRepo.findRecent(10)).toHaveLength(0);
      expect(events).toHaveLength(0);
    });
  });
});
