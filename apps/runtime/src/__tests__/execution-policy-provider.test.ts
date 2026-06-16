import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, SqliteProfileSettingsRepository, type DbConnection } from "@krabs/db";
import { DEFAULT_EXECUTION_POLICY } from "@krabs/domain";
import type { ProfileId } from "@krabs/domain";
import type { Logger } from "../logger.js";
import { ExecutionPolicyProvider } from "../execution-policy-provider.js";

const CONTROL_SQL = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/db/src/schemas/control.sql"),
  "utf-8",
);

const PROFILE: ProfileId = "paper" as ProfileId;
const NOW = "2026-04-24T12:00:00.000Z";

type LogEntry = { level: string; obj: unknown; msg: string };

function createLogger(sink: LogEntry[]): Logger {
  const log = {
    info(obj: unknown, msg: string) {
      sink.push({ level: "info", obj, msg });
    },
    warn(obj: unknown, msg: string) {
      sink.push({ level: "warn", obj, msg });
    },
    error(obj: unknown, msg: string) {
      sink.push({ level: "error", obj, msg });
    },
    debug() {},
    fatal() {},
    child() {
      return log;
    },
  } as unknown as Logger;
  return log;
}

function seedControlRow(db: DbConnection["db"], version = 0): void {
  db.prepare(
    `INSERT INTO profiles (profile_id, display_name) VALUES (?, 'Paper')
     ON CONFLICT(profile_id) DO NOTHING`,
  ).run(PROFILE);
  db.prepare(
    `INSERT INTO profile_settings (profile_id, initial_balance_usdc, updated_at)
     VALUES (?, 1000, ?)`,
  ).run(PROFILE, NOW);
  db.prepare(
    `INSERT INTO runtime_control_state
       (id, current_profile, runtime_status, paused, schema_version,
        execution_policy_version, updated_at)
     VALUES (1, ?, 'stopped', 1, 1, ?, ?)`,
  ).run(PROFILE, version, NOW);
}

