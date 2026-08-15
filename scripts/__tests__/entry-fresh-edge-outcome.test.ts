import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { bootstrapLedgerDb } from "@krabs/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeEntryFreshEdgeOutcome,
  canonicalizeCohortStart,
} from "../measurement/entry-fresh-edge-outcome.js";

const START = "2026-08-15T00:00:00.000Z";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("entry-fresh-edge durable outcome analyzer", () => {
  it("ranks actual first fills, partitions cycles, ignores the expiring log, and trims exactly 1%", () => {
    const fixture = makeFixture();
    seedCycle(fixture.db, "win", { status: "closed", pnl: 5, settlement: true });
    addPartialFill(fixture.db, "win", "partial");
    seedCycle(fixture.db, "flat", {
      status: "closed",
      pnl: 0,
      settlement: true,
      rule: "OUTBID_REPRICE",
      shadowClass: "PLAUSIBLE_DIP",
    });
    seedCycle(fixture.db, "loss", { status: "closed", pnl: -5, settlement: true });
    seedCycle(fixture.db, "open", { status: "open" });
    seedCycle(fixture.db, "dust", { status: "dust" });
    seedCycle(fixture.db, "closed", { status: "closed", pnl: -1 });
    insertOrder(fixture.db, "unfilled", "tok-unfilled", "cond-unfilled", "R23_DIP_TRIGGER");
    fixture.db
      .prepare(
        `INSERT INTO decision_signal_log(signal_id,token_id,condition_id,side,state,price,buy_count,signal_timestamp)
         VALUES ('expired','token','condition','BUY','OTHER',.1,0,?)`,
      )
      .run(START);

    const before = analyzeEntryFreshEdgeOutcome({ ledger: fixture.path, cohortStart: START });
    fixture.db.prepare("DELETE FROM decision_signal_log").run();
    const after = analyzeEntryFreshEdgeOutcome({ ledger: fixture.path, cohortStart: START });

    expect(after).toEqual(before);
    expect(after.status).toBe("READOUT_PREMATURE");
    expect(after.coverage).toMatchObject({
      attributedTotal: 6,
      open: 1,
      dust: 1,
      closedUnsettled: 1,
      settled: 3,
    });
    expect(after.outcomes.overall).toEqual({
      count: 3,
      wins: 1,
      flats: 1,
      losses: 1,
      totalRealizedPnl: 0,
    });
    expect(after.exTop1PctAbsPnl.removed).toBe(1);
    expect(after.exTop1PctAbsPnl.overall).toEqual({
      count: 2,
      wins: 0,
      flats: 1,
      losses: 1,
      totalRealizedPnl: -5,
    });
    fixture.close();
  });

  it("fails closed on later back-labels, malformed/direct gaps, unknown outbid origins, and bad relations", () => {
    const fixture = makeFixture();
    seedCycle(fixture.db, "legacy", {
      status: "closed",
      settlement: true,
      metadata: null,
    });
    addFill(fixture.db, "legacy", "later", attribution("sig-later", "PLAUSIBLE_DIP"));
    seedCycle(fixture.db, "malformed", {
      status: "closed",
      settlement: true,
      metadata: JSON.stringify({ entryFreshEdgeAttribution: { version: 2 } }),
    });
    seedCycle(fixture.db, "unknown", {
      status: "closed",
      settlement: true,
      rule: "OUTBID_REPRICE",
      omitOrigin: true,
    });
    seedCycle(fixture.db, "settlement-mismatch", { status: "closed", settlement: true });
    fixture.db
      .prepare(
        "UPDATE settlement_ledger SET token_id='wrong' WHERE position_id='pos-settlement-mismatch'",
      )
      .run();
    seedCycle(fixture.db, "conflict", { status: "closed", settlement: true });
    addFill(fixture.db, "conflict", "later", attribution("sig-other", "PLAUSIBLE_DIP"));
    seedCycle(fixture.db, "wrong-rule", { status: "closed", settlement: true });
    fixture.db
      .prepare("UPDATE orders SET decision_rule_id='FALLBACK' WHERE order_id='ord-wrong-rule'")
      .run();
    seedCycle(fixture.db, "duplicate-lot", { status: "closed", settlement: true });
    insertPosition(
      fixture.db,
      "duplicate-lot-cross",
      "tok-duplicate-lot",
      "cond-duplicate-lot",
      "closed",
      1,
    );
    fixture.db
      .prepare(
        `INSERT INTO inventory_lots(lot_id,position_id,token_id,side,size,remaining_size,
          entry_price,cost_usdc,fill_id) VALUES ('lot-cross','pos-duplicate-lot-cross',
          'tok-duplicate-lot','buy',5,5,.1,.5,'fill-duplicate-lot')`,
      )
      .run();
    seedCycle(fixture.db, "duplicate-settlement", {
      status: "closed",
      settlement: true,
    });
    insertSettlementRow(
      fixture.db,
      "duplicate-settlement-second",
      "pos-duplicate-settlement",
      "tok-duplicate-settlement",
      "cond-duplicate-settlement",
    );
    seedCycle(fixture.db, "duplicate-origin", {
      status: "closed",
      settlement: true,
      rule: "OUTBID_REPRICE",
    });
    insertOrder(
      fixture.db,
      "origin-duplicate-origin-second",
      "tok-duplicate-origin",
      "cond-duplicate-origin",
      "R23_DIP_TRIGGER",
      "sig-origin-duplicate-origin",
      attribution("sig-origin-duplicate-origin"),
    );
    seedCycle(fixture.db, "mismatched-origin", {
      status: "closed",
      settlement: true,
      rule: "OUTBID_REPRICE",
    });
    fixture.db
      .prepare("UPDATE orders SET metadata_json=? WHERE order_id='ord-origin-mismatched-origin'")
      .run(attribution("sig-origin-mismatched-origin", "AFTER_PUMP_EXPENSIVE"));
    for (const [id, table] of [
      ["lot-side", "inventory_lots"],
      ["position-side", "positions"],
    ] as const) {
      seedCycle(fixture.db, id, { status: "closed", settlement: true });
      fixture.db.prepare(`UPDATE ${table} SET side='sell' WHERE position_id='pos-${id}'`).run();
    }

    const report = analyzeEntryFreshEdgeOutcome({ ledger: fixture.path, cohortStart: START });

    expect(report.coverage).toMatchObject({
      attributedTotal: 0,
      settled: 0,
      directR23MissingOrInvalid: 2,
      outbidUnknownOrigin: 3,
      invalidProvenance: 8,
    });
    fixture.close();
  });

  it("marks the readout ready at exactly 30 settled cycles", () => {
    const fixture = makeFixture();
    for (let index = 0; index < 30; index++) {
      seedCycle(fixture.db, `ready-${index}`, { status: "closed", settlement: true });
    }

    const report = analyzeEntryFreshEdgeOutcome({ ledger: fixture.path, cohortStart: START });

    expect(report.status).toBe("READOUT_READY");
    expect(report.coverage.settled).toBe(30);
    expect(report.exTop1PctAbsPnl).toMatchObject({ removed: 1, overall: { count: 29 } });
    fixture.close();
  });

  it("rejects invalid instants and the real CLI emits aggregate-only JSON", () => {
    expect(() => canonicalizeCohortStart("August 15")).toThrow(/ISO-8601/);
    expect(() => canonicalizeCohortStart("2026-02-30T00:00:00Z")).toThrow(/invalid/);
    expect(canonicalizeCohortStart("2026-08-15T00:00:00Z")).toBe(START);
    const fixture = makeFixture();
    seedCycle(fixture.db, "private-id", { status: "closed", settlement: true });
    fixture.db.close();
    const script = resolve(import.meta.dirname, "../measurement/entry-fresh-edge-outcome.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", script, "--ledger", fixture.path, "--cohort-start", START],
      { encoding: "utf8", timeout: 15_000 },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "READOUT_PREMATURE" });
    expect(result.stdout).not.toContain("private-id");

    const invalid = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        script,
        "--ledger",
        join(fixture.path, "private-db-id"),
        "--cohort-start",
        "invalid",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toMatch(/ISO-8601/);
    expect(invalid.stderr).not.toContain("private-db-id");
  });
});

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "fresh-edge-outcome-"));
  dirs.push(dir);
  const path = join(dir, "ledger.db");
  bootstrapLedgerDb(path).close();
  const db = new Database(path);
  return { db, path, close: () => db.close() };
}

