import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  createSwitchId,
  createReportId,
  createImportId,
} from "@plankton/domain";
import type {
  Profile,
  ProfileSettings,
  ProfileSummary,
  RuntimeControlState,
  SwitchRequest,
  PreflightReport,
  ServiceHeartbeat,
  ConfigImport,
} from "@plankton/domain";
import type { ProfileId } from "@plankton/domain";
import { SqliteProfileRepository } from "../repositories/profile-repository.js";
import { SqliteProfileSettingsRepository } from "../repositories/profile-settings-repository.js";
import { SqliteProfileSummaryRepository } from "../repositories/profile-summary-repository.js";
import { SqliteRuntimeControlStateRepository } from "../repositories/runtime-control-state-repository.js";
import { SqliteSwitchRequestRepository } from "../repositories/switch-request-repository.js";
import { SqlitePreflightReportRepository } from "../repositories/preflight-report-repository.js";
import { SqliteServiceHeartbeatRepository } from "../repositories/service-heartbeat-repository.js";
import { SqliteConfigImportRepository } from "../repositories/config-import-repository.js";

const PROFILE_SIM = "simulation" as ProfileId;
const NOW = "2026-03-30T12:00:00.000Z";

function createControlDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(join(import.meta.dirname, "..", "schemas", "control.sql"), "utf-8");
  db.exec(schema);
  return db;
}

function seedProfile(db: Database.Database): void {
  db.prepare(
    "INSERT INTO profiles (profile_id, display_name, description, created_at) VALUES (?, ?, ?, ?)",
  ).run(PROFILE_SIM, "Simulation", "Sim profile", NOW);
}

let db: Database.Database;

beforeEach(() => {
  db = createControlDb();
  seedProfile(db);
});

afterEach(() => {
  db.close();
});

describe("SqliteProfileRepository", () => {
  it("save + findById round-trip", () => {
    const repo = new SqliteProfileRepository(db);
    const profile: Profile = {
      profileId: "paper" as ProfileId,
      displayName: "Paper Trading",
      description: "Paper mode",
      createdAt: NOW,
    };
    repo.save(profile);
    const found = repo.findById("paper" as ProfileId);
    expect(found).toEqual(profile);
  });

  it("findAll returns seeded + saved profiles", () => {
    const repo = new SqliteProfileRepository(db);
    const all = repo.findAll();
    expect(all.length).toBe(1);
    expect(all[0]!.profileId).toBe(PROFILE_SIM);
  });
});

describe("SqliteProfileSettingsRepository", () => {
  it("save + get round-trip", () => {
    const repo = new SqliteProfileSettingsRepository(db);
    const settings: ProfileSettings = {
      profileId: PROFILE_SIM,
      initialBalanceUsdc: 10000,
      envelopeJson: '{"max": 500}',
      riskCapsJson: null,
      walletMode: null,
      minOrderUsdc: null,
      relayerJson: null,
      updatedAt: NOW,
    };
    repo.save(settings);
    const found = repo.get(PROFILE_SIM);
    expect(found).toEqual(settings);
  });
});

// SqliteValidationScorecardRepository tests removed — family_validation_scorecards
// was dropped by control migration 036. The repository class and domain interface
// remain for Phase 8 cleanup (runtime publisher still references it).

describe("SqliteProfileSummaryRepository", () => {
  it("save + get round-trip", () => {
    const repo = new SqliteProfileSummaryRepository(db);
    const summary: ProfileSummary = {
      profileId: PROFILE_SIM,
      paused: true,
      lastRunAt: null,
      openOrders: 3,
      openPositions: 5,
      totalExposureUsdc: 250.0,
      balanceUsdc: 9750.0,
      lastPreflightStatus: "passed",
      updatedAt: NOW,
    };
    repo.save(summary);
    const found = repo.get(PROFILE_SIM);
    expect(found).toEqual(summary);
  });

  it("getAll returns saved summaries", () => {
    const repo = new SqliteProfileSummaryRepository(db);
    repo.save({
      profileId: PROFILE_SIM,
      paused: false,
      lastRunAt: NOW,
      openOrders: 0,
      openPositions: 0,
      totalExposureUsdc: 0,
      balanceUsdc: null,
      lastPreflightStatus: null,
      updatedAt: NOW,
    });
    expect(repo.getAll()).toHaveLength(1);
  });
});

