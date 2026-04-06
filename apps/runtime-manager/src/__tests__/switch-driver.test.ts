import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createSwitchId, SwitchState } from "@plankton/domain";
import type { ProfileId, SwitchId } from "@plankton/domain";
import {
  SqliteSwitchRequestRepository,
  SqliteRuntimeControlStateRepository,
  SqliteStateTransitionRepository,
} from "@plankton/db";
import { SwitchDriver } from "../switch-driver.js";
import { MockContainerControl } from "../container-control.js";

const FROM_PROFILE = "simulation" as ProfileId;
const TO_PROFILE = "paper" as ProfileId;
const NOW = "2026-03-30T12:00:00.000Z";

// Relative path from this test to the DB package schemas
const SCHEMA_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "src",
  "schemas",
  "control.sql",
);

function createControlDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
  return db;
}

function seedProfiles(db: Database.Database): void {
  const stmt = db.prepare(
    "INSERT INTO profiles (profile_id, display_name, created_at) VALUES (?, ?, ?)",
  );
  stmt.run(FROM_PROFILE, "Simulation", NOW);
  stmt.run(TO_PROFILE, "Paper", NOW);
}

function seedRuntimeState(db: Database.Database): void {
  db.prepare(
    `INSERT INTO runtime_control_state
     (id, current_profile, desired_profile, runtime_status, paused, schema_version, updated_at)
     VALUES (1, ?, ?, 'running', 0, 1, ?)`,
  ).run(FROM_PROFILE, FROM_PROFILE, NOW);
}

function insertSwitchRequest(db: Database.Database, switchId: SwitchId): void {
  db.prepare(
    `INSERT INTO profile_switch_requests
     (switch_id, from_profile, to_profile, state, requested_at)
     VALUES (?, ?, ?, 'requested', ?)`,
  ).run(switchId, FROM_PROFILE, TO_PROFILE, NOW);
}

const nullLog = {
  info(_obj: Record<string, unknown>, _msg: string) {},
  warn(_obj: Record<string, unknown>, _msg: string) {},
  error(_obj: Record<string, unknown>, _msg: string) {},
};

