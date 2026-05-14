import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapControlDb, bootstrapLedgerDb } from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import { buildServer } from "../server.js";
import { diffFields, recordHistory, toStorageValue } from "../profile-settings-history.js";
import { MARKET_DATA_TEST_DEFAULTS, stubLedgerPool } from "./test-helpers.js";

const TEST_API_KEY = "test-key-history";

function testConfig(): AppConfig {
  return {
    runtimeMode: "simulation",
    logLevel: "error",
    dbPath: "",
    marketDataPollIntervalMs: 30_000,
    marketDataStaleThresholdMs: 120_000,
    marketScanIntervalMs: 300_000,
    strategyScanIntervalMs: 5_000,
    fillPollIntervalMs: 5_000,
    enableInventoryAutoMerge: false,
    executionMaxConcurrency: 4,
    executionWalletBufferPct: 0.03,
    executionWalletBufferMinUsdc: 0.25,
    polyApiKey: undefined,
    polyApiSecret: undefined,
    polyPassphrase: undefined,
    polyPrivateKey: undefined,
    krabsApiKey: TEST_API_KEY,
    krabsApiPort: 0,
    krabsAuthUsername: undefined,
    krabsAuthPassword: undefined,
    krabsSessionSecret: undefined,
    allowSellSizeClamp: true,
    executionSellBalanceRejectBlockEnabled: true,
    executionSellBalanceRejectBlockMs: 60_000,
    executionSellExchangeReservedEnabled: true,
    trustProxy: false,
    ...MARKET_DATA_TEST_DEFAULTS,
  } as AppConfig;
}

const authHeaders = () => ({
  authorization: `Bearer ${TEST_API_KEY}`,
  "content-type": "application/json",
});