describe("ExecutionPolicyProvider (ADR-015)", () => {
  let conn: DbConnection;
  let repo: SqliteProfileSettingsRepository;
  let sink: LogEntry[];
  let log: Logger;

  beforeEach(() => {
    conn = openDatabase(":memory:");
    conn.db.exec(CONTROL_SQL);
    seedControlRow(conn.db);
    repo = new SqliteProfileSettingsRepository(conn.db);
    sink = [];
    log = createLogger(sink);
  });

  afterEach(() => {
    conn.close();
  });

  function makeProvider(): ExecutionPolicyProvider {
    return new ExecutionPolicyProvider({
      controlDb: conn.db,
      profileSettingsRepo: repo,
      log,
      profileId: PROFILE,
    });
  }

  it("bootstraps with defaults when no policy is persisted", () => {
    const provider = makeProvider();
    expect(provider.snapshot()).toBe(DEFAULT_EXECUTION_POLICY);
    expect(provider.version()).toBe(0);
  });

  it("bootstraps to DEFAULT when persisted JSON is invalid (regression: no undefined snapshot)", () => {
    // Write invalid JSON directly so the provider's constructor sees it
    // before calling loadFromDb. Pre-fix, `currentPolicy` was only assigned
    // AFTER loadFromDb and the invalid-JSON branch returned `this.currentPolicy`
    // (undefined). Post-fix it must fall back to DEFAULT_EXECUTION_POLICY.
    conn.db
      .prepare("UPDATE profile_settings SET execution_policy_json = ? WHERE profile_id = ?")
      .run("{not-json", PROFILE);
    const provider = makeProvider();
    expect(provider.snapshot()).toBe(DEFAULT_EXECUTION_POLICY);
    // The invalid-JSON error path fires on bootstrap too.
    expect(
      sink.some(
        (e) =>
          e.level === "error" &&
          e.msg === "execution policy JSON invalid; keeping last-good snapshot",
      ),
    ).toBe(true);
  });

  it("bootstraps with persisted policy and its version", () => {
    repo.save({
      profileId: PROFILE,
      initialBalanceUsdc: 1000,
      envelopeJson: null,
      riskCapsJson: null,
      walletMode: null,
      minOrderUsdc: null,
      relayerJson: null,
      executionPolicyJson: JSON.stringify({ entryPriceCeiling: 0.6 }),
      updatedAt: NOW,
    });
    const provider = makeProvider();
    expect(provider.snapshot().entryPriceCeiling).toBe(0.6);
    expect(provider.version()).toBeGreaterThanOrEqual(1);
  });

  it("refreshIfStale returns false when version unchanged", () => {
    const provider = makeProvider();
    const before = provider.snapshot();
    expect(provider.refreshIfStale()).toBe(false);
    expect(provider.snapshot()).toBe(before);
  });

  it("refreshIfStale hot-reloads on version bump", () => {
    const provider = makeProvider();
    expect(provider.snapshot()).toBe(DEFAULT_EXECUTION_POLICY);
    repo.save({
      profileId: PROFILE,
      initialBalanceUsdc: 1000,
      envelopeJson: null,
      riskCapsJson: null,
      walletMode: null,
      minOrderUsdc: null,
      relayerJson: null,
      executionPolicyJson: JSON.stringify({ entryPriceCeiling: 0.42 }),
      updatedAt: NOW,
    });
    expect(provider.refreshIfStale()).toBe(true);
    expect(provider.snapshot().entryPriceCeiling).toBe(0.42);
    expect(sink.some((e) => e.msg === "execution policy reloaded")).toBe(true);
  });

  it("notifies reload listeners after a valid version bump", () => {
    const provider = makeProvider();
    const observed: number[] = [];
    const unsubscribe = provider.onReload((policy) => {
      observed.push(policy.entryPriceCeiling);
    });

    repo.save({
      profileId: PROFILE,
      initialBalanceUsdc: 1000,
      envelopeJson: null,
      riskCapsJson: null,
      walletMode: null,
      minOrderUsdc: null,
      relayerJson: null,
      executionPolicyJson: JSON.stringify({ entryPriceCeiling: 0.42 }),
      updatedAt: NOW,
    });
    expect(provider.refreshIfStale()).toBe(true);
    unsubscribe();
    repo.save({
      profileId: PROFILE,
      initialBalanceUsdc: 1000,
      envelopeJson: null,
      riskCapsJson: null,
      walletMode: null,
      minOrderUsdc: null,
      relayerJson: null,
      executionPolicyJson: JSON.stringify({ entryPriceCeiling: 0.43 }),
      updatedAt: NOW,
    });
    expect(provider.refreshIfStale()).toBe(true);

    expect(observed).toEqual([0.42]);
  });

  it("keeps last-good snapshot when stored JSON is invalid, advances version", () => {
    const provider = makeProvider();
    const goodJson = JSON.stringify({ entryPriceCeiling: 0.5 });
    repo.save({
      profileId: PROFILE,
      initialBalanceUsdc: 1000,
      envelopeJson: null,
      riskCapsJson: null,
      walletMode: null,
      minOrderUsdc: null,
      relayerJson: null,
      executionPolicyJson: goodJson,
      updatedAt: NOW,
    });
    expect(provider.refreshIfStale()).toBe(true);
    expect(provider.snapshot().entryPriceCeiling).toBe(0.5);
    const goodSnapshot = provider.snapshot();

    // Overwrite with malformed JSON via a raw UPDATE so the repo's bump fires.
    conn.db
      .prepare("UPDATE profile_settings SET execution_policy_json = ? WHERE profile_id = ?")
      .run("{not-json", PROFILE);
    conn.db
      .prepare(
        "UPDATE runtime_control_state SET execution_policy_version = execution_policy_version + 1 WHERE id = 1",
      )
      .run();

    const oldVersion = provider.version();
    expect(provider.refreshIfStale()).toBe(false);
    expect(provider.snapshot()).toBe(goodSnapshot);
    expect(provider.version()).toBeGreaterThan(oldVersion);
    expect(
      sink.some(
        (e) =>
          e.level === "error" &&
          e.msg === "execution policy JSON invalid; keeping last-good snapshot",
      ),
    ).toBe(true);
  });

  it("reverts to defaults when policy JSON is cleared to null", () => {
    const provider = makeProvider();
    repo.save({
      profileId: PROFILE,
      initialBalanceUsdc: 1000,
      envelopeJson: null,
      riskCapsJson: null,
      walletMode: null,
      minOrderUsdc: null,
      relayerJson: null,
      executionPolicyJson: JSON.stringify({ entryPriceCeiling: 0.42 }),
      updatedAt: NOW,
    });
    provider.refreshIfStale();
    expect(provider.snapshot().entryPriceCeiling).toBe(0.42);

    repo.save({
      profileId: PROFILE,
      initialBalanceUsdc: 1000,
      envelopeJson: null,
      riskCapsJson: null,
      walletMode: null,
      minOrderUsdc: null,
      relayerJson: null,
      executionPolicyJson: null,
      updatedAt: NOW,
    });
    expect(provider.refreshIfStale()).toBe(true);
    expect(provider.snapshot()).toBe(DEFAULT_EXECUTION_POLICY);
  });

  it("forceReload re-reads without version change", () => {
    const provider = makeProvider();
    // Raw write without a repo bump — version stays the same.
    conn.db
      .prepare("UPDATE profile_settings SET execution_policy_json = ? WHERE profile_id = ?")
      .run(JSON.stringify({ entryPriceCeiling: 0.77 }), PROFILE);
    expect(provider.refreshIfStale()).toBe(false);
    expect(provider.snapshot()).toBe(DEFAULT_EXECUTION_POLICY);
    provider.forceReload();
    expect(provider.snapshot().entryPriceCeiling).toBe(0.77);
  });
});
