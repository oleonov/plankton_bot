import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, type DbConnection } from "@plankton/db";
import { resolveActiveProfile } from "../profile-boot.js";

const CONTROL_SQL = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/db/src/schemas/control.sql"),
  "utf-8",
);

function createControlDb(): DbConnection {
  const conn = openDatabase(":memory:");
  conn.db.exec(CONTROL_SQL);
  return conn;
}

describe("resolveActiveProfile", () => {
  let conn: DbConnection;

  beforeEach(() => {
    conn = createControlDb();
  });

  it("reads desired_profile from runtime_control_state", () => {
    conn.db
      .prepare("INSERT INTO profiles (profile_id, display_name) VALUES ('paper', 'Paper')")
      .run();
    conn.db
      .prepare(
        "INSERT INTO runtime_control_state (id, desired_profile, runtime_status) VALUES (1, 'paper', 'stopped')",
      )
      .run();

    const result = resolveActiveProfile(conn.db);
    expect(result.profile).toBe("paper");
    expect(result.runtimeMode).toBe("paper");
  });

  it("maps live-lite profile correctly", () => {
    conn.db
      .prepare("INSERT INTO profiles (profile_id, display_name) VALUES ('live-lite', 'Live Lite')")
      .run();
    conn.db
      .prepare(
        "INSERT INTO runtime_control_state (id, desired_profile, runtime_status) VALUES (1, 'live-lite', 'stopped')",
      )
      .run();

    const result = resolveActiveProfile(conn.db);
    expect(result.profile).toBe("live-lite");
    expect(result.runtimeMode).toBe("live-lite");
  });

  it("falls back to envMode when no control state row exists", () => {
    const result = resolveActiveProfile(conn.db, "paper");
    expect(result.profile).toBe("paper");
    expect(result.runtimeMode).toBe("paper");
  });

  it("falls back to envMode when desired_profile is null", () => {
    conn.db
      .prepare(
        "INSERT INTO runtime_control_state (id, desired_profile, runtime_status) VALUES (1, NULL, 'stopped')",
      )
      .run();

    const result = resolveActiveProfile(conn.db, "paper");
    expect(result.profile).toBe("paper");
    expect(result.runtimeMode).toBe("paper");
  });

  it("defaults to simulation when nothing configured", () => {
    const result = resolveActiveProfile(conn.db);
    expect(result.profile).toBe("simulation");
    expect(result.runtimeMode).toBe("simulation");
  });
});