describe("profile-settings-history helper", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE profile_settings_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id   TEXT NOT NULL,
        field        TEXT NOT NULL,
        before_value TEXT,
        after_value  TEXT,
        actor        TEXT NOT NULL,
        source       TEXT NOT NULL,
        reason       TEXT,
        changed_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => db.close());

  it("toStorageValue stringifies numbers and preserves null", () => {
    expect(toStorageValue(null)).toBeNull();
    expect(toStorageValue(undefined)).toBeNull();
    expect(toStorageValue(0)).toBe("0");
    expect(toStorageValue(2.5)).toBe("2.5");
    expect(toStorageValue("eoa")).toBe("eoa");
  });

  it("diffFields ignores untracked columns and returns only changed tracked fields", () => {
    const diffs = diffFields(
      { envelope_json: '{"max":50}', wallet_mode: "eoa", garbage: "x" },
      { envelope_json: '{"max":60}', wallet_mode: "eoa", garbage: "y" },
    );
    expect(diffs).toEqual([{ field: "envelope_json", before: '{"max":50}', after: '{"max":60}' }]);
  });

  it("diffFields treats null↔value transitions as changes", () => {
    const diffs = diffFields(
      { min_order_usdc: null, relayer_json: null },
      { min_order_usdc: 1.5, relayer_json: '{"endpoint":"x"}' },
    );
    expect(diffs).toHaveLength(2);
    expect(diffs.find((d) => d.field === "min_order_usdc")).toEqual({
      field: "min_order_usdc",
      before: null,
      after: "1.5",
    });
  });

  it("diffFields returns empty for unchanged inputs", () => {
    expect(diffFields({ envelope_json: '{"a":1}' }, { envelope_json: '{"a":1}' })).toEqual([]);
  });

  it("recordHistory bulk-inserts in a single transaction", () => {
    recordHistory(db, [
      {
        profileId: "live-lite",
        field: "envelope_json",
        beforeValue: '{"max":50}',
        afterValue: '{"max":60}',
        actor: "api_key",
        source: "api_put_settings",
        reason: "raise cap",
      },
      {
        profileId: "live-lite",
        field: "wallet_mode",
        beforeValue: "eoa",
        afterValue: "relayer",
        actor: "api_key",
        source: "api_put_settings",
        reason: null,
      },
    ]);

    const rows = db
      .prepare(
        "SELECT profile_id, field, before_value, after_value, actor, source, reason FROM profile_settings_history ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        profile_id: "live-lite",
        field: "envelope_json",
        before_value: '{"max":50}',
        after_value: '{"max":60}',
        actor: "api_key",
        source: "api_put_settings",
        reason: "raise cap",
      },
      {
        profile_id: "live-lite",
        field: "wallet_mode",
        before_value: "eoa",
        after_value: "relayer",
        actor: "api_key",
        source: "api_put_settings",
        reason: null,
      },
    ]);
  });

  it("recordHistory with empty array is a no-op", () => {
    recordHistory(db, []);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM profile_settings_history").get() as { c: number }).c,
    ).toBe(0);
  });

  it("diffFields redacts unparseable relayer_json values without leaking raw bytes", () => {
    const diffs = diffFields(
      { relayer_json: null },
      { relayer_json: '{"builder":{"key":"leaked-secret",garbage' },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.after).toBe("[REDACTED:unparseable]");
    expect(diffs[0]!.after).not.toContain("leaked-secret");
  });

  it("diffFields redacts non-object relayer_json values (scalars, arrays) as unparseable", () => {
    const scalar = diffFields({ relayer_json: null }, { relayer_json: '"sneaky-secret"' });
    expect(scalar[0]!.after).toBe("[REDACTED:unparseable]");
    expect(scalar[0]!.after).not.toContain("sneaky-secret");

    const array = diffFields({ relayer_json: null }, { relayer_json: '["array-secret"]' });
    expect(array[0]!.after).toBe("[REDACTED:unparseable]");
    expect(array[0]!.after).not.toContain("array-secret");
  });

  it("diffFields redacts relayer_json builder secrets and keeps non-secret config", () => {
    const before = {
      relayer_json: JSON.stringify({
        walletType: "proxy",
        builder: {
          mode: "local",
          key: "old-key",
          secret: "old-secret",
          passphrase: "old-pp",
          token: "old-token",
          url: "https://relayer.example",
        },
      }),
    };
    const after = {
      relayer_json: JSON.stringify({
        walletType: "proxy",
        builder: {
          mode: "local",
          key: "new-key",
          secret: "new-secret",
          passphrase: "new-pp",
          token: "new-token",
          url: "https://relayer.example",
        },
      }),
    };
    const diffs = diffFields(before, after);
    expect(diffs).toHaveLength(1);
    const [d] = diffs;
    const beforeJson = JSON.parse(d!.before!) as {
      walletType: string;
      builder: Record<string, string>;
    };
    const afterJson = JSON.parse(d!.after!) as {
      walletType: string;
      builder: Record<string, string>;
    };
    expect(beforeJson.builder.key).toBe("[REDACTED]");
    expect(beforeJson.builder.secret).toBe("[REDACTED]");
    expect(beforeJson.builder.passphrase).toBe("[REDACTED]");
    expect(beforeJson.builder.token).toBe("[REDACTED]");
    expect(beforeJson.builder.url).toBe("https://relayer.example");
    expect(beforeJson.builder.mode).toBe("local");
    expect(beforeJson.walletType).toBe("proxy");
    expect(afterJson.builder.key).toBe("[REDACTED]");
    expect(afterJson.builder.secret).toBe("[REDACTED]");
  });
});