describe("SqliteRuntimeControlStateRepository", () => {
  it("save + get round-trip (singleton)", () => {
    const repo = new SqliteRuntimeControlStateRepository(db);
    const state: RuntimeControlState = {
      currentProfile: PROFILE_SIM,
      desiredProfile: null,
      currentSwitchId: null,
      currentRunId: "run-123",
      currentInstanceId: "inst-abc",
      runtimeStatus: "stopped",
      paused: true,
      schemaVersion: 1,
      updatedAt: NOW,
    };
    repo.save(state);
    const found = repo.get();
    expect(found).toEqual(state);
  });

  it("save overwrites existing singleton", () => {
    const repo = new SqliteRuntimeControlStateRepository(db);
    repo.save({
      currentProfile: PROFILE_SIM,
      desiredProfile: null,
      currentSwitchId: null,
      currentRunId: null,
      currentInstanceId: null,
      runtimeStatus: "stopped",
      paused: true,
      schemaVersion: 1,
      updatedAt: NOW,
    });
    repo.save({
      currentProfile: PROFILE_SIM,
      desiredProfile: null,
      currentSwitchId: null,
      currentRunId: "run-2",
      currentInstanceId: null,
      runtimeStatus: "running",
      paused: false,
      schemaVersion: 1,
      updatedAt: NOW,
    });
    const found = repo.get()!;
    expect(found.runtimeStatus).toBe("running");
    expect(found.paused).toBe(false);
  });
});

describe("SqliteSwitchRequestRepository", () => {
  it("save + findById round-trip", () => {
    const repo = new SqliteSwitchRequestRepository(db);
    // Need a second profile for the switch
    db.prepare("INSERT INTO profiles (profile_id, display_name, created_at) VALUES (?, ?, ?)").run(
      "paper",
      "Paper",
      NOW,
    );

    const request: SwitchRequest = {
      switchId: createSwitchId("sw-1"),
      fromProfile: PROFILE_SIM,
      toProfile: "paper" as ProfileId,
      ledgerResetPolicy: "preserve",
      deployPlanJson: null,
      state: "requested",
      errorMessage: null,
      archivePath: null,
      requestedBy: "operator",
      requestedAt: NOW,
      startedAt: null,
      completedAt: null,
    };
    repo.save(request);
    const found = repo.findById(createSwitchId("sw-1"));
    expect(found).toEqual(request);
  });

  it("findActive returns non-terminal requests", () => {
    const repo = new SqliteSwitchRequestRepository(db);
    db.prepare("INSERT INTO profiles (profile_id, display_name, created_at) VALUES (?, ?, ?)").run(
      "paper",
      "Paper",
      NOW,
    );

    repo.save({
      switchId: createSwitchId("sw-active"),
      fromProfile: PROFILE_SIM,
      toProfile: "paper" as ProfileId,
      ledgerResetPolicy: "preserve",
      deployPlanJson: null,
      state: "pausing",
      errorMessage: null,
      archivePath: null,
      requestedBy: null,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
    });
    expect(repo.findActive()).not.toBeNull();
    expect(repo.findActive()!.switchId).toBe("sw-active");
  });

  it("updateState transitions state", () => {
    const repo = new SqliteSwitchRequestRepository(db);
    db.prepare("INSERT INTO profiles (profile_id, display_name, created_at) VALUES (?, ?, ?)").run(
      "paper",
      "Paper",
      NOW,
    );

    repo.save({
      switchId: createSwitchId("sw-2"),
      fromProfile: PROFILE_SIM,
      toProfile: "paper" as ProfileId,
      ledgerResetPolicy: "preserve",
      deployPlanJson: null,
      state: "requested",
      errorMessage: null,
      archivePath: null,
      requestedBy: null,
      requestedAt: NOW,
      startedAt: null,
      completedAt: null,
    });
    repo.updateState(createSwitchId("sw-2"), "failed", "something broke");
    const found = repo.findById(createSwitchId("sw-2"))!;
    expect(found.state).toBe("failed");
    expect(found.errorMessage).toBe("something broke");
    expect(found.completedAt).not.toBeNull();
  });
});

