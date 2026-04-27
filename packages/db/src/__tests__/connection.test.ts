import { describe, it, expect } from "vitest";
import {
  BOOTSTRAP_BUSY_TIMEOUT_MS,
  RUNTIME_BUSY_TIMEOUT_MS,
  openDatabase,
  setRuntimeBusyTimeout,
} from "../connection.js";

function readBusyTimeout(db: import("better-sqlite3").Database): number {
  const row = db.pragma("busy_timeout") as Array<{ timeout: number }>;
  return row[0]!.timeout;
}

describe("openDatabase busy_timeout scoping", () => {
  it("defaults to runtime budget — does not stall the event loop for 10 minutes", () => {
    const conn = openDatabase(":memory:");
    expect(readBusyTimeout(conn.db)).toBe(RUNTIME_BUSY_TIMEOUT_MS);
    expect(RUNTIME_BUSY_TIMEOUT_MS).toBe(30_000);
    conn.close();
  });

  it("honors explicit bootstrap budget for the DDL window", () => {
    const conn = openDatabase(":memory:", { busyTimeoutMs: BOOTSTRAP_BUSY_TIMEOUT_MS });
    expect(readBusyTimeout(conn.db)).toBe(BOOTSTRAP_BUSY_TIMEOUT_MS);
    conn.close();
  });

  it("setRuntimeBusyTimeout drops a bootstrap connection back to the runtime budget", () => {
    const conn = openDatabase(":memory:", { busyTimeoutMs: BOOTSTRAP_BUSY_TIMEOUT_MS });
    expect(readBusyTimeout(conn.db)).toBe(BOOTSTRAP_BUSY_TIMEOUT_MS);
    setRuntimeBusyTimeout(conn);
    expect(readBusyTimeout(conn.db)).toBe(RUNTIME_BUSY_TIMEOUT_MS);
    conn.close();
  });
});
