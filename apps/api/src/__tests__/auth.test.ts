import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase } from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";
import { stubLedgerPool } from "./test-helpers.js";

interface ApiResponse {
  ok: boolean;
  data: Record<string, unknown>;
  error: { code: string; message: string };
}

function json(res: { json: () => unknown }): ApiResponse {
  return res.json() as ApiResponse;
}

const TEST_USERNAME = "admin";
const TEST_PASSWORD = "test-secret-password";
const TEST_API_KEY = "test-key-abc123";
const TEST_SESSION_SECRET = "a".repeat(64);

function testConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    runtimeMode: "simulation",
    logLevel: "error",
    dbPath: "",
    marketDataPollIntervalMs: 30_000,
    marketDataStaleThresholdMs: 120_000,
    strategyScanIntervalMs: 5_000,
    fillPollIntervalMs: 5_000,
    executionMaxConcurrency: 4,
    polyApiKey: undefined,
    polyApiSecret: undefined,
    polyPassphrase: undefined,
    polyPrivateKey: undefined,
    planktonApiKey: TEST_API_KEY,
    planktonApiPort: 0,
    planktonAuthUsername: TEST_USERNAME,
    planktonAuthPassword: TEST_PASSWORD,
    planktonSessionSecret: TEST_SESSION_SECRET,
    trustProxy: false,
    ...overrides,
  };
}

let conn: DbConnection;

beforeAll(() => {
  conn = bootstrapDatabase(":memory:");
});

afterAll(() => {
  conn.close();
});

describe("Session Auth", () => {
  it("login sets session cookie on correct password", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).ok).toBe(true);
    expect(res.headers["set-cookie"]).toBeDefined();
    const cookie = res.headers["set-cookie"];
    expect(typeof cookie === "string" ? cookie : "").toContain("plankton_session");
    await app.close();
  });

  it("login returns 401 on wrong password", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: TEST_USERNAME, password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
    expect(json(res).error.code).toBe("INVALID_CREDENTIALS");
    await app.close();
  });

  it("login returns 401 on wrong username", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "hacker", password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(json(res).error.code).toBe("INVALID_CREDENTIALS");
    await app.close();
  });

  it("login returns 401 when username required but missing", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(json(res).error.code).toBe("INVALID_CREDENTIALS");
    await app.close();
  });

  it("login succeeds without username when not configured", async () => {
    const app = await buildServer({
      config: testConfig({ planktonAuthUsername: undefined }),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).ok).toBe(true);
    await app.close();
  });

  it("GET /auth/config returns usernameRequired=true when configured", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/config" });
    expect(res.statusCode).toBe(200);
    expect(json(res).data.usernameRequired).toBe(true);
    await app.close();
  });

  it("GET /auth/config returns usernameRequired=false when not configured", async () => {
    const app = await buildServer({
      config: testConfig({ planktonAuthUsername: undefined }),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/config" });
    expect(res.statusCode).toBe(200);
    expect(json(res).data.usernameRequired).toBe(false);
    await app.close();
  });

  it("GET /auth/config is accessible without authentication", async () => {
    const app = await buildServer({
      config: testConfig({ planktonApiKey: undefined }),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/config" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("login returns 501 when password not configured", async () => {
    const app = await buildServer({
      config: testConfig({ planktonAuthPassword: undefined, planktonSessionSecret: undefined }),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password: "any" },
    });
    expect(res.statusCode).toBe(501);
    expect(json(res).error.code).toBe("LOGIN_NOT_CONFIGURED");
    await app.close();
  });

  it("session cookie grants access to protected routes", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    const cookie = loginRes.headers["set-cookie"] as string;

    const statusRes = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: { cookie },
    });
    expect(statusRes.statusCode).toBe(200);
    await app.close();
  });

  it("Bearer token still grants access", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("no auth returns 401", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET /auth/me returns 200 with valid session", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    const cookie = loginRes.headers["set-cookie"] as string;

    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    });
    expect(meRes.statusCode).toBe(200);
    expect(json(meRes).data?.authenticated).toBe(true);
    await app.close();
  });

  it("GET /auth/me returns 401 without session", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("POST /auth/logout clears session and is idempotent", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });

    // Logout without session should work (idempotent)
    const logoutRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
    });
    expect(logoutRes.statusCode).toBe(200);

    // Login, then logout
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    const cookie = loginRes.headers["set-cookie"] as string;

    const logoutRes2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie },
    });
    expect(logoutRes2.statusCode).toBe(200);

    // After logout, /auth/me should fail
    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: logoutRes2.headers["set-cookie"] as string },
    });
    expect(meRes.statusCode).toBe(401);
    await app.close();
  });

  it("health endpoint works without auth", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("HEAD on health endpoint works without auth (Docker healthcheck)", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({
      method: "HEAD",
      url: "/api/v1/health",
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rate-limits login to 5 attempts per minute", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });

    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { password: "wrong" },
      });
    }

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password: "wrong" },
    });
    expect(res.statusCode).toBe(429);
    await app.close();
  });

  it("session login stores username for audit attribution", async () => {
    const app = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });

    // Login as "admin"
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    const cookie = loginRes.headers["set-cookie"] as string;

    // Perform an action via session auth
    const pauseRes = await app.inject({
      method: "POST",
      url: "/api/v1/actions/pause",
      headers: { cookie, "content-type": "application/json" },
      payload: { reason: "attribution test" },
    });
    expect(pauseRes.statusCode).toBe(200);
    const body = json(pauseRes);

    // Verify the command was attributed to the session username
    const row = conn.db
      .prepare("SELECT initiator FROM operator_commands WHERE id = ?")
      .get(body.data.commandId) as { initiator: string };
    expect(row.initiator).toBe("admin");

    await app.close();
  });

  it("fail-closed when no auth configured at all", async () => {
    const app = await buildServer({
      config: testConfig({
        planktonApiKey: undefined,
        planktonAuthPassword: undefined,
        planktonSessionSecret: undefined,
      }),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
    });
    expect(res.statusCode).toBe(401);
    expect(json(res).error.code).toBe("AUTH_NOT_CONFIGURED");
    await app.close();
  });
});