describe("SqlitePreflightReportRepository", () => {
  it("save + findById round-trip", () => {
    const repo = new SqlitePreflightReportRepository(db);
    const report: PreflightReport = {
      reportId: createReportId("rpt-1"),
      switchRequestId: null,
      profile: PROFILE_SIM,
      kind: "startup",
      status: "passed",
      blockersJson: null,
      warningsJson: '["low balance"]',
      infoJson: null,
      createdAt: NOW,
    };
    repo.save(report);
    const found = repo.findById(createReportId("rpt-1"));
    expect(found).toEqual(report);
  });

  it("findLatestByProfile returns most recent", () => {
    const repo = new SqlitePreflightReportRepository(db);
    repo.save({
      reportId: createReportId("rpt-old"),
      switchRequestId: null,
      profile: PROFILE_SIM,
      kind: "precheck",
      status: "failed",
      blockersJson: null,
      warningsJson: null,
      infoJson: null,
      createdAt: "2026-03-29T00:00:00.000Z",
    });
    repo.save({
      reportId: createReportId("rpt-new"),
      switchRequestId: null,
      profile: PROFILE_SIM,
      kind: "startup",
      status: "passed",
      blockersJson: null,
      warningsJson: null,
      infoJson: null,
      createdAt: "2026-03-30T00:00:00.000Z",
    });
    const latest = repo.findLatestByProfile(PROFILE_SIM)!;
    expect(latest.reportId).toBe("rpt-new");
  });
});

describe("SqliteServiceHeartbeatRepository", () => {
  it("upsert + findByService round-trip", () => {
    const repo = new SqliteServiceHeartbeatRepository(db);
    const heartbeat: ServiceHeartbeat = {
      serviceName: "runtime",
      instanceId: "inst-1",
      profile: PROFILE_SIM,
      runId: "run-1",
      lastHeartbeatAt: NOW,
      statusJson: '{"healthy": true}',
    };
    repo.upsert(heartbeat);
    const found = repo.findByService("runtime");
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(heartbeat);
  });

  it("upsert overwrites on same PK", () => {
    const repo = new SqliteServiceHeartbeatRepository(db);
    repo.upsert({
      serviceName: "runtime",
      instanceId: "inst-1",
      profile: PROFILE_SIM,
      runId: "run-1",
      lastHeartbeatAt: NOW,
      statusJson: null,
    });
    repo.upsert({
      serviceName: "runtime",
      instanceId: "inst-1",
      profile: PROFILE_SIM,
      runId: "run-2",
      lastHeartbeatAt: "2026-03-30T13:00:00.000Z",
      statusJson: '{"v": 2}',
    });
    const all = repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.runId).toBe("run-2");
  });
});

describe("SqliteConfigImportRepository", () => {
  it("save + findById round-trip", () => {
    const repo = new SqliteConfigImportRepository(db);
    const record: ConfigImport = {
      importId: createImportId("imp-1"),
      sourcePath: "/config/family_rules.yaml",
      sourceChecksum: "abc123",
      sourceVersion: 1,
      resultJson: null,
      importedAt: NOW,
      importedBy: "operator",
    };
    repo.save(record);
    const found = repo.findById(createImportId("imp-1"));
    expect(found).toEqual(record);
  });

  it("findLatest returns most recent import", () => {
    const repo = new SqliteConfigImportRepository(db);
    repo.save({
      importId: createImportId("imp-old"),
      sourcePath: null,
      sourceChecksum: "aaa",
      sourceVersion: null,
      resultJson: null,
      importedAt: "2026-03-29T00:00:00.000Z",
      importedBy: null,
    });
    repo.save({
      importId: createImportId("imp-new"),
      sourcePath: null,
      sourceChecksum: "bbb",
      sourceVersion: null,
      resultJson: null,
      importedAt: "2026-03-30T00:00:00.000Z",
      importedBy: null,
    });
    expect(repo.findLatest()!.importId).toBe("imp-new");
  });
});