describe("SwitchDriver", () => {
  let db: Database.Database;
  let switchRepo: SqliteSwitchRequestRepository;
  let controlRepo: SqliteRuntimeControlStateRepository;
  let transitionRepo: SqliteStateTransitionRepository;
  let container: MockContainerControl;
  let driver: SwitchDriver;
  let switchId: SwitchId;

  beforeEach(() => {
    db = createControlDb();
    seedProfiles(db);
    seedRuntimeState(db);

    switchRepo = new SqliteSwitchRequestRepository(db);
    controlRepo = new SqliteRuntimeControlStateRepository(db);
    transitionRepo = new SqliteStateTransitionRepository(db);
    container = new MockContainerControl();

    driver = new SwitchDriver(db, switchRepo, controlRepo, transitionRepo, container, 30, nullLog);

    switchId = createSwitchId("switch-001");
  });

  it("tick() is a no-op when no active request exists", async () => {
    await driver.tick();
    // No error, no state changes
    expect(transitionRepo.findRecent(10)).toHaveLength(0);
  });

  it("drives full happy-path from requested to completed", async () => {
    insertSwitchRequest(db, switchId);

    // 1. requested -> pausing (inserts pause command)
    await driver.tick();
    expect(switchRepo.findById(switchId)?.state).toBe(SwitchState.Pausing);

    const cmds = db
      .prepare("SELECT * FROM operator_commands WHERE action = 'pause'")
      .all() as Array<Record<string, unknown>>;
    expect(cmds).toHaveLength(1);

    // 2. pausing -> stopping (waits for pause, then stops container)
    // Not yet paused -- tick should be no-op
    await driver.tick();
    expect(switchRepo.findById(switchId)?.state).toBe(SwitchState.Pausing);

    // Simulate runtime pausing
    db.prepare("UPDATE runtime_control_state SET paused = 1 WHERE id = 1").run();

    await driver.tick();
    expect(switchRepo.findById(switchId)?.state).toBe(SwitchState.Stopping);
    expect(container.stopCalls).toEqual([30]);

    // 3. stopping -> preparing_target (waits for container stop, updates desired_profile)
    // Container reports still running -- no-op
    container.running = true;
    await driver.tick();
    expect(switchRepo.findById(switchId)?.state).toBe(SwitchState.Stopping);

    // Container stopped
    container.running = false;
    await driver.tick();
    expect(switchRepo.findById(switchId)?.state).toBe(SwitchState.PreparingTarget);

    const desired = db
      .prepare("SELECT desired_profile FROM runtime_control_state WHERE id = 1")
      .get() as { desired_profile: string };
    expect(desired.desired_profile).toBe(TO_PROFILE);

    // 4. preparing_target -> starting_target (starts container)
    await driver.tick();
    expect(switchRepo.findById(switchId)?.state).toBe(SwitchState.StartingTarget);
    expect(container.startCalls).toBe(1);

    // 5. starting_target -> ready_paused (waits for runtime ready_paused)
    await driver.tick();
    expect(switchRepo.findById(switchId)?.state).toBe(SwitchState.StartingTarget);

    db.prepare(
      "UPDATE runtime_control_state SET runtime_status = 'ready_paused' WHERE id = 1",
    ).run();

    await driver.tick();
    expect(switchRepo.findById(switchId)?.state).toBe(SwitchState.ReadyPaused);

    // 6. ready_paused -> completed
    await driver.tick();
    const final = switchRepo.findById(switchId);
    expect(final?.state).toBe(SwitchState.Completed);
    expect(final?.completedAt).toBeTruthy();

    // Verify audit trail
    const transitions = transitionRepo.findByEntity("switch_request", switchId);
    const trail = transitions.map((t) => `${t.fromState}->${t.toState}`).reverse();
    expect(trail).toEqual([
      "requested->pausing",
      "pausing->stopping",
      "stopping->preparing_target",
      "preparing_target->starting_target",
      "starting_target->ready_paused",
      "ready_paused->completed",
    ]);
    expect(transitions.every((t) => t.profile === null)).toBe(true);
  });

  it("recover() logs in-flight switch without changing state", () => {
    insertSwitchRequest(db, switchId);

    // Advance to pausing
    db.prepare(
      "UPDATE profile_switch_requests SET state = 'pausing', started_at = ? WHERE switch_id = ?",
    ).run(NOW, switchId);

    const logged: Array<Record<string, unknown>> = [];
    const capturingLog = {
      ...nullLog,
      info(obj: Record<string, unknown>, _msg: string) {
        logged.push(obj);
      },
    };

    const recoverDriver = new SwitchDriver(
      db,
      switchRepo,
      controlRepo,
      transitionRepo,
      container,
      30,
      capturingLog,
    );

    recoverDriver.recover();
    expect(logged).toHaveLength(1);
    expect(logged[0]!["switchId"]).toBe(switchId);
    expect(logged[0]!["state"]).toBe(SwitchState.Pausing);

    // State unchanged
    expect(switchRepo.findById(switchId)?.state).toBe(SwitchState.Pausing);
  });

  it("transitions to failed on error and records error message", async () => {
    insertSwitchRequest(db, switchId);

    // Advance to pausing, simulate runtime paused
    db.prepare(
      "UPDATE profile_switch_requests SET state = 'pausing', started_at = ? WHERE switch_id = ?",
    ).run(NOW, switchId);
    db.prepare("UPDATE runtime_control_state SET paused = 1 WHERE id = 1").run();

    // Make container.stop throw
    container.stop = async () => {
      throw new Error("Docker daemon unreachable");
    };

    await driver.tick();

    const req = switchRepo.findById(switchId);
    expect(req?.state).toBe(SwitchState.Failed);
    expect(req?.errorMessage).toBe("Docker daemon unreachable");

    const transitions = transitionRepo.findByEntity("switch_request", switchId);
    expect(transitions[0]!.toState).toBe("failed");
  });

  it("subsequent tick() is no-op after completion", async () => {
    insertSwitchRequest(db, switchId);
    db.prepare(
      "UPDATE profile_switch_requests SET state = 'completed', completed_at = ? WHERE switch_id = ?",
    ).run(NOW, switchId);

    await driver.tick();
    expect(transitionRepo.findRecent(10)).toHaveLength(0);
  });
});
