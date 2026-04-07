import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const findBetterSqlite3 = () => {
  const paths = [
    "better-sqlite3",
    "../node_modules/better-sqlite3",
    "../../node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3",
    "./node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3",
  ];
  for (const p of paths) {
    try {
      return require(p);
    } catch (e) {}
  }
  throw new Error("Could not find better-sqlite3");
};

const Database = findBetterSqlite3();
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_DB = "/tmp/test-ledger.db";
const CONTROL_DB = "/tmp/test-control.db";
const SCRIPT_PATH = path.resolve(__dirname, "../fee-backfill.mjs");

function runBackfill(args: string[] = []) {
  const allArgs = [LEDGER_DB, CONTROL_DB, ...args];
  return execSync(`node ${SCRIPT_PATH} ${allArgs.join(" ")}`, { encoding: "utf8" });
}

describe("fee-backfill script", () => {
  beforeEach(() => {
    if (fs.existsSync(LEDGER_DB)) fs.unlinkSync(LEDGER_DB);
    if (fs.existsSync(CONTROL_DB)) fs.unlinkSync(CONTROL_DB);

    const ledger = new Database(LEDGER_DB);
    const control = new Database(CONTROL_DB);

    // Setup ledger
    ledger.exec(`
      CREATE TABLE IF NOT EXISTS fills (
        fill_id TEXT PRIMARY KEY, 
        order_id TEXT, 
        token_id TEXT, 
        family_id TEXT, 
        side TEXT, 
        price REAL, 
        size REAL, 
        size_usdc REAL, 
        liquidity_role TEXT, 
        fee REAL, 
        fee_rate_bps REAL,
        reconciled INTEGER, 
        filled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS family_runtime_state (
        family_id TEXT PRIMARY KEY, 
        current_tail_cost_usdc REAL, 
        tail_adjusted_pnl_live REAL, 
        updated_at TEXT
      );
    `);

    // Setup control
    control.exec(`
      CREATE TABLE IF NOT EXISTS family_catalog (
        family_id TEXT PRIMARY KEY,
        primary_category TEXT
      );
      CREATE TABLE IF NOT EXISTS family_validation_scorecards (
        scorecard_id TEXT PRIMARY KEY, 
        family_id TEXT, 
        profile TEXT, 
        summary_json TEXT, 
        validated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS family_validation_latest (
        family_id TEXT,
        profile TEXT,
        scorecard_id TEXT REFERENCES family_validation_scorecards(scorecard_id),
        PRIMARY KEY (family_id, profile)
      );
      CREATE TABLE IF NOT EXISTS family_deployments (
        family_id TEXT,
        profile TEXT,
        approved_scorecard_id TEXT REFERENCES family_validation_scorecards(scorecard_id),
        PRIMARY KEY (family_id, profile)
      );
      CREATE TABLE IF NOT EXISTS promotion_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        family_id TEXT,
        source_scorecard_id TEXT REFERENCES family_validation_scorecards(scorecard_id)
      );
      PRAGMA foreign_keys = ON;
    `);

    ledger.close();
    control.close();
  });

  afterEach(() => {
    if (fs.existsSync(LEDGER_DB)) fs.unlinkSync(LEDGER_DB);
    if (fs.existsSync(CONTROL_DB)) fs.unlinkSync(CONTROL_DB);
  });

  it("dry run shows expected changes without writing", () => {
    const ledger = new Database(LEDGER_DB);
    ledger
      .prepare(
        "INSERT INTO fills (fill_id, liquidity_role, price, size, fee, fee_rate_bps, family_id, order_id, token_id, side, size_usdc, reconciled, filled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "f1",
        "taker",
        0.5,
        100,
        5,
        1000,
        "fam-1",
        "o1",
        "t1",
        "buy",
        50,
        0,
        "2026-04-07T00:00:00Z",
      );
    ledger.close();

    const output = runBackfill();
    expect(output).toContain("fills to update: 1 / 1");
    expect(output).toContain("(dry mode — no writes. Re-run with --apply to commit.)");

    const ledgerCheck = new Database(LEDGER_DB);
    const fill = ledgerCheck.prepare("SELECT fee FROM fills WHERE fill_id = 'f1'").get() as any;
    expect(fill.fee).toBe(5);
    ledgerCheck.close();
  });

  it("updates fees using category rates when available", () => {
    const ledger = new Database(LEDGER_DB);
    const control = new Database(CONTROL_DB);

    // Crypto = 7.2%
    control
      .prepare("INSERT INTO family_catalog (family_id, primary_category) VALUES (?, ?)")
      .run("fam-crypto", "crypto");
    // Sports = 3.0%
    control
      .prepare("INSERT INTO family_catalog (family_id, primary_category) VALUES (?, ?)")
      .run("fam-sports", "sports");

    ledger
      .prepare(
        "INSERT INTO fills (fill_id, liquidity_role, price, size, fee, fee_rate_bps, family_id, order_id, token_id, side, size_usdc, reconciled, filled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "f1",
        "taker",
        0.5,
        100,
        5,
        1000,
        "fam-crypto",
        "o1",
        "t1",
        "buy",
        50,
        0,
        "2026-04-07T00:00:00Z",
      );
    ledger
      .prepare(
        "INSERT INTO fills (fill_id, liquidity_role, price, size, fee, fee_rate_bps, family_id, order_id, token_id, side, size_usdc, reconciled, filled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "f2",
        "taker",
        0.5,
        100,
        5,
        1000,
        "fam-sports",
        "o2",
        "t2",
        "sell",
        50,
        0,
        "2026-04-07T00:00:00Z",
      );

    ledger.close();
    control.close();

    runBackfill(["--apply"]);

    const ledgerCheck = new Database(LEDGER_DB);
    // f1 (crypto): fee = 100 * 0.072 * 0.5 * (1 - 0.5) = 100 * 0.072 * 0.25 = 1.8
    expect(
      (ledgerCheck.prepare("SELECT fee FROM fills WHERE fill_id = 'f1'").get() as any).fee,
    ).toBeCloseTo(1.8);
    // f2 (sports): fee = 100 * 0.03 * 0.5 * (1 - 0.5) = 100 * 0.03 * 0.25 = 0.75
    expect(
      (ledgerCheck.prepare("SELECT fee FROM fills WHERE fill_id = 'f2'").get() as any).fee,
    ).toBeCloseTo(0.75);
    ledgerCheck.close();
  });

  it("sets maker fees to 0 regardless of old fee", () => {
    const ledger = new Database(LEDGER_DB);
    ledger
      .prepare(
        "INSERT INTO fills (fill_id, liquidity_role, price, size, fee, fee_rate_bps, family_id, order_id, token_id, side, size_usdc, reconciled, filled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "f3",
        "maker",
        0.5,
        100,
        5,
        0,
        "fam-1",
        "o3",
        "t3",
        "buy",
        50,
        0,
        "2026-04-07T00:00:00Z",
      );
    ledger.close();

    runBackfill(["--apply"]);

    const ledgerCheck = new Database(LEDGER_DB);
    expect(
      (ledgerCheck.prepare("SELECT fee FROM fills WHERE fill_id = 'f3'").get() as any).fee,
    ).toBe(0);
    ledgerCheck.close();
  });

  it("uses fee_rate_bps as fallback when category is unknown", () => {
    const ledger = new Database(LEDGER_DB);
    const control = new Database(CONTROL_DB);
    // No category in control for fam-unknown

    ledger
      .prepare(
        "INSERT INTO fills (fill_id, liquidity_role, price, size, fee, fee_rate_bps, family_id, order_id, token_id, side, size_usdc, reconciled, filled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "f-fallback",
        "taker",
        0.5,
        100,
        5,
        500,
        "fam-unknown",
        "o4",
        "t4",
        "buy",
        50,
        0,
        "2026-04-07T00:00:00Z",
      );
    ledger.close();
    control.close();

    runBackfill(["--apply"]);

    const ledgerCheck = new Database(LEDGER_DB);
    // 500 bps = 5%
    // fee = 100 * 0.05 * 0.5 * (1 - 0.5) = 100 * 0.05 * 0.25 = 1.25
    expect(
      (ledgerCheck.prepare("SELECT fee FROM fills WHERE fill_id = 'f-fallback'").get() as any).fee,
    ).toBeCloseTo(1.25);
    ledgerCheck.close();
  });

  it("cleans up dependent references in control DB when deleting scorecards", () => {
    const control = new Database(CONTROL_DB);
    control
      .prepare(
        "INSERT INTO family_validation_scorecards (scorecard_id, family_id, profile, summary_json, validated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "sc-1",
        "fam-1",
        "live-lite",
        JSON.stringify({ executionTelemetry24h: { explicitFeesUsdc: 10 } }),
        "2026-04-07T00:00:00Z",
      );
    control
      .prepare(
        "INSERT INTO family_validation_latest (family_id, profile, scorecard_id) VALUES (?, ?, ?)",
      )
      .run("fam-1", "live-lite", "sc-1");
    control
      .prepare(
        "INSERT INTO family_deployments (family_id, profile, approved_scorecard_id) VALUES (?, ?, ?)",
      )
      .run("fam-1", "live-lite", "sc-1");
    control
      .prepare("INSERT INTO promotion_proposals (family_id, source_scorecard_id) VALUES (?, ?)")
      .run("fam-1", "sc-1");
    control.close();

    const ledger = new Database(LEDGER_DB);
    ledger
      .prepare(
        "INSERT INTO fills (fill_id, liquidity_role, price, size, fee, fee_rate_bps, family_id, order_id, token_id, side, size_usdc, reconciled, filled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "f1",
        "taker",
        0.5,
        100,
        5,
        1000,
        "fam-1",
        "o1",
        "t1",
        "buy",
        50,
        0,
        "2026-04-07T00:00:00Z",
      );
    ledger.close();

    // This should NOT fail with foreign key violation if we handle it correctly
    runBackfill(["--apply"]);

    const controlCheck = new Database(CONTROL_DB);
    expect(
      (controlCheck.prepare("SELECT count(*) n FROM family_validation_scorecards").get() as any).n,
    ).toBe(0);
    expect(
      (controlCheck.prepare("SELECT count(*) n FROM family_validation_latest").get() as any).n,
    ).toBe(0);
    expect(
      (controlCheck.prepare("SELECT approved_scorecard_id FROM family_deployments").get() as any)
        .approved_scorecard_id,
    ).toBeNull();
    expect(
      (controlCheck.prepare("SELECT source_scorecard_id FROM promotion_proposals").get() as any)
        .source_scorecard_id,
    ).toBeNull();
    controlCheck.close();
  });
});
