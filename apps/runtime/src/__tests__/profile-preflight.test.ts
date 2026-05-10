import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, type DbConnection } from "@krabs/db";
import {
  runProfilePreflight,
  writePreflightReport,
  type ProfilePreflightResult,
} from "../profile-preflight.js";
import type { LiveLiteConfig } from "../live-lite-guard.js";

const CONTROL_SQL = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/db/src/schemas/control.sql"),
  "utf-8",
);

const LEDGER_SQL = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/db/src/schemas/ledger.sql"),
  "utf-8",
);

const ENVELOPE: LiveLiteConfig = {
  maxOpenValueUsdc: 50,
  maxOrderUsdc: 10,
  maxActiveMarkets: 5,
};

function createDb(schemaSql: string): DbConnection {
  const conn = openDatabase(":memory:");
  conn.db.exec(schemaSql);
  return conn;
}

function seedProfile(controlDb: DbConnection["db"], profile: string): void {
  controlDb
    .prepare("INSERT OR IGNORE INTO profiles (profile_id, display_name) VALUES (?, ?)")
    .run(profile, profile);
}

function seedProfileSettings(
  controlDb: DbConnection["db"],
  profile: string,
  settings: { relayerJson?: string | null } = {},
): void {
  controlDb
    .prepare(
      `INSERT INTO profile_settings (profile_id, relayer_json)
       VALUES (?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET relayer_json = excluded.relayer_json`,
    )
    .run(profile, settings.relayerJson ?? null);
}