function attribution(signalId: string, shadowClass = "FALLING_WITHOUT_RECOVERY") {
  return JSON.stringify({
    entryFreshEdgeAttribution: {
      version: 1,
      originSignalId: signalId,
      originDecisionRuleId: "R23_DIP_TRIGGER",
      entryKind: "first_entry",
      shadowClass,
    },
  });
}

function seedCycle(
  db: Database.Database,
  id: string,
  options: {
    status: "open" | "dust" | "closed";
    pnl?: number;
    settlement?: boolean;
    rule?: "R23_DIP_TRIGGER" | "OUTBID_REPRICE";
    shadowClass?: string;
    metadata?: string | null;
    omitOrigin?: boolean;
  },
): void {
  const token = `tok-${id}`;
  const condition = `cond-${id}`;
  const originSignal = `sig-origin-${id}`;
  const metadata =
    options.metadata === undefined
      ? attribution(originSignal, options.shadowClass)
      : options.metadata;
  insertPosition(db, id, token, condition, options.status, options.pnl ?? 0);
  if (options.rule === "OUTBID_REPRICE" && !options.omitOrigin) {
    insertOrder(db, `origin-${id}`, token, condition, "R23_DIP_TRIGGER", originSignal, metadata);
  }
  const signal = options.rule === "OUTBID_REPRICE" ? `sig-reprice-${id}` : originSignal;
  insertOrder(db, id, token, condition, options.rule ?? "R23_DIP_TRIGGER", signal, metadata);
  addFill(db, id, "first", metadata, START);
  if (options.settlement) insertSettlement(db, id, token, condition);
}

