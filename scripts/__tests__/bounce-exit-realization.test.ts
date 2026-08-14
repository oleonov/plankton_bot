import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { bootstrapControlDb, bootstrapLedgerDb } from "@krabs/db";
import { describe, expect, it } from "vitest";
import { analyze, validateSnapshot } from "../measurement/bounce-exit-realization.js";

const RELEASE_SHA = "3540bb71132933b97584859cb1324bf667b55d0c";
const HISTORICAL_CUTOFF = "2026-08-06T16:13:33.000Z";
const STRICT_CUTOFF = "2026-08-14T07:03:45.828Z";

const policyValue = {
  bounceExit: {
    enabled: true,
    mode: "micro_live",
    applyToAllMarkets: true,
    targetTiers: [{ maxPrice: 1, gainPct: 0.08 }],
    ladderFractions: [0.3, 0.4, 0.3],
    ladderStepPct: 0.22,
    backstopTtcHours: 24,
    microMaxOrderUsdc: 2,
  },
};
const policy = JSON.stringify(policyValue);

type Fixture = ReturnType<typeof fixture>;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bounce-exit-"));
  const ledger = join(dir, "ledger.db");
  const control = join(dir, "control.db");
  bootstrapLedgerDb(ledger).close();
  const connection = bootstrapControlDb(control);
  const before = (
    connection.db
      .prepare(
        "SELECT execution_policy_json value FROM profile_settings WHERE profile_id='live-lite'",
      )
      .get() as { value: string }
  ).value;
  connection.db
    .prepare("UPDATE profile_settings SET execution_policy_json=? WHERE profile_id='live-lite'")
    .run(policy);
  connection.db
    .prepare(
      "INSERT INTO profile_settings_history(profile_id,field,before_value,after_value,actor,source,changed_at) VALUES ('live-lite','execution_policy_json',?,?, 'test','test','2026-08-01T00:00:00.000Z')",
    )
    .run(before, policy);
  connection.close();
  const database = new Database(ledger);
  database.pragma("journal_mode = WAL");
  return {
    database,
    ledger,
    control,
    dir,
    close: () => {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const options = (value: Fixture) => ({
  ledger: value.ledger,
  control: value.control,
  profile: "live-lite",
  releaseSha: RELEASE_SHA,
  historicalCutoff: HISTORICAL_CUTOFF,
  strictCutoff: STRICT_CUTOFF,
});

function insertPosition(
  database: Database.Database,
  id: string,
  values: {
    status?: string;
    realized?: number;
    openedAt?: string;
    owner?: "bounce" | "profile" | null;
    lane?: "GATE" | "R23" | null;
  } = {},
): void {
  const status = values.status ?? "open";
  database
    .prepare(
      `INSERT INTO positions(
         position_id,token_id,condition_id,side,size,realized_pnl,status,
         entry_lane,exit_owner,opened_at
       ) VALUES (?,?,?,'buy',?,?,?,?,?,?)`,
    )
    .run(
      id,
      `token-${id}`,
      `condition-${id}`,
      status === "closed" ? 0 : 10,
      values.realized ?? 0,
      status,
      values.lane ?? "R23",
      values.owner === undefined ? "bounce" : values.owner,
      values.openedAt ?? HISTORICAL_CUTOFF,
    );
}

function insertOrder(
  database: Database.Database,
  id: string,
  position: string,
  rule: string | null,
  metadata = "{}",
  exchange: string | null = "exchange",
  side = "sell",
  token = `token-${position}`,
): void {
  database
    .prepare(
      `INSERT INTO orders(
         order_id,client_order_id,token_id,condition_id,side,order_type,price,size,size_usdc,
         status,decision_rule_id,position_id,bot_run_id,metadata_json,exchange_order_id
       ) VALUES (?,?,?,?,?,'GTC',.5,10,5,'open',?,?,?,?,?)`,
    )
    .run(
      id,
      `client-${id}`,
      token,
      `condition-${position}`,
      side,
      rule,
      position,
      "run",
      metadata,
      exchange,
    );
}

function insertFill(
  database: Database.Database,
  id: string,
  order: string,
  position: string,
  side = "sell",
  token = `token-${position}`,
): void {
  database
    .prepare(
      "INSERT INTO fills(fill_id,order_id,token_id,condition_id,side,price,size,size_usdc) VALUES (?,?,?,?,?,.5,10,5)",
    )
    .run(id, order, token, `condition-${position}`, side);
}

function insertBuyLot(database: Database.Database, position: string, suffix = ""): void {
  const order = `buy-order-${position}${suffix}`;
  const fill = `buy-fill-${position}${suffix}`;
  insertOrder(database, order, position, null, "{}", order, "buy");
  insertFill(database, fill, order, position, "buy");
  database.prepare("UPDATE orders SET position_id=NULL WHERE order_id=?").run(order);
  database
    .prepare(
      `INSERT INTO inventory_lots(
         lot_id,position_id,token_id,side,size,remaining_size,entry_price,cost_usdc,fill_id
       ) VALUES (?,?,?,'buy',10,0,.5,5,?)`,
    )
    .run(`lot-${position}${suffix}`, position, `token-${position}`, fill);
}

function insertTargetSell(
  database: Database.Database,
  position: string,
  realizedDelta: number | null,
  metadata = rung(0),
  fillToken?: string,
): void {
  const order = `sell-order-${position}`;
  const fill = `sell-fill-${position}`;
  insertOrder(database, order, position, "BOUNCE_EXIT_TARGET", metadata);
  insertFill(database, fill, order, position, "sell", fillToken);
  if (realizedDelta !== null) {
    database
      .prepare(
        "INSERT INTO pnl_ledger(fill_id,position_id,delta,filled_at) VALUES (?,?,?,'2026-08-07T00:00:00.000Z')",
      )
      .run(fill, position, realizedDelta);
  }
}

function insertTarget(
  database: Database.Database,
  id: string,
  position: string,
  metadata: string,
): void {
  insertOrder(database, id, position, "BOUNCE_EXIT_TARGET", metadata);
}

function insertSettlement(database: Database.Database, position: string, delta = -5): void {
  database
    .prepare(
      "INSERT INTO market_resolutions(condition_id,resolution,resolved_at,detected_at,source,status) VALUES (?,'NO','2026-08-08T00:00:00.000Z','2026-08-08T00:00:00.000Z','test','settled')",
    )
    .run(`condition-${position}`);
  database
    .prepare(
      `INSERT INTO settlement_ledger(
         settlement_id,condition_id,position_id,token_id,resolution,settlement_price,size,delta,settled_at
       ) VALUES (?,?,?,?, 'NO',0,10,?,'2026-08-08T00:00:00.000Z')`,
    )
    .run(`settlement-${position}`, `condition-${position}`, position, `token-${position}`, delta);
}

const rung = (index: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    bounceRung: {
      ladderId: "ladder",
      rungIndex: index,
      rungIndicesCovered: [index],
      anchorPrice: 0.2,
      fraction: 0.3,
      originalPositionSize: 10,
      ...extra,
    },
  });

function setPolicy(v: Fixture, before: string, after: string, at = "2026-08-08T00:00:00.000Z") {
  const control = new Database(v.control);
  control
    .prepare(
      "INSERT INTO profile_settings_history(profile_id,field,before_value,after_value,actor,source,changed_at) VALUES ('live-lite','execution_policy_json',?,?, 'test','test',?)",
    )
    .run(before, after, at);
  control.prepare("UPDATE profile_settings SET execution_policy_json=?").run(after);
  control.close();
}

function expectFailure(setup: (value: Fixture) => void, message: string): void {
  const value = fixture();
  try {
    setup(value);
    expect(() => analyze(options(value))).toThrowError(new RegExp(message));
  } finally {
    value.close();
  }
}

function resign(snapshot: Record<string, unknown>): Record<string, unknown> {
  const { observedAt: _observedAt, digest: _digest, ...body } = snapshot;
  snapshot.digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return snapshot;
}

describe("bounce exit realization real SQLite fixtures", () => {
  it("normalizes all ledger timestamp forms and separates total from bounce ownership", () => {
    const value = fixture();
    try {
      insertPosition(value.database, "iso", { openedAt: "2026-08-06T16:13:33.000Z" });
      insertPosition(value.database, "space", { openedAt: "2026-08-06 16:13:33" });
      insertPosition(value.database, "offset", { openedAt: "2026-08-06 16:13:33+00" });
      insertPosition(value.database, "profile", { owner: "profile" });
      insertPosition(value.database, "older", { openedAt: "2026-08-06T16:13:32.999Z" });
      const result = analyze(options(value));
      expect(result.cohorts.allMarketsHistorical).toMatchObject({
        positions: 4,
        bounceOwnedPositions: 3,
        bounceEntryLanes: [{ entryLane: "R23", positions: 3 }],
      });
    } finally {
      value.close();
    }
  });

  it("freezes analyzer high-water while a concurrent writer commits", () => {
    const value = fixture();
    try {
      insertPosition(value.database, "before");
      const first = analyze({
        ...options(value),
        onHighWaterCaptured: () => {
          insertPosition(value.database, "during");
          value.database.exec("UPDATE positions SET entry_lane='GATE' WHERE position_id='before'");
        },
      });
      const highWater = first.source.highWater.positions;
      const frozen = analyze({ ...options(value), highWater: { positions: highWater } });
      const fresh = analyze(options(value));
      const original = first.cohorts.allMarketsHistorical;
      const bounded = frozen.cohorts.allMarketsHistorical;
      expect([original.positions, original.bounceEntryLanes[0]!.entryLane]).toEqual([1, "R23"]);
      expect([bounded.positions, bounded.bounceEntryLanes[0]!.entryLane]).toEqual([1, "GATE"]);
      expect(fresh.cohorts.allMarketsHistorical.positions).toBe(2);
    } finally {
      value.close();
    }
  });

  it("dedupes churn and separates direct rungs, rollover, cleanup, and backstop states", () => {
    const value = fixture();
    try {
      insertPosition(value.database, "SENTINEL_POSITION_ID", { lane: "GATE" });
      const position = "SENTINEL_POSITION_ID";
      insertOrder(value.database, "ordinary", position, "BOUNCE_EXIT_TARGET", rung(0));
      insertFill(value.database, "ordinary-fill", "ordinary", position);
      insertOrder(value.database, "churn", position, "BOUNCE_EXIT_TARGET", rung(0), null);
      insertTarget(value.database, "bundle-a", position, rung(1, { rungIndicesCovered: [1, 2] }));
      insertTarget(value.database, "bundle-b", position, rung(1, { rungIndicesCovered: [1, 2] }));
      insertFill(value.database, "SENTINEL_FILL_ID", "bundle-a", position);
      insertFill(value.database, "bundle-fill-2", "bundle-a", position);
      insertTarget(value.database, "cleanup", position, rung(2, { isCleanupRung: true }));
      insertFill(value.database, "cleanup-fill", "cleanup", position);
      insertOrder(
        value.database,
        "backstop-rejected",
        position,
        "BOUNCE_EXIT_BACKSTOP",
        "{}",
        null,
      );
      insertOrder(value.database, "backstop-accepted", position, "BOUNCE_EXIT_BACKSTOP");
      insertOrder(value.database, "backstop-filled", position, "BOUNCE_EXIT_BACKSTOP");
      insertFill(value.database, "backstop-fill", "backstop-filled", position);
      const snapshot = analyze(options(value));
      const result = snapshot.cohorts.allMarketsHistorical;
      expect([
        result.targetRows,
        result.targetLogicalRungs,
        result.targetPositions,
        result.targetFilledPositions,
      ]).toEqual([5, 3, 1, 1]);
      expect(Object.values(result.rolloverBundles)).toEqual([1, 1, 2, 2, 1, 1, 2, 20, 10]);
      expect(result.targetRungs.map(Object.values)).toEqual([
        [0, 1, 1, 1],
        [1, 1, 1, 0],
        [2, 1, 1, 0],
      ]);
      expect([Object.values(result.cleanup), Object.values(result.backstop)]).toEqual([
        [1, 1, 1, 1],
        [1, 1, 1, 3],
      ]);
      expect(JSON.stringify(snapshot)).not.toContain("SENTINEL_");
    } finally {
      value.close();
    }
  });

  it("reconstructs sell and settlement ROI without calling an ordinary close held-to-zero", () => {
    const value = fixture();
    try {
      insertPosition(value.database, "sold", { status: "closed", realized: 2 });
      insertBuyLot(value.database, "sold");
      insertBuyLot(value.database, "sold", "-second");
      insertTargetSell(value.database, "sold", 2);
      insertPosition(value.database, "resolved", { status: "closed", realized: -5 });
      insertBuyLot(value.database, "resolved");
      insertSettlement(value.database, "resolved");
      const terminal = analyze(options(value)).cohorts.allMarketsHistorical.terminal;
      expect([terminal.positions, terminal.multiLot, terminal.cost, terminal.realizedPnl]).toEqual([
        2, 1, 15, -3,
      ]);
      expect(terminal.roiPct).toEqual([-100, 20]);
    } finally {
      value.close();
    }
  });

  it("rejects privacy, strict supersets, and impossible fill evidence", () => {
    const value = fixture();
    try {
      insertPosition(value.database, "position");
      insertOrder(value.database, "target", "position", "BOUNCE_EXIT_TARGET", rung(0));
      insertFill(value.database, "target-fill", "target", "position");
      const snapshot = analyze(options(value));
      expect(() => validateSnapshot({ ...snapshot, position_id: "leak" })).toThrow(/non-public/);
      const falseProvenance = structuredClone(snapshot) as unknown as Record<string, unknown>;
      (falseProvenance.provenance as Record<string, unknown>).rawIdentifiersExcluded = false;
      expect(() => validateSnapshot(resign(falseProvenance))).toThrow(/source provenance/);
      const leakedLane = structuredClone(snapshot) as unknown as Record<string, unknown>;
      const historical = (leakedLane.cohorts as Record<string, Record<string, unknown>>)
        .allMarketsHistorical!;
      (historical.bounceEntryLanes as Array<Record<string, unknown>>)[0]!.entryLane = "identifier";
      expect(() => validateSnapshot(resign(leakedLane))).toThrow(/entry lanes/);
      const invalidSubset = structuredClone(snapshot) as unknown as Record<string, unknown>;
      const invalidCohorts = invalidSubset.cohorts as Record<string, Record<string, unknown>>;
      invalidCohorts.post137bStrict!.positions = 2;
      expect(() => validateSnapshot(resign(invalidSubset))).toThrow(/strict cohort subset/);
      const impossibleFills = structuredClone(snapshot) as unknown as Record<string, unknown>;
      const impossibleSource = impossibleFills.source as Record<string, Record<string, unknown>>;
      impossibleSource.highWater!.fills = 0;
      expect(() => validateSnapshot(resign(impossibleFills))).toThrow(/fill high-water/);
    } finally {
      value.close();
    }
  });

  it("rejects policy discontinuity, scope drift, current mismatch, and post-cutoff raw gaps", () => {
    const formatted = JSON.stringify(policyValue, null, 2);
    const scopedOff = JSON.stringify({
      ...policyValue,
      bounceExit: { ...policyValue.bounceExit, applyToAllMarkets: false },
    });
    expectFailure((value) => setPolicy(value, formatted, policy), "exact policy history");
    expectFailure((value) => setPolicy(value, policy, scopedOff), "recorded policy drift");
    expectFailure((value) => {
      const control = new Database(value.control);
      control.prepare("UPDATE profile_settings SET execution_policy_json=?").run(scopedOff);
      control.close();
    }, "current policy does not bind history");
  });

  it("discloses pre-cutoff raw gaps", () => {
    const value = fixture();
    try {
      setPolicy(value, JSON.stringify(policyValue, null, 2), policy, "2026-08-02T00:00:00.000Z");
      setPolicy(value, policy, policy);
      expect(analyze(options(value)).policy.rawContinuityBreaks).toBe(1);
    } finally {
      value.close();
    }
  });

  it("rejects broken terminal provenance and missing indexes", () => {
    expectFailure((value) => {
      insertPosition(value.database, "position", { status: "closed" });
      insertBuyLot(value.database, "position");
      value.database.prepare("UPDATE inventory_lots SET cost_usdc=0").run();
    }, "lot cost must be positive");
    expectFailure((value) => {
      insertPosition(value.database, "position", { status: "closed", realized: 2 });
      insertBuyLot(value.database, "position");
      insertTargetSell(value.database, "position", 1);
    }, "terminal pnl disagreement");
    expectFailure(
      (value) => value.database.exec("DROP INDEX idx_orders_position"),
      "required index",
    );
  });

  it("rejects zero, negative, and too-high bounds", () => {
    const value = fixture();
    try {
      insertPosition(value.database, "before");
      for (const positions of [0, -1, 999]) {
        expect(() => analyze({ ...options(value), highWater: { positions } })).toThrow(
          /invalid frozen high water/,
        );
      }
    } finally {
      value.close();
    }
  });
});