describe("profile settings history endpoints", () => {
  let controlConn: DbConnection;
  let ledgerConn: DbConnection;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    controlConn = bootstrapControlDb(":memory:");
    ledgerConn = bootstrapLedgerDb(":memory:");
    app = await buildServer({
      config: testConfig(),
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      ledgerPool: stubLedgerPool(),
    });
  });

  afterEach(async () => {
    await app.close();
    controlConn.close();
    ledgerConn.close();
  });

  it("PUT /profiles/:id/settings appends one history row per changed field", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/live-lite/settings",
      headers: authHeaders(),
      payload: {
        envelopeJson: '{"maxActiveMarkets":60}',
        walletMode: "relayer",
        reason: "raise cap 50→60",
      },
    });
    expect(res.statusCode).toBe(200);

    const rows = controlConn.db
      .prepare(
        "SELECT field, before_value, after_value, actor, source, reason FROM profile_settings_history ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;
    const fields = rows.map((r) => r.field).sort();
    expect(fields).toEqual(["envelope_json", "wallet_mode"]);
    for (const row of rows) {
      expect(row.actor).toBe("api_key");
      expect(row.source).toBe("api_put_settings");
      expect(row.reason).toBe("raise cap 50→60");
    }
    const envelope = rows.find((r) => r.field === "envelope_json")!;
    expect(envelope.before_value).toBeNull();
    expect(envelope.after_value).toBe('{"maxActiveMarkets":60}');
  });

  it("PUT /profiles/:id/settings second identical write is a no-op for history", async () => {
    const payload = {
      envelopeJson: '{"maxActiveMarkets":60}',
      reason: "first write",
    };
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/live-lite/settings",
      headers: authHeaders(),
      payload,
    });
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/live-lite/settings",
      headers: authHeaders(),
      payload: { ...payload, reason: "second write same value" },
    });

    const rows = controlConn.db
      .prepare("SELECT field FROM profile_settings_history")
      .all() as Array<{ field: string }>;
    expect(rows.map((r) => r.field)).toEqual(["envelope_json"]);
  });

  it("PATCH /profiles/:id/execution-policy appends one history row when payload changes", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/profiles/live-lite/execution-policy",
      headers: authHeaders(),
      payload: {
        marketSelection: { maxMidPrice: 0.6 },
        reason: "raise mid cap",
      },
    });
    expect(res.statusCode).toBe(200);

    const rows = controlConn.db
      .prepare(
        "SELECT field, actor, source, reason FROM profile_settings_history WHERE profile_id = 'live-lite' AND field = 'execution_policy_json'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      field: "execution_policy_json",
      actor: "api_key",
      source: "api_patch_execution_policy",
      reason: "raise mid cap",
    });
  });

  it("GET /profiles/:id/history returns rows DESC and supports ?field= filter", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/live-lite/settings",
      headers: authHeaders(),
      payload: { envelopeJson: '{"v":1}', reason: "v1" },
    });
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/live-lite/settings",
      headers: authHeaders(),
      payload: { envelopeJson: '{"v":2}', walletMode: "eoa", reason: "v2" },
    });

    const all = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/live-lite/history",
      headers: authHeaders(),
    });
    const allBody = JSON.parse(all.body) as { data: { history: Array<{ field: string }> } };
    expect(allBody.data.history.length).toBeGreaterThanOrEqual(3);
    expect(allBody.data.history[0]!.field).toBeDefined();

    const filtered = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/live-lite/history?field=envelope_json",
      headers: authHeaders(),
    });
    const filteredBody = JSON.parse(filtered.body) as {
      data: { history: Array<{ field: string }> };
    };
    expect(filteredBody.data.history.every((r) => r.field === "envelope_json")).toBe(true);
    expect(filteredBody.data.history).toHaveLength(2);
  });

  it("history endpoint requires auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/live-lite/history",
    });
    expect(res.statusCode).toBe(401);
  });

  it("PUT /profiles/:id/settings on unknown profile returns 404 with no history rows", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/no-such-profile/settings",
      headers: authHeaders(),
      payload: { envelopeJson: '{"v":1}', reason: "should fail" },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("PROFILE_NOT_FOUND");
    const rows = controlConn.db
      .prepare(
        "SELECT COUNT(*) AS c FROM profile_settings_history WHERE profile_id = 'no-such-profile'",
      )
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it("PUT /profiles/:id/settings rejects non-finite initialBalanceUsdc with no history rows", async () => {
    // Send raw JSON so the `1e999` literal survives as `Infinity` after
    // parsing (an object payload would be re-stringified by Node, turning
    // Infinity into `null` and bypassing this code path).
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/live-lite/settings",
      headers: authHeaders(),
      payload: '{"initialBalanceUsdc":1e999,"reason":"Infinity attempt"}',
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_INITIAL_BALANCE");
    const rows = controlConn.db
      .prepare("SELECT COUNT(*) AS c FROM profile_settings_history WHERE profile_id = 'live-lite'")
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it("PUT /profiles/:id/settings rejects non-string reason without writing history", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/live-lite/settings",
      headers: authHeaders(),
      payload: { envelopeJson: '{"v":1}', reason: { evil: true } as unknown as string },
    });
    expect(res.statusCode).toBe(200);
    const row = controlConn.db
      .prepare(
        "SELECT reason FROM profile_settings_history WHERE profile_id = 'live-lite' AND field = 'envelope_json'",
      )
      .get() as { reason: string | null } | undefined;
    expect(row?.reason).toBeNull();
  });

  it("profile_settings_history rejects UPDATE/DELETE at the schema layer", () => {
    controlConn.db
      .prepare(
        `INSERT INTO profile_settings_history
           (profile_id, field, before_value, after_value, actor, source, reason)
         VALUES ('live-lite','envelope_json','{"a":1}','{"a":2}','test','manual','seed')`,
      )
      .run();
    expect(() =>
      controlConn.db
        .prepare(
          "UPDATE profile_settings_history SET reason = 'tamper' WHERE profile_id = 'live-lite'",
        )
        .run(),
    ).toThrow(/append-only/);
    expect(() =>
      controlConn.db
        .prepare("DELETE FROM profile_settings_history WHERE profile_id = 'live-lite'")
        .run(),
    ).toThrow(/append-only/);
  });

  it("profile_settings_history BEFORE INSERT trigger blocks REPLACE even with recursive_triggers=OFF", () => {
    const inserted = controlConn.db
      .prepare(
        `INSERT INTO profile_settings_history
           (profile_id, field, before_value, after_value, actor, source, reason)
         VALUES ('live-lite','envelope_json','{"a":1}','{"a":2}','test','manual','seed')`,
      )
      .run();
    const id = Number(inserted.lastInsertRowid);
    controlConn.db.pragma("recursive_triggers = OFF");
    try {
      expect(() =>
        controlConn.db
          .prepare(
            `INSERT OR REPLACE INTO profile_settings_history
               (id, profile_id, field, before_value, after_value, actor, source, reason)
             VALUES (?, 'live-lite','envelope_json','{"tampered":true}','{"tampered":true}','attacker','manual','tamper')`,
          )
          .run(id),
      ).toThrow(/append-only/);
      const row = controlConn.db
        .prepare("SELECT before_value FROM profile_settings_history WHERE id = ?")
        .get(id) as { before_value: string };
      expect(row.before_value).toBe('{"a":1}');
    } finally {
      controlConn.db.pragma("recursive_triggers = ON");
    }
  });

  it("profile_settings_history is immune to INSERT OR REPLACE bypass (recursive_triggers=ON)", () => {
    const inserted = controlConn.db
      .prepare(
        `INSERT INTO profile_settings_history
           (profile_id, field, before_value, after_value, actor, source, reason)
         VALUES ('live-lite','envelope_json','{"a":1}','{"a":2}','test','manual','seed')`,
      )
      .run();
    const id = Number(inserted.lastInsertRowid);
    expect(() =>
      controlConn.db
        .prepare(
          `INSERT OR REPLACE INTO profile_settings_history
             (id, profile_id, field, before_value, after_value, actor, source, reason)
           VALUES (?, 'live-lite','envelope_json','{"tampered":true}','{"tampered":true}','attacker','manual','tamper')`,
        )
        .run(id),
    ).toThrow(/append-only/);
    const row = controlConn.db
      .prepare("SELECT before_value FROM profile_settings_history WHERE id = ?")
      .get(id) as { before_value: string };
    expect(row.before_value).toBe('{"a":1}');
  });
});