function insertPosition(
  db: Database.Database,
  id: string,
  token: string,
  condition: string,
  status: "open" | "dust" | "closed",
  pnl: number,
): void {
  db.prepare(
    `INSERT INTO positions(position_id,token_id,condition_id,side,size,avg_entry_price,cost_basis_usdc,
      realized_pnl,status,opened_at) VALUES (?,?,?,'buy',10,.1,1,?,?,?)`,
  ).run(`pos-${id}`, token, condition, pnl, status, START);
}

function insertOrder(
  db: Database.Database,
  id: string,
  token: string,
  condition: string,
  rule: string,
  signal = `sig-origin-${id}`,
  metadata: string | null = attribution(signal),
): void {
  db.prepare(
    `INSERT INTO orders(order_id,client_order_id,token_id,condition_id,side,order_type,price,size,
      size_usdc,status,signal_id,decision_rule_id,metadata_json,bot_run_id)
     VALUES (?,?,?,?,'buy','GTC',.1,10,1,'open',?,?,?,'run')`,
  ).run(`ord-${id}`, `client-${id}`, token, condition, signal, rule, metadata);
}

function addFill(
  db: Database.Database,
  cycle: string,
  suffix: string,
  metadata: string | null,
  filledAt = "2026-08-15T00:00:01.000Z",
): void {
  const token = `tok-${cycle}`;
  const condition = `cond-${cycle}`;
  const orderId = suffix === "first" ? cycle : `${cycle}-${suffix}`;
  if (suffix !== "first") {
    insertOrder(db, orderId, token, condition, "R23_DIP_TRIGGER", `sig-${orderId}`, metadata);
  }
  db.prepare(
    `INSERT INTO fills(fill_id,order_id,token_id,condition_id,side,price,size,size_usdc,filled_at)
     VALUES (?,?,?,?,'buy',.1,5,.5,?)`,
  ).run(`fill-${orderId}`, `ord-${orderId}`, token, condition, filledAt);
  db.prepare(
    `INSERT INTO inventory_lots(lot_id,position_id,token_id,side,size,remaining_size,entry_price,cost_usdc,fill_id)
     VALUES (?,?,?,'buy',5,5,.1,.5,?)`,
  ).run(`lot-${orderId}`, `pos-${cycle}`, token, `fill-${orderId}`);
}

function addPartialFill(db: Database.Database, cycle: string, suffix: string): void {
  const token = `tok-${cycle}`;
  const condition = `cond-${cycle}`;
  const fillId = `fill-${cycle}-${suffix}`;
  db.prepare(
    `INSERT INTO fills(fill_id,order_id,token_id,condition_id,side,price,size,size_usdc,filled_at)
     VALUES (? ,?,?,?,'buy',.1,5,.5,'2026-08-15T00:00:01.000Z')`,
  ).run(fillId, `ord-${cycle}`, token, condition);
  db.prepare(
    `INSERT INTO inventory_lots(lot_id,position_id,token_id,side,size,remaining_size,entry_price,cost_usdc,fill_id)
     VALUES (?,?,?,'buy',5,5,.1,.5,?)`,
  ).run(`lot-${cycle}-${suffix}`, `pos-${cycle}`, token, fillId);
}

function insertSettlement(
  db: Database.Database,
  id: string,
  token: string,
  condition: string,
): void {
  db.prepare(
    `INSERT INTO market_resolutions(condition_id,resolution,resolved_at,detected_at,source)
     VALUES (?,'Yes',?,?,'test')`,
  ).run(condition, START, START);
  insertSettlementRow(db, id, `pos-${id}`, token, condition);
}

function insertSettlementRow(
  db: Database.Database,
  id: string,
  position: string,
  token: string,
  condition: string,
): void {
  db.prepare(
    `INSERT INTO settlement_ledger(settlement_id,condition_id,position_id,token_id,resolution,
      settlement_price,size,delta,settled_at) VALUES (?,?,?,?,'Yes',1,10,1,?)`,
  ).run(`settlement-${id}`, condition, position, token, START);
}
