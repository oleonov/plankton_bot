import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, type DbConnection } from "@krabs/db";
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

function seedDesiredProfile(conn: DbConnection, profile: string | null): void {
  if (profile != null) {
    conn.db
      .prepare("INSERT OR IGNORE INTO profiles (profile_id, display_name) VALUES (?, ?)")
      .run(profile, profile);
  }
  conn.db
    .prepare(
      "INSERT INTO runtime_control_state (id, desired_profile, runtime_status) VALUES (1, ?, 'stopped')",
    )
    .run(profile);
}

describe("resolveActiveProfile", () => {
  let conn: DbConnection;

  beforeEach(() => {
    conn = createControlDb();
  });

  it("resolves live-lite from desired_profile", () => {
    seedDesiredProfile(conn, "live-lite");

    const result = resolveActiveProfile(conn.db);

    expect(result.profile).toBe("live-lite");
    expect(result.runtimeMode).toBe("live-lite");
    expect(result.desiredProfile).toBe("live-lite");
  });

  it("falls back to live-lite envMode when desired_profile is null", () => {
    seedDesiredProfile(conn, null);

    const result = resolveActiveProfile(conn.db, "live-lite");

    expect(result.profile).toBe("live-lite");
    expect(result.runtimeMode).toBe("live-lite");
    expect(result.envMode).toBe("live-lite");
  });

  it("throws when profile and envMode are missing instead of defaulting to simulation", () => {
    expect(() => resolveActiveProfile(conn.db)).toThrow(/UNSUPPORTED_RUNTIME_PROFILE/);
  });

  it.each(["paper", "simulation", "bogus"])(
    "throws for unsupported desired_profile %s",
    (profile) => {
      seedDesiredProfile(conn, profile);

      expect(() => resolveActiveProfile(conn.db)).toThrow(/UNSUPPORTED_RUNTIME_PROFILE/);
    },
  );

  it.each(["paper", "simulation", "bogus"])("throws for unsupported envMode %s", (profile) => {
    seedDesiredProfile(conn, null);

    expect(() => resolveActiveProfile(conn.db, profile)).toThrow(/UNSUPPORTED_RUNTIME_PROFILE/);
  });
});