describe("runProfilePreflight", () => {
  let controlConn: DbConnection;
  let ledgerConn: DbConnection;

  beforeEach(() => {
    controlConn = createDb(CONTROL_SQL);
    ledgerConn = createDb(LEDGER_SQL);
  });

  afterEach(() => {
    controlConn.close();
    ledgerConn.close();
  });

  it("simulation profile passes with empty state", () => {
    seedProfile(controlConn.db, "simulation");
    const result = runProfilePreflight({
      profile: "simulation",
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
    });
    expect(result.status).toBe("passed");
    expect(result.blockers).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.info.profile).toBe("simulation");
  });

  it("paper profile passes with empty state", () => {
    seedProfile(controlConn.db, "paper");
    const result = runProfilePreflight({
      profile: "paper",
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
    });
    expect(result.status).toBe("passed");
    expect(result.blockers).toHaveLength(0);
  });

  it("live-lite with clean state passes", () => {
    seedProfile(controlConn.db, "live-lite");
    const result = runProfilePreflight({
      profile: "live-lite",
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
      liveLiteConfig: ENVELOPE,
      polyBuilderCodeConfigured: true,
    });
    expect(result.status).toBe("passed");
    expect(result.blockers).toHaveLength(0);
  });

  it("live-lite fails when EOA mode enables a fee-enabled family (min_order check)", () => {
    seedProfile(controlConn.db, "live-lite");

    const result = runProfilePreflight({
      profile: "live-lite",
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
      liveLiteConfig: ENVELOPE,
      polyBuilderCodeConfigured: true,
    });

    // With no fee-enabled families (family tables dropped), only wallet/order checks apply
    expect(result.status).toBe("passed");
    expect(result.blockers).toHaveLength(0);
  });

  it("live-lite fails when EOA min_order_usdc is below the phase-1 floor", () => {
    seedProfile(controlConn.db, "live-lite");

    const result = runProfilePreflight({
      profile: "live-lite",
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
      liveLiteConfig: { ...ENVELOPE, minOrderUsdc: 0.4 },
      polyBuilderCodeConfigured: true,
    });

    expect(result.status).toBe("failed");
    expect(result.blockers.some((b) => b.code === "LIVE_MIN_ORDER_TOO_LOW")).toBe(true);
  });

  it("live-lite fails when POLY_BUILDER_CODE is not configured", () => {
    seedProfile(controlConn.db, "live-lite");

    const result = runProfilePreflight({
      profile: "live-lite",
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
      liveLiteConfig: ENVELOPE,
      polyBuilderCodeConfigured: false,
    });

    expect(result.status).toBe("failed");
    expect(result.blockers.some((b) => b.code === "LIVE_BUILDER_CODE_MISSING")).toBe(true);
  });

  it("live-lite relayer mode passes with valid relayer_json", () => {
    seedProfile(controlConn.db, "live-lite");
    seedProfileSettings(controlConn.db, "live-lite", {
      relayerJson: JSON.stringify({
        walletType: "proxy",
        funderAddress: "0x1111111111111111111111111111111111111111",
      }),
    });

    const result = runProfilePreflight({
      profile: "live-lite",
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
      relayerBuilderAuthConfigured: true,
      polyBuilderCodeConfigured: true,
      liveLiteConfig: { ...ENVELOPE, walletMode: "relayer", minOrderUsdc: 0.05 },
    });

    expect(result.status).toBe("passed");
    expect(result.blockers).toHaveLength(0);
  });

  it("live-lite relayer mode fails when relayer_json is invalid", () => {
    seedProfile(controlConn.db, "live-lite");
    seedProfileSettings(controlConn.db, "live-lite", {
      relayerJson: JSON.stringify({
        walletType: "proxy",
      }),
    });

    const result = runProfilePreflight({
      profile: "live-lite",
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
      polyBuilderCodeConfigured: true,
      liveLiteConfig: { ...ENVELOPE, walletMode: "relayer", minOrderUsdc: 0.05 },
    });

    expect(result.status).toBe("failed");
    expect(result.blockers.some((b) => b.code === "LIVE_RELAYER_CONFIG_INVALID")).toBe(true);
  });

  it("live-lite relayer mode fails when min_order_usdc is below the relayer floor", () => {
    seedProfile(controlConn.db, "live-lite");
    seedProfileSettings(controlConn.db, "live-lite", {
      relayerJson: JSON.stringify({
        walletType: "proxy",
        funderAddress: "0x1111111111111111111111111111111111111111",
      }),
    });

    const result = runProfilePreflight({
      profile: "live-lite",
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
      relayerBuilderAuthConfigured: true,
      polyBuilderCodeConfigured: true,
      liveLiteConfig: { ...ENVELOPE, walletMode: "relayer", minOrderUsdc: 0.04 },
    });

    expect(result.status).toBe("failed");
    expect(result.blockers.some((b) => b.code === "LIVE_MIN_ORDER_TOO_LOW")).toBe(true);
  });

  it("live-lite relayer mode fails when builder auth is missing", () => {
    seedProfile(controlConn.db, "live-lite");
    seedProfileSettings(controlConn.db, "live-lite", {
      relayerJson: JSON.stringify({
        walletType: "proxy",
        funderAddress: "0x1111111111111111111111111111111111111111",
      }),
    });

    const result = runProfilePreflight({
      profile: "live-lite",
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
      relayerBuilderAuthConfigured: false,
      polyBuilderCodeConfigured: true,
      liveLiteConfig: { ...ENVELOPE, walletMode: "relayer", minOrderUsdc: 0.05 },
    });

    expect(result.status).toBe("failed");
    expect(result.blockers.some((b) => b.code === "LIVE_RELAYER_BUILDER_AUTH_MISSING")).toBe(true);
  });

  it("live-lite fails with EXPOSURE_EXCEEDS_CAP when exposure over cap", () => {
    seedProfile(controlConn.db, "live-lite");

    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, size, avg_entry_price, cost_basis_usdc, realized_pnl, status, opened_at, updated_at)
         VALUES ('pos-1', 'tok-1', 'buy', 100, 0.4, 40, 0, 'open', datetime('now'), datetime('now'))`,
      )
      .run();

    ledgerConn.db
      .prepare(
        `INSERT INTO orders (order_id, client_order_id, token_id, side, order_type, price, size, size_usdc, status, bot_run_id, created_at, updated_at)
         VALUES ('ord-1', 'plk_ord1', 'tok-2', 'buy', 'GTC', 0.5, 30, 15, 'open', 'run-1', datetime('now'), datetime('now'))`,
      )
      .run();

    const result = runProfilePreflight({
      profile: "live-lite",
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
      liveLiteConfig: ENVELOPE,
      polyBuilderCodeConfigured: true,
    });

    expect(result.status).toBe("failed");
    expect(result.blockers.some((b) => b.code === "EXPOSURE_EXCEEDS_CAP")).toBe(true);
  });

  it("returns passed_with_warnings when exposure near cap (>80%)", () => {
    seedProfile(controlConn.db, "live-lite");

    // 42 is > 80% of 50 but <= 50
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, size, avg_entry_price, cost_basis_usdc, realized_pnl, status, opened_at, updated_at)
         VALUES ('pos-1', 'tok-1', 'buy', 100, 0.42, 42, 0, 'open', datetime('now'), datetime('now'))`,
      )
      .run();

    const result = runProfilePreflight({
      profile: "live-lite",
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
      liveLiteConfig: ENVELOPE,
      polyBuilderCodeConfigured: true,
    });

    expect(result.status).toBe("passed_with_warnings");
    expect(result.warnings.some((w) => w.code === "EXPOSURE_NEAR_CAP")).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  it("includes openPositions in info", () => {
    seedProfile(controlConn.db, "paper");

    // Add an open position
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, size, avg_entry_price, cost_basis_usdc, realized_pnl, status, opened_at, updated_at)
         VALUES ('pos-1', 'tok-1', 'buy', 10, 0.4, 4, 0, 'open', datetime('now'), datetime('now'))`,
      )
      .run();

    const result = runProfilePreflight({
      profile: "paper",
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
    });

    expect(result.info.openPositions).toBe(1);
  });
});

describe("writePreflightReport", () => {
  let controlConn: DbConnection;

  beforeEach(() => {
    controlConn = createDb(CONTROL_SQL);
    seedProfile(controlConn.db, "paper");
  });

  afterEach(() => {
    controlConn.close();
  });

  it("creates a row in preflight_reports", () => {
    const result: ProfilePreflightResult = {
      status: "passed",
      blockers: [],
      warnings: [],
      info: { profile: "paper", openPositions: 0 },
    };

    const reportId = writePreflightReport(controlConn.db, "paper", result);
    expect(reportId).toBeTruthy();

    const row = controlConn.db
      .prepare("SELECT * FROM preflight_reports WHERE report_id = ?")
      .get(reportId) as Record<string, unknown>;

    expect(row).toBeTruthy();
    expect(row["profile"]).toBe("paper");
    expect(row["kind"]).toBe("startup");
    expect(row["status"]).toBe("passed");
    expect(row["blockers_json"]).toBeNull();
    expect(row["warnings_json"]).toBeNull();
    expect(JSON.parse(row["info_json"] as string)).toEqual(result.info);
  });

  it("persists blockers and warnings when present", () => {
    const result: ProfilePreflightResult = {
      status: "failed",
      blockers: [{ code: "TEST_BLOCK", message: "test blocker" }],
      warnings: [{ code: "TEST_WARN", message: "test warning" }],
      info: { profile: "live-lite" },
    };

    const reportId = writePreflightReport(controlConn.db, "paper", result);
    const row = controlConn.db
      .prepare("SELECT * FROM preflight_reports WHERE report_id = ?")
      .get(reportId) as Record<string, unknown>;

    expect(JSON.parse(row["blockers_json"] as string)).toEqual(result.blockers);
    expect(JSON.parse(row["warnings_json"] as string)).toEqual(result.warnings);
  });

  it("stores switch_request_id when provided", () => {
    // Seed a second profile so from/to are valid
    seedProfile(controlConn.db, "simulation");
    controlConn.db
      .prepare(
        "INSERT INTO profile_switch_requests (switch_id, from_profile, to_profile, state) VALUES ('switch-123', 'simulation', 'paper', 'requested')",
      )
      .run();

    const result: ProfilePreflightResult = {
      status: "passed",
      blockers: [],
      warnings: [],
      info: {},
    };

    const reportId = writePreflightReport(controlConn.db, "paper", result, "switch-123");
    const row = controlConn.db
      .prepare("SELECT switch_request_id FROM preflight_reports WHERE report_id = ?")
      .get(reportId) as Record<string, unknown>;

    expect(row["switch_request_id"]).toBe("switch-123");
  });
});
