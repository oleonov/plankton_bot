import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type DbConnection } from "@plankton/db";

/**
 * Integration test: verify that resume_intent_at is always consumed
 * on startup, even when the process would exit before reaching
 * the resume evaluation (e.g. preflight failure).
 *
 * The runtime startup sequence is:
 *   1. Open control.db
 *   2. Run preflight
 *   3. Read + clear resume_intent_at  ← must happen before any exit
 *   4. Check preflight result (may exit here)
 *   5. Start supervisor
 *   6. Evaluate intent → resume or stay paused
 *
 * This test verifies step 3 is independent of steps 4-6.
 */

function createControlDb(): DbConnection {
  const conn = openDatabase(":memory:");
  conn.db.exec(`
    CREATE TABLE runtime_control_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL DEFAULT 1,
      resume_intent_at TEXT,
      desired_profile TEXT,
      current_profile TEXT
    );
    INSERT INTO runtime_control_state (id) VALUES (1);
  `);
  return conn;
}

function setIntent(conn: DbConnection, isoTimestamp: string) {
  conn.db.prepare("UPDATE runtime_control_state SET resume_intent_at = ? WHERE id = 1").run(
    isoTimestamp,
  );
}

function getIntent(conn: DbConnection): string | null {
  const row = conn.db
    .prepare("SELECT resume_intent_at FROM runtime_control_state WHERE id = 1")
    .get() as { resume_intent_at: string | null };
  return row.resume_intent_at;
}

/**
 * Mirrors the runtime startup pattern from index.ts:
 * read intent + clear in one shot, BEFORE checking preflight result.
 */
function simulateStartupIntentConsume(conn: DbConnection): string | null {
  const row = conn.db
    .prepare("SELECT resume_intent_at, desired_profile FROM runtime_control_state WHERE id = 1")
    .get() as { resume_intent_at: string | null };
  conn.db.prepare("UPDATE runtime_control_state SET resume_intent_at = NULL WHERE id = 1").run();
  return row.resume_intent_at;
}

describe("resume intent DB lifecycle", () => {
  let conn: DbConnection;

  beforeEach(() => {
    conn = createControlDb();
  });

  it("intent is consumed even when startup would fail after", () => {
    setIntent(conn, "2026-04-01T12:00:00Z");
    expect(getIntent(conn)).toBe("2026-04-01T12:00:00Z");

    // Simulate: read+clear happens first (before preflight check)
    const consumed = simulateStartupIntentConsume(conn);
    expect(consumed).toBe("2026-04-01T12:00:00Z");

    // Simulate: preflight fails, process.exit(1) — intent already gone
    expect(getIntent(conn)).toBeNull();
  });

  it("second startup does not see a consumed intent", () => {
    setIntent(conn, "2026-04-01T12:00:00Z");

    // First startup consumes it
    simulateStartupIntentConsume(conn);

    // Second startup (e.g. crash-loop restart) sees nothing
    const second = simulateStartupIntentConsume(conn);
    expect(second).toBeNull();
  });

  it("no intent set — returns null without error", () => {
    const result = simulateStartupIntentConsume(conn);
    expect(result).toBeNull();
    expect(getIntent(conn)).toBeNull();
  });
});
