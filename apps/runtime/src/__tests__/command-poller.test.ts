import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  bootstrapDatabase,
  bootstrapControlDb,
  bootstrapLedgerDb,
  SqliteOperatorCommandRepository,
  SqliteOperatorActionRepository,
} from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import { createOrderId, type OperatorActionType, type Order } from "@krabs/domain";
import { CommandPoller } from "../supervisor/command-poller.js";
import type { PatternRebuilder, ReloadableRules } from "../supervisor/command-poller.js";
import { MakerBuyFastCancel } from "../modules/execution/maker-buy-fast-cancel.js";
import { PermanentR23ActivationCoordinator } from "../permanent-r23-activation.js";

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

  it("rejects a queued resume when durable recovery coverage is not authorized", async () => {
    paused = true;
    insertCommand("resume");
    const authorizeResume = vi.fn().mockResolvedValue(false);

    await createPoller({ authorizeResume }).poll();

    expect(authorizeResume).toHaveBeenCalledOnce();
    expect(paused).toBe(true);
    expect(cmdRepo.getPending()).toHaveLength(0);
    expect(actionRepo.findRecent(10)).toHaveLength(0);
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

  it("keeps durable permanent lifecycle applied when its event fails", async () => {
    const id = insertCommand(
      "activate_permanent_r23" as OperatorActionType,
      JSON.stringify({ expectedVersion: 17 }),
    );
    const applied = {
      status: "applied" as const,
      activationId: "permanent-r23-activation-1",
      completedAt: "2026-08-28T00:00:00.000Z",
    };
    const activatePermanentR23 = vi.fn(async (command) => {
      cmdRepo.updateStatus(command.id, "applied", applied.completedAt);
      return applied;
    });
    bus.subscribe("OperatorCommandApplied", async () => {
      throw new Error("event failed");
    });
    const poller = createPoller({ activatePermanentR23 });
    await poller.poll();
    await poller.poll();
    expect(activatePermanentR23).toHaveBeenCalledWith(expect.objectContaining({ id }), 17);
    expect(cmdRepo.getPending()).toEqual([]);

    insertCommand(
      "deactivate_permanent_r23" as OperatorActionType,
      JSON.stringify({ expectedVersion: 18, activationId: applied.activationId }),
    );
    const finalizePermanentR23Deactivation = vi.fn(async (command) => {
      cmdRepo.updateStatus(command.id, "applied", applied.completedAt);
      return applied;
    });
    const fencePermanentR23Deactivation = vi.fn(async () => ({
      status: "fenced" as const,
      activationId: applied.activationId,
    }));
    const cancelPermanentActivation = vi.fn(async (_id, commit) => {
      await commit(applied.completedAt);
      return "applied" as const;
    });
    await createPoller({
      fencePermanentR23Deactivation,
      finalizePermanentR23Deactivation,
      makerBuyFastCancel: { cancelPermanentActivation } as unknown as MakerBuyFastCancel,
    }).poll();
    expect(cancelPermanentActivation).toHaveBeenCalledWith(
      applied.activationId,
      expect.any(Function),
    );
  });

  it("rejects deactivation before drain when a preceding resume leaves READY_PAUSED", async () => {
    paused = true;
    insertCommand("resume");
    insertCommand(
      "deactivate_permanent_r23" as OperatorActionType,
      JSON.stringify({ expectedVersion: 18, activationId: "permanent-1" }),
    );
    const cancelPermanentActivation = vi.fn(async () => "applied" as const);
    const fencePermanentR23Deactivation = vi.fn(async () => ({
      status: "rejected" as const,
      reason: "runtime-not-ready-paused",
    }));
    const finalizePermanentR23Deactivation = vi.fn();
    const cancels: unknown[] = [];
    bus.subscribe("CancelOrderRequested", async (event) => void cancels.push(event));

    await createPoller({
      fencePermanentR23Deactivation,
      finalizePermanentR23Deactivation,
      makerBuyFastCancel: { cancelPermanentActivation } as unknown as MakerBuyFastCancel,
    }).poll();

    expect([paused, cancelPermanentActivation.mock.calls.length, cancels.length]).toEqual([
      false,
      0,
      0,
    ]);
    expect(fencePermanentR23Deactivation).toHaveBeenCalledOnce();
    expect(finalizePermanentR23Deactivation).not.toHaveBeenCalled();
  });

  it("keeps a fenced deactivation pending when its scoped drain times out", async () => {
    insertCommand(
      "deactivate_permanent_r23" as OperatorActionType,
      JSON.stringify({ expectedVersion: 18, activationId: "permanent-1" }),
    );
    const fencePermanentR23Deactivation = vi.fn(async () => ({
      status: "fenced" as const,
      activationId: "permanent-1",
    }));
    const finalizePermanentR23Deactivation = vi.fn();
    const cancelPermanentActivation = vi.fn(async () => "rejected" as const);
    await createPoller({
      fencePermanentR23Deactivation,
      finalizePermanentR23Deactivation,
      makerBuyFastCancel: { cancelPermanentActivation } as unknown as MakerBuyFastCancel,
    }).poll();
    expect(fencePermanentR23Deactivation).toHaveBeenCalledOnce();
    expect(cancelPermanentActivation).toHaveBeenCalledOnce();
    expect(finalizePermanentR23Deactivation).not.toHaveBeenCalled();
    expect(cmdRepo.getPending()).toHaveLength(1);
  });

  describe("permanent R23 guarded activation", () => {
    it("guards activation and resumes a fenced deactivation after restart", async () => {
      const control = bootstrapControlDb(path.join(tmpDir, "permanent-control.db"));
      const ledger = bootstrapLedgerDb(path.join(tmpDir, "permanent-ledger.db"));
      control.db.exec("INSERT INTO runtime_control_state (id) VALUES (1)");
      const coordinator = (inFlightMakerBuys = 0) =>
        new PermanentR23ActivationCoordinator({
          controlDb: control.db,
          ledgerDb: ledger.db,
          profileId: "live-lite",
          inFlightMakerBuys: () => inFlightMakerBuys,
          now: () => Date.parse("2026-08-28T00:00:00.000Z"),
          activationId: () => "permanent-r23-activation-1",
        });
      const version = (
        control.db
          .prepare(
            "SELECT execution_policy_version AS version FROM runtime_control_state WHERE id=1",
          )
          .get() as { version: number }
      ).version;
      const commands = new SqliteOperatorCommandRepository(control.db);
      const actions = new SqliteOperatorActionRepository(control.db);
      const enqueue = (action: OperatorActionType, targetId: string) => {
        commands.insert({ action, targetId, reason: action, createdAt: new Date().toISOString() });
        return commands.getPending()[0]!;
      };
      const command = enqueue(
        "activate_permanent_r23" as OperatorActionType,
        JSON.stringify({ expectedVersion: version }),
      );

      expect(coordinator().activate(command, version)).toMatchObject({
        status: "rejected",
        reason: "runtime-not-ready-paused",
      });
      control.db
        .prepare(
          "UPDATE runtime_control_state SET runtime_status='ready_paused', paused=1 WHERE id=1",
        )
        .run();
      ledger.db
        .prepare(
          `INSERT INTO orders
          (order_id, client_order_id, token_id, side, order_type, price, size, size_usdc,
           status, bot_run_id, entry_style, decision_rule_id, signal_reason, metadata_json,
           created_at, updated_at)
         VALUES ('old-r23', 'old-r23-client', 'token', 'buy', 'GTC', .1, 10, 1,
           'open', 'run', 'maker', 'R23_DIP_TRIGGER', 'probe-entry', '{}', ?, ?)`,
        )
        .run(new Date().toISOString(), new Date().toISOString());
      expect(coordinator().activate(command, version)).toMatchObject({
        status: "rejected",
        reason: "old-bid-lineage-active",
      });
      ledger.db.prepare("DELETE FROM orders WHERE order_id='old-r23'").run();
      expect(coordinator(1).activate(command, version)).toMatchObject({
        status: "rejected",
        reason: "maker-reservation-active",
      });
      const applied = coordinator().activate(command, version);
      if (applied.status !== "applied") throw new Error(applied.reason);
      expect(applied.activationId).toBe("permanent-r23-activation-1");
      expect(coordinator().activate(command, version).status).toBe("applied");
      const readPolicy = control.db.prepare(
        "SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id='live-lite'",
      );
      const pollDeactivation = (
        owner: PermanentR23ActivationCoordinator,
        makerBuyFastCancel: MakerBuyFastCancel,
      ) =>
        new CommandPoller({
          commandRepo: commands,
          actionRepo: actions,
          bus: new InProcessEventBus(),
          log,
          getPaused: () => true,
          setPaused: () => {},
          makerBuyFastCancel,
          fencePermanentR23Deactivation: (cmd, expectedVersion, activationId) =>
            owner.fenceDeactivation(cmd, expectedVersion, activationId),
          finalizePermanentR23Deactivation: (cmd, activationId, completedAt) =>
            owner.finalizeDeactivation(cmd, activationId, completedAt),
        }).poll();
      const policy = JSON.parse((readPolicy.get() as { json: string }).json);
      expect([
        policy.makerEntry.mode,
        policy.makerEntry.captureBookReprice,
        policy.bounceAskCapture.enabled,
        policy.bounceAskCapture.maxRepricesPerRoot,
      ]).toEqual(["micro_live", { enabled: true, maxRepricesPerRoot: 5 }, true, 5]);
      expect(policy.makerEntry.permanentR23ActivationId).toBe(
        policy.bounceAskCapture.permanentR23ActivationId,
      );
      const activeJson = (readPolicy.get() as { json: string }).json;
      const stale = enqueue(
        "deactivate_permanent_r23" as OperatorActionType,
        JSON.stringify({ expectedVersion: version, activationId: applied.activationId }),
      );
      const staleDrain = vi.fn(async () => "rejected" as const);
      await pollDeactivation(coordinator(), {
        cancelPermanentActivation: staleDrain,
      } as unknown as MakerBuyFastCancel);
      expect(
        control.db.prepare("SELECT status FROM operator_commands WHERE id=?").get(stale.id),
      ).toEqual({ status: "rejected" });
      expect(staleDrain).not.toHaveBeenCalled();
      expect((readPolicy.get() as { json: string }).json).toBe(activeJson);
      const stop = enqueue(
        "deactivate_permanent_r23" as OperatorActionType,
        JSON.stringify({
          expectedVersion: version + 1,
          activationId: applied.activationId,
        }),
      );
      expect(coordinator().fenceDeactivation(stop, version + 1, applied.activationId).status).toBe(
        "fenced",
      );
      expect(commands.getPending().map((pending) => pending.id)).toEqual([stop.id]);
      const disabled = JSON.parse((readPolicy.get() as { json: string }).json);
      expect(disabled.makerEntry.mode).toBe("off");
      disabled.entryPriceCeiling = 0.44;
      control.db
        .transaction(() => {
          control.db
            .prepare(
              "UPDATE profile_settings SET execution_policy_json=? WHERE profile_id='live-lite'",
            )
            .run(JSON.stringify(disabled));
          control.db
            .prepare(
              "UPDATE runtime_control_state SET execution_policy_version=execution_policy_version+1 WHERE id=1",
            )
            .run();
        })
        .immediate();
      const drain = vi.fn(async (_id, commit: (completedAt: string) => Promise<void>) => {
        await commit(applied.completedAt);
        return "applied" as const;
      });
      await pollDeactivation(coordinator(), {
        cancelPermanentActivation: drain,
      } as unknown as MakerBuyFastCancel);
      const finalized = JSON.parse((readPolicy.get() as { json: string }).json);
      expect([
        commands.getPending().length,
        actions.findRecent(10).length,
        drain.mock.calls.length,
        finalized.entryPriceCeiling,
        finalized.makerEntry.mode,
        finalized.makerEntry.permanentR23ActivationId,
        finalized.bounceAskCapture.enabled,
        finalized.bounceAskCapture.permanentR23ActivationId,
        finalized.bounceAskCapture.maxRepricesPerRoot,
      ]).toEqual([0, 2, 1, 0.44, "off", applied.activationId, true, applied.activationId, 5]);
      control.close();
      ledger.close();
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

    it("scoped permanent drain cancels only its roots and children", async () => {
      const activationId = "permanent-r23-activation-1";
      const makeOpen = (id: string, origin: Record<string, unknown>) =>
        ({ orderId: createOrderId(id), metadata: { quoteMotionV1: origin } }) as unknown as Order;
      const permanent = { permanentR23ActivationId: activationId };
      let open = [
        makeOpen("permanent-root", permanent),
        makeOpen("permanent-child", permanent),
        makeOpen("v120-root", { kind: "r23_capture", cohortId: activationTs }),
        makeOpen("gate-maker", {}),
        makeOpen("unrelated-maker", {}),
      ];
      let intents = [{ intentId: "permanent-intent", rootOrderId: open[0]!.orderId }];
      const cancelled: string[] = [];
      bus.subscribe("CancelOrderRequested", async ({ command }) => {
        cancelled.push(String(command.orderId));
        open = open.filter((candidate) => candidate.orderId !== command.orderId);
      });
      const coordinator = new MakerBuyFastCancel({
        orderRepo: {
          findOpen: () => open,
          findById: (id) => open.find((order) => order.orderId === id) ?? null,
          findRecoverableMakerCaptureRepriceIntents: () => intents as never[],
          markMakerCaptureRepriceTerminal: () => ((intents = []), true),
        },
        bus,
        isMakerModeOff: () => false,
        inFlightMakerBuys: () => 0,
        inFlightPermanentR23: () => 0,
      });
      coordinator.setReady(true);

      expect(await coordinator.cancelPermanentActivation(activationId, async () => {})).toBe(
        "applied",
      );
      expect(cancelled.sort()).toEqual(["permanent-child", "permanent-root"]);
      expect(intents).toEqual([]);
      expect(open.map((candidate) => String(candidate.orderId)).sort()).toEqual([
        "gate-maker",
        "unrelated-maker",
        "v120-root",
      ]);
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
      "keeps deferred pending for retry and handles %s safely",
      async (status) => {
        const id = insertCommand("recover_missing_bounce_exit", "predecessor-1", "repair");
        const recovery = vi
          .fn()
          .mockResolvedValueOnce({ status })
          .mockResolvedValue({ status: "applied", completedAt: "2026-08-22T00:00:00.000Z" });
        const poller = createPoller({ recoverMissingBounceExit: recovery });
        await poller.poll();
        const readStatus = () =>
          conn.db.prepare("SELECT status FROM operator_commands WHERE id = ?").get(id) as {
            status: string;
          };
        expect(readStatus().status).toBe(status === "deferred" ? "pending" : "rejected");
        if (status === "deferred") {
          await poller.poll();
          expect(readStatus().status).toBe("applied");
          expect(recovery).toHaveBeenCalledTimes(2);
          return;
        }
        expect(actionRepo.findRecent(10)).toEqual([]);
      },
    );
  });

  describe("unknown action", () => {
    it("rejects unrecognized action strings, marks status=rejected, no audit, no OperatorCommandApplied", async () => {
      const events: Array<{ action: string }> = [];
      bus.subscribe("OperatorCommandApplied", async (payload) => {
        events.push({ action: payload.action });
      });

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
