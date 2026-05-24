import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DbSizeGuardModule,
  DEFAULT_DB_SIZE_GUARD_CONFIG,
  type DbSizeGuardModuleDeps,
} from "../db-size-guard-module.js";

const GIB = 1024 * 1024 * 1024;

const log = {
  child: () => log,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

let db: Database.Database;

function build(overrides: Partial<DbSizeGuardModuleDeps> = {}) {
  const pause = overrides.pause ?? vi.fn();
  const recordTrigger = overrides.recordTrigger ?? vi.fn();
  const guard = new DbSizeGuardModule({
    dbPath: "/tmp/ledger-test.db",
    log,
    measureSizeBytes: () => 0,
    ...overrides,
    pause,
    recordTrigger,
  });
  return { guard, pause, recordTrigger };
}

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(":memory:");
});

afterEach(() => {
  db.close();
});

describe("DbSizeGuardModule", () => {
  it("pauses and records a trigger when size exceeds the threshold", () => {
    const { guard, pause, recordTrigger } = build({
      config: { thresholdBytes: 30 * GIB },
      measureSizeBytes: () => 31 * GIB,
    });

    const result = guard.runOnce();

    expect(result.overThreshold).toBe(true);
    expect(result.triggered).toBe(true);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledWith(expect.stringContaining("db-size-guard"));
    expect(recordTrigger).toHaveBeenCalledWith(31 * GIB);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("does not pause when size is below the threshold", () => {
    const { guard, pause, recordTrigger } = build({
      config: { thresholdBytes: 30 * GIB },
      measureSizeBytes: () => 12 * GIB,
    });

    const result = guard.runOnce();

    expect(result.overThreshold).toBe(false);
    expect(result.triggered).toBe(false);
    expect(pause).not.toHaveBeenCalled();
    expect(recordTrigger).not.toHaveBeenCalled();
  });

  it("never pauses when disabled, even far over the threshold", () => {
    const { guard, pause } = build({
      config: { enabled: false, thresholdBytes: 1 },
      measureSizeBytes: () => 999 * GIB,
    });

    const result = guard.runOnce();

    expect(result.triggered).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });

  it("does not re-pause or re-log while already paused (no spam)", () => {
    let paused = false;
    const { guard, pause } = build({
      config: { thresholdBytes: 30 * GIB },
      measureSizeBytes: () => 31 * GIB,
      runtimeControl: { isPaused: () => paused },
      pause: vi.fn(() => {
        paused = true;
      }),
    });

    guard.runOnce(); // first breach → pause
    guard.runOnce(); // still over, now paused → quiet
    guard.runOnce();

    expect(pause).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("re-pauses on a fresh breach after an operator resume", () => {
    let paused = false;
    const pauseFn = vi.fn(() => {
      paused = true;
    });
    const { guard } = build({
      config: { thresholdBytes: 30 * GIB },
      measureSizeBytes: () => 31 * GIB,
      runtimeControl: { isPaused: () => paused },
      pause: pauseFn,
    });

    guard.runOnce(); // breach → pause
    expect(pauseFn).toHaveBeenCalledTimes(1);

    paused = false; // operator resumes without fixing the size
    guard.runOnce(); // still over → re-pause

    expect(pauseFn).toHaveBeenCalledTimes(2);
  });

  it("includes the top tables by row count in the trigger log (best-effort)", () => {
    db.exec(`
      CREATE TABLE small_table (id INTEGER PRIMARY KEY, v TEXT);
      CREATE TABLE big_table (id INTEGER PRIMARY KEY, v TEXT);
    `);
    const insertBig = db.prepare("INSERT INTO big_table (v) VALUES (?)");
    for (let i = 0; i < 50; i++) insertBig.run("x");
    db.prepare("INSERT INTO small_table (v) VALUES (?)").run("y");

    const { guard } = build({
      config: { thresholdBytes: 1 },
      measureSizeBytes: () => 2,
      db,
    });

    guard.runOnce();

    const [, msg] = log.error.mock.calls.at(-1)!;
    expect(msg).toContain("DB size guard triggered");
    const topTables = (log.error.mock.calls.at(-1)![0] as { topTables: Array<{ table: string }> })
      .topTables;
    expect(topTables[0]!.table).toBe("big_table");
  });

  it("defaults to the 30 GB / 60 s configuration", () => {
    expect(DEFAULT_DB_SIZE_GUARD_CONFIG.thresholdBytes).toBe(30 * GIB);
    expect(DEFAULT_DB_SIZE_GUARD_CONFIG.checkIntervalMs).toBe(60_000);
    expect(DEFAULT_DB_SIZE_GUARD_CONFIG.enabled).toBe(true);
  });

  // Integration: the guard's pause flows through the same isPaused() contract
  // that every emitting runtime module honors (AlgoDecisionModule /
  // ExecutionModule early-return when paused). A representative consumer that
  // gates on isPaused() must stop emitting once the guard fires.
  it("stops downstream emissions once the guard pauses the runtime", () => {
    let paused = false;
    const runtimeControl = { isPaused: () => paused };
    const { guard } = build({
      config: { thresholdBytes: 30 * GIB },
      measureSizeBytes: () => 40 * GIB,
      runtimeControl,
      pause: vi.fn(() => {
        paused = true;
      }),
    });

    let emissions = 0;
    const emitIfRunning = () => {
      if (!runtimeControl.isPaused()) emissions += 1;
    };

    emitIfRunning(); // running → 1
    emitIfRunning(); // running → 2
    guard.runOnce(); // over threshold → pause
    emitIfRunning(); // paused → no-op
    emitIfRunning(); // paused → no-op

    expect(paused).toBe(true);
    expect(emissions).toBe(2);
  });
});
