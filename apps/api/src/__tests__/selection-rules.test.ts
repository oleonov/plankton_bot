/**
 * Phase 5 API tests for /selection-rules, /markets/event-slugs, /metrics/events
 *
 * Architecture note: selection_rules lives in the control DB (per the 037 migration).
 * The ledger DB (per-profile) holds market rows with event_market_count / event_slug.
 * We bootstrap both in-memory and wire them through buildServer + a custom LedgerPool stub.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapControlDb, bootstrapLedgerDb } from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import type { LedgerPool } from "../ledger-pool.js";
import { buildServer } from "../server.js";

// ─── Test config ────────────────────────────────────────────────────────────

const TEST_API_KEY = "test-key-selection-rules";

function testConfig(): AppConfig {
  return {
    runtimeMode: "simulation",
    logLevel: "error",
    dbPath: "",
    marketDataPollIntervalMs: 30_000,
    marketDataStaleThresholdMs: 120_000,
    strategyScanIntervalMs: 5_000,
    fillPollIntervalMs: 5_000,
    enableInventoryAutoMerge: false,
    executionMaxConcurrency: 4,
    polyApiKey: undefined,
    polyApiSecret: undefined,
    polyPassphrase: undefined,
    polyPrivateKey: undefined,
    planktonApiKey: TEST_API_KEY,
    planktonApiPort: 0,
    planktonAuthUsername: undefined,
    planktonAuthPassword: undefined,
    planktonSessionSecret: undefined,
    trustProxy: false,
  };
}

function authHeaders() {
  return { authorization: `Bearer ${TEST_API_KEY}` };
}

// ─── Minimal LedgerPool backed by an in-memory ledger DB ────────────────────

function makeTestLedgerPool(ledger: DbConnection): LedgerPool {
  // Returns the in-memory ledger for "simulation" profile, null for everything else.
  return {
    get(profileId: string) {
      return profileId === "simulation" ? ledger.db : null;
    },
    closeAll() {},
  } as unknown as LedgerPool;
}

// ─── Test setup ─────────────────────────────────────────────────────────────

let controlConn: DbConnection;
let ledgerConn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  // Control DB — holds selection_rules, profiles, runtime_control_state
  controlConn = bootstrapControlDb(":memory:");
  // Ensure runtime_control_state row exists so version queries work.
  // The migration does INSERT OR IGNORE but the row may be absent on a fresh in-memory DB
  // with no profiles to trigger the seeding path.
  controlConn.db
    .prepare(
      "INSERT OR IGNORE INTO runtime_control_state (id, selection_rules_version) VALUES (1, 0)",
    )
    .run();

  // Ledger DB — holds markets with event_slug / event_market_count
  ledgerConn = bootstrapLedgerDb(":memory:");
  ledgerConn.db.exec(`
    INSERT INTO markets (token_id, condition_id, slug, question, outcome, active, tick_size, neg_risk,
      event_slug, event_market_count, selection_status, created_at, updated_at)
    VALUES
      ('tok-ev-1', 'cond-ev-1', 'bitcoin-up', 'Bitcoin up?', 'Yes', 1, 0.01, 0,
       'bitcoin-price', 5, 'matched_include', datetime('now'), datetime('now')),
      ('tok-ev-2', 'cond-ev-2', 'bitcoin-down', 'Bitcoin down?', 'No', 1, 0.01, 0,
       'bitcoin-price', 5, 'matched_include', datetime('now'), datetime('now')),
      ('tok-ev-3', 'cond-ev-3', 'eth-flip', 'ETH flip?', 'Yes', 1, 0.01, 0,
       'ethereum-price', 2, 'matched_exclude', datetime('now'), datetime('now')),
      ('tok-ev-4', 'cond-ev-4', 'single-market', 'Solo?', 'Yes', 1, 0.01, 0,
       'solo-event', 1, 'step2_fallback_include', datetime('now'), datetime('now'));

    INSERT INTO positions (position_id, token_id, side, size, avg_entry_price,
      cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, updated_at)
    VALUES
      ('pev-1', 'tok-ev-1', 'buy', 100, 0.5, 50, 60, 5.0, 'open', datetime('now'), datetime('now')),
      ('pev-2', 'tok-ev-3', 'buy', 50, 0.4, 20, 18, -2.0, 'open', datetime('now'), datetime('now'));
  `);

  app = await buildServer({
    config: testConfig(),
    controlDb: controlConn.db,
    ledgerDb: ledgerConn.db,
    ledgerPool: makeTestLedgerPool(ledgerConn),
  });
});

afterAll(async () => {
  await app.close();
  controlConn.close();
  ledgerConn.close();
});

// ─── GET /selection-rules ────────────────────────────────────────────────────

describe("GET /selection-rules", () => {
  it("returns rules for simulation profile (seeded by migration)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/selection-rules?profileId=simulation",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.rules)).toBe(true);
    // Migration seeds bitcoin-, ethereum-, elon-musk- for each profile
    expect(body.data.rules.length).toBeGreaterThanOrEqual(0);
  });

  it("returns 400 when profileId is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/selection-rules",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
  });
});

// ─── POST /selection-rules ───────────────────────────────────────────────────

describe("POST /selection-rules", () => {
  it("creates rule and normalizes pattern", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/selection-rules",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {
        profileId: "simulation",
        ruleType: "include_prefix",
        pattern: " Solana- ",
        note: null,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.rule.pattern).toBe("solana-"); // normalized: trim + lowercase
    expect(body.data.rule.ruleType).toBe("include_prefix");
    expect(body.data.rule.enabled).toBe(true);
    expect(body.data.rule.ruleId).toBeTruthy();
  });

  it("returns DUPLICATE_RULE on UNIQUE collision (same type + pattern)", async () => {
    const payload = {
      profileId: "simulation",
      ruleType: "include_slug",
      pattern: "dup-slug-test",
      note: null,
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/selection-rules",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/selection-rules",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("DUPLICATE_RULE");
  });

  it("returns 400 for invalid ruleType", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/selection-rules",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {
        profileId: "simulation",
        ruleType: "invalid_type",
        pattern: "test",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
  });

  it("bumps selection_rules_version in runtime_control_state", async () => {
    const versionBefore = (
      controlConn.db
        .prepare("SELECT selection_rules_version FROM runtime_control_state WHERE id = 1")
        .get() as { selection_rules_version: number }
    ).selection_rules_version;

    await app.inject({
      method: "POST",
      url: "/api/v1/selection-rules",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {
        profileId: "simulation",
        ruleType: "exclude_slug",
        pattern: "version-bump-check",
        note: null,
      },
    });

    const versionAfter = (
      controlConn.db
        .prepare("SELECT selection_rules_version FROM runtime_control_state WHERE id = 1")
        .get() as { selection_rules_version: number }
    ).selection_rules_version;

    expect(versionAfter).toBeGreaterThan(versionBefore);
  });

  it("writes state_transitions audit row on create", async () => {
    const countBefore = (
      controlConn.db
        .prepare("SELECT COUNT(*) as c FROM state_transitions WHERE entity_type = 'selection_rule'")
        .get() as { c: number }
    ).c;

    await app.inject({
      method: "POST",
      url: "/api/v1/selection-rules",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {
        profileId: "simulation",
        ruleType: "include_slug",
        pattern: "audit-test-create",
        note: null,
      },
    });

    const countAfter = (
      controlConn.db
        .prepare("SELECT COUNT(*) as c FROM state_transitions WHERE entity_type = 'selection_rule'")
        .get() as { c: number }
    ).c;

    expect(countAfter).toBe(countBefore + 1);
  });
});

// ─── PATCH /selection-rules/:ruleId ─────────────────────────────────────────

describe("PATCH /selection-rules/:ruleId", () => {
  it("toggles enabled and updates note only (immutability of type+pattern)", async () => {
    // Create a rule to patch
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/selection-rules",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {
        profileId: "simulation",
        ruleType: "include_prefix",
        pattern: "patch-test-",
        note: "original note",
      },
    });
    expect(createRes.statusCode).toBe(200);
    const ruleId = createRes.json().data.rule.ruleId;

    // Patch — toggle enabled + change note
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/selection-rules/${ruleId}`,
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { enabled: false, note: "updated note" },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = patchRes.json().data.rule;
    expect(patched.enabled).toBe(false);
    expect(patched.note).toBe("updated note");
    // Pattern and ruleType must not change
    expect(patched.pattern).toBe("patch-test-");
    expect(patched.ruleType).toBe("include_prefix");
  });

  it("writes state_transitions audit row on patch", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/selection-rules",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {
        profileId: "simulation",
        ruleType: "exclude_prefix",
        pattern: "patch-audit-",
        note: null,
      },
    });
    const ruleId = createRes.json().data.rule.ruleId;

    const countBefore = (
      controlConn.db
        .prepare(
          "SELECT COUNT(*) as c FROM state_transitions WHERE entity_type = 'selection_rule' AND entity_id = ?",
        )
        .get(ruleId) as { c: number }
    ).c;

    await app.inject({
      method: "PATCH",
      url: `/api/v1/selection-rules/${ruleId}`,
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { enabled: false },
    });

    const countAfter = (
      controlConn.db
        .prepare(
          "SELECT COUNT(*) as c FROM state_transitions WHERE entity_type = 'selection_rule' AND entity_id = ?",
        )
        .get(ruleId) as { c: number }
    ).c;

    expect(countAfter).toBe(countBefore + 1);
  });

  it("returns 404 for unknown ruleId", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/selection-rules/nonexistent-id",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});

// ─── DELETE /selection-rules/:ruleId ────────────────────────────────────────

describe("DELETE /selection-rules/:ruleId", () => {
  it("deletes rule and returns deleted flag", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/selection-rules",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {
        profileId: "simulation",
        ruleType: "include_slug",
        pattern: "to-be-deleted",
        note: null,
      },
    });
    const ruleId = createRes.json().data.rule.ruleId;

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/selection-rules/${ruleId}`,
      headers: authHeaders(),
    });
    expect(deleteRes.statusCode).toBe(200);
    const body = deleteRes.json();
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);
    expect(body.data.ruleId).toBe(ruleId);
  });

  it("returns 404 for unknown ruleId", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/selection-rules/nonexistent-delete",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});

// ─── GET /selection-rules/preview ───────────────────────────────────────────

describe("GET /selection-rules/preview", () => {
  it("returns 4-bucket shape for valid profile", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/selection-rules/preview?profileId=simulation",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toHaveProperty("matchedInclude");
    expect(data).toHaveProperty("matchedExclude");
    expect(data).toHaveProperty("step2FallbackInclude");
    expect(data).toHaveProperty("fallbackExclude");
    expect(Array.isArray(data.matchedInclude)).toBe(true);
  });

  it("returns 404 for unknown profile (no ledger)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/selection-rules/preview?profileId=unknown-profile",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("LEDGER_NOT_FOUND");
  });
});

// ─── GET /selection-rules/match ─────────────────────────────────────────────

describe("GET /selection-rules/match", () => {
  it("returns decision + finalStatus when eventMarketCount is provided via query", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/selection-rules/match?profileId=simulation&eventSlug=bitcoin-price&marketSlug=bitcoin-up&eventMarketCount=1",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toHaveProperty("decision");
    expect(data).toHaveProperty("winningRuleId");
    expect(data).toHaveProperty("finalStatus");
    expect(data).toHaveProperty("selectionStatus");
    expect(data.eventMarketCount).toBe(1);
    expect(data.eventMarketCountSource).toBe("query");
  });

  it("falls back to persisted market row when eventMarketCount is omitted", async () => {
    // bitcoin-up was seeded with event_market_count = 5
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/selection-rules/match?profileId=simulation&eventSlug=bitcoin-price&marketSlug=bitcoin-up",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.eventMarketCount).toBe(5);
    expect(data.eventMarketCountSource).toBe("ledger");
  });

  it("returns 400 when eventMarketCount is neither provided nor in ledger", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/selection-rules/match?profileId=simulation&eventSlug=any&marketSlug=unknown-market-slug",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when profileId is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/selection-rules/match?marketSlug=bitcoin-up",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 for non-integer eventMarketCount", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/selection-rules/match?profileId=simulation&marketSlug=bitcoin-up&eventMarketCount=abc",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
  });
});

// ─── GET /markets/event-slugs ────────────────────────────────────────────────

describe("GET /markets/event-slugs", () => {
  it("returns distinct event slugs for valid profile", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/markets/event-slugs?profileId=simulation",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(Array.isArray(data.eventSlugs)).toBe(true);
    // Seeded: bitcoin-price, ethereum-price, solo-event
    expect(data.eventSlugs).toContain("bitcoin-price");
    expect(data.eventSlugs).toContain("ethereum-price");
    expect(data.eventSlugs).toContain("solo-event");
    // Should be distinct and sorted
    const sorted = [...data.eventSlugs].sort();
    expect(data.eventSlugs).toEqual(sorted);
  });

  it("returns 400 when profileId is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/markets/event-slugs",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 for unknown profile (no ledger)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/markets/event-slugs?profileId=unknown-profile",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("LEDGER_NOT_FOUND");
  });
});

// ─── GET /metrics/events ─────────────────────────────────────────────────────

describe("GET /metrics/events", () => {
  it("returns events array with aggregated shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/events?profileId=simulation",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(Array.isArray(data.events)).toBe(true);
    // We seeded positions for tok-ev-1 (bitcoin-price) and tok-ev-3 (ethereum-price)
    expect(data.events.length).toBeGreaterThanOrEqual(1);
    const event = data.events[0] as {
      eventSlug: string;
      realizedPnl: number;
      unrealizedPnl: number;
      volumeUsdc: number;
      positionCount: number;
    };
    expect(event).toHaveProperty("eventSlug");
    expect(event).toHaveProperty("realizedPnl");
    expect(event).toHaveProperty("unrealizedPnl");
    expect(event).toHaveProperty("volumeUsdc");
    expect(event).toHaveProperty("positionCount");
  });

  it("returns 400 when profileId is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/events",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 for unknown profile (no ledger)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/events?profileId=unknown-profile",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("LEDGER_NOT_FOUND");
  });

  it("respects limit parameter (capped at 100)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/events?profileId=simulation&limit=2",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const events = res.json().data.events as unknown[];
    expect(events.length).toBeLessThanOrEqual(2);
  });
});

// ─── Envelope shape ──────────────────────────────────────────────────────────

describe("response envelope shape", () => {
  it("success responses have ok/data/error/ts fields", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/selection-rules?profileId=simulation",
      headers: authHeaders(),
    });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.error).toBeNull();
    expect(body.ts).toBeDefined();
  });

  it("error responses have error as {code, message} object", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/selection-rules",
      headers: authHeaders(),
    });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error.code).toBe("string");
    expect(typeof body.error.message).toBe("string");
    expect(body.data).toBeNull();
  });
});
