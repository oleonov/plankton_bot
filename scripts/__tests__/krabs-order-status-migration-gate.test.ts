import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));
const gate = join(root, "scripts", "krabs-order-status-migration-gate.sh");
const migration101 = join(root, "packages/db/src/migrations/101_repair_filled_phantom_orders.sql");
const migration102 = join(root, "packages/db/src/migrations/102_maker_capture_reprice_intents.sql");
const migration103 = join(
  root,
  "packages/db/src/migrations/103_bounce_ask_capture_reprice_intents.sql",
);
const migration106 = join(
  root,
  "packages/db/src/migrations/106_repair_trading_disabled_pending_orders.sql",
);
const marker101 = "101_repair_filled_phantom_orders.sql";
const marker102 = "102_maker_capture_reprice_intents.sql";
const marker103 = "103_bounce_ask_capture_reprice_intents.sql";
const marker106 = "106_repair_trading_disabled_pending_orders.sql";
const marker108 = "108_maker_capture_intents_token_index.sql";
const migration108 = join(root, "packages/db/src/migrations", marker108);
const tokenIndex = "idx_maker_capture_reprice_intents_token";
const sha = "a".repeat(40);
const dirs: string[] = [];

function sql(db: string, statement: string): string {
  const result = spawnSync("/usr/bin/sqlite3", [db], { encoding: "utf8", input: statement });
  if (result.status) throw new Error(result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "krabs-order-status-gate-"));
  dirs.push(dir);
  const db = join(dir, "ledger.db");
  sql(
    db,
    "CREATE TABLE orders(order_id TEXT PRIMARY KEY,status TEXT,cancel_reason TEXT,metadata_json TEXT,exchange_order_id TEXT,size REAL,client_order_id TEXT,fill_progress_shares NUMERIC,exchange_error_code TEXT,exchange_error_message TEXT,exchange_error_payload TEXT,exchange_rejection_reason TEXT,updated_at TEXT); CREATE TABLE fills(fill_id TEXT PRIMARY KEY,order_id TEXT,side TEXT,price REAL,size REAL,size_usdc REAL,liquidity_role TEXT); CREATE TABLE risk_events(id INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT,payload TEXT); CREATE TABLE schema_migrations(name TEXT); INSERT INTO orders VALUES('legacy-candidate','cancelled','phantom_missing_on_exchange','{\"audit\":1}','legacy-candidate',100,'legacy-candidate',NULL,NULL,NULL,NULL,NULL,'2026-08-21T00:00:00.000Z'),('partial','cancelled','phantom_missing_on_exchange','{}','partial',100,'partial',NULL,NULL,NULL,NULL,NULL,'2026-08-21T00:00:00.000Z'),('legacy-maker','cancelled','phantom_missing_on_exchange','{}','legacy-maker',100,'legacy-maker',NULL,NULL,NULL,NULL,NULL,'2026-08-21T00:00:00.000Z'),('other','cancelled','operator_cancelled','{}','other',100,'other',NULL,NULL,NULL,NULL,NULL,'2026-08-21T00:00:00.000Z'); INSERT INTO fills VALUES('f1','legacy-candidate','buy',0.95,99.4,95,'taker'),('f2','partial','buy',1,99,99,'maker'),('f3','legacy-maker','buy',0.95,99.4,95,'maker');",
  );
  return { db, snapshot: join(dir, "snapshot.json") };
}

function run(db: string, ...args: string[]) {
  const before = readFileSync(db);
  const result = spawnSync("bash", [gate, ...args], {
    env: { ...process.env, KRABS_ORDER_STATUS_LEDGER_PATH: db },
    encoding: "utf8",
  });
  expect(readFileSync(db).equals(before)).toBe(true);
  return result;
}

function apply(db: string, migration: string, marker: string): void {
  sql(db, readFileSync(migration, "utf8"));
  sql(db, `INSERT INTO schema_migrations VALUES('${marker}')`);
}

function insertIntent(db: string, intentId = "intent-1"): void {
  sql(
    db,
    `INSERT INTO maker_capture_reprice_intents VALUES('${intentId}','predecessor-${intentId}','signal-${intentId}','root-1','token-1','condition-1',1,'ready',0.1,1,NULL,NULL,'{"version":1}','2026-08-21T00:00:00.000Z','2026-08-21T00:00:00.000Z')`,
  );
}

function insertAskIntent(db: string, intentId = "ask-intent-1"): void {
  sql(
    db,
    `INSERT INTO bounce_ask_capture_reprice_intents VALUES('${intentId}','ask-predecessor-${intentId}','ask-signal-${intentId}','ask-root-1','position-1','ask-token-1','ask-condition-1',1,'ready',0.12,1,NULL,NULL,'{"version":1}','2026-08-23T00:00:00.000Z','2026-08-23T00:00:00.000Z')`,
  );
}

function insertTradingDisabledCandidate(db: string): void {
  sql(
    db,
    `INSERT INTO orders VALUES('disabled','pending',NULL,'{"keep":1,"makerCaptureLineageV1":{"version":1},"bounceAskCaptureLineageV1":{"version":1}}','disabled',10,'disabled-client',7,'BEFORE','before','{"before":true}','before','2026-08-21T00:00:00.000Z'); INSERT INTO risk_events(event_type,payload) VALUES('live_order_submit_unknown','{"orderId":"disabled","clientOrderId":"disabled-client","errorDetails":{"responseBody":{"status":503,"error":" Trading Is Disabled ","requestId":"request-1"}}}');`,
  );
}

function expectPreRejected(createIntentTable: string): void {
  const { db, snapshot } = fixture();
  sql(db, createIntentTable);
  expect(run(db, "pre", sha, snapshot).status).not.toBe(0);
}

function populatedFixture() {
  const result = fixture();
  for (const [migration, marker] of [
    [migration101, marker101],
    [migration102, marker102],
    [migration103, marker103],
    [migration106, marker106],
  ] as const)
    apply(result.db, migration, marker);
  insertIntent(result.db);
  insertAskIntent(result.db);
  return result;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("krabs order-status migration gate", () => {
  it.each(["between pre/post", "before pre", "legacy v4 snapshot"])(
    "accepts real migration 108 applied %s with unchanged base schema and row proofs",
    (timing) => {
      const { db, snapshot } = populatedFixture();
      const baseline = run(db, "pre", sha, snapshot + ".baseline");
      expect(baseline.status, baseline.stderr).toBe(0);
      if (timing === "before pre") apply(db, migration108, marker108);
      const pre = run(db, "pre", sha, snapshot);
      expect(pre.status, pre.stderr).toBe(0);
      expect(JSON.parse(pre.stdout)).toEqual(JSON.parse(baseline.stdout));
      const saved = JSON.parse(readFileSync(snapshot, "utf8"));
      expect(saved.migration102.tokenIndexWasPresent).toBe(timing === "before pre");
      if (timing === "legacy v4 snapshot") {
        delete saved.migration102.tokenIndexWasPresent;
        writeFileSync(snapshot, JSON.stringify(saved));
      }
      if (timing !== "before pre") apply(db, migration108, marker108);
      const post = run(db, "post", sha, snapshot);
      expect(post.status, post.stderr).toBe(0);
      expect(JSON.parse(post.stdout)).toEqual(JSON.parse(baseline.stdout));
      expect(JSON.parse(readFileSync(snapshot, "utf8"))).toEqual(saved);
    },
  );

  it.each([
    `DELETE FROM schema_migrations WHERE name='${marker108}'`,
    `INSERT INTO schema_migrations VALUES('${marker108}')`,
    `DROP INDEX ${tokenIndex}`,
    `DROP INDEX ${tokenIndex}; DELETE FROM schema_migrations WHERE name='${marker108}'; CREATE INDEX ${tokenIndex} ON orders(client_order_id)`,
    `DROP TABLE maker_capture_reprice_intents; DELETE FROM schema_migrations WHERE name='${marker102}'`,
    ...[
      `CREATE UNIQUE INDEX ${tokenIndex} ON maker_capture_reprice_intents(token_id)`,
      `CREATE INDEX ${tokenIndex} ON maker_capture_reprice_intents(token_id) WHERE status='ready'`,
      `CREATE INDEX ${tokenIndex} ON maker_capture_reprice_intents(status)`,
      `CREATE INDEX ${tokenIndex} ON maker_capture_reprice_intents(token_id DESC)`,
      `CREATE INDEX ${tokenIndex} ON maker_capture_reprice_intents(token_id COLLATE NOCASE)`,
      `CREATE INDEX ${tokenIndex} ON maker_capture_reprice_intents(token_id, status)`,
      `CREATE INDEX ${tokenIndex} ON maker_capture_reprice_intents(token_id ASC)`,
    ].map((create) => `DROP INDEX ${tokenIndex}; ${create}`),
    "CREATE INDEX unrelated ON maker_capture_reprice_intents(token_id)",
    "DROP INDEX idx_maker_capture_reprice_intents_status",
    "ALTER TABLE maker_capture_reprice_intents ADD COLUMN extra TEXT",
    "DROP INDEX idx_bounce_ask_capture_one_nonterminal_per_position",
  ])("rejects invalid migration 108 state or base schema drift: %s", (mutation) => {
    const { db, snapshot } = populatedFixture();
    expect(run(db, "pre", sha, snapshot).status).toBe(0);
    apply(db, migration108, marker108);
    sql(db, mutation);
    const saved = readFileSync(snapshot);
    for (const mode of ["pre", "post"]) {
      const result = run(db, mode, sha, mode === "pre" ? snapshot + ".invalid" : snapshot);
      expect(result.status, mutation).not.toBe(0);
      expect(result.stderr).toMatch(/migration (102|103|108)/);
    }
    expect(readFileSync(snapshot).equals(saved)).toBe(true);
  });

  it("rejects removal of both migration 108 index and marker after pre", () => {
    const { db, snapshot } = populatedFixture();
    apply(db, migration108, marker108);
    expect(run(db, "pre", sha, snapshot).status).toBe(0);
    sql(db, `DROP INDEX ${tokenIndex}; DELETE FROM schema_migrations WHERE name='${marker108}'`);
    const post = run(db, "post", sha, snapshot);
    expect(post.status).not.toBe(0);
    expect(post.stderr).toContain("migration 108 index was removed");
  });

  it.each(["maker", "bounce_ask"])(
    "still rejects %s intent row changes with migration 108",
    (kind) => {
      const { db, snapshot } = populatedFixture();
      expect(run(db, "pre", sha, snapshot).status).toBe(0);
      apply(db, migration108, marker108);
      sql(db, `UPDATE ${kind}_capture_reprice_intents SET status='failed'`);
      const post = run(db, "post", sha, snapshot);
      expect(post.status).not.toBe(0);
      expect(post.stderr).toContain("intent rows changed during migration gate");
    },
  );

  it("requires the original base schema hash in legacy v4 snapshots after migration 108", () => {
    const { db, snapshot } = populatedFixture();
    expect(run(db, "pre", sha, snapshot).status).toBe(0);
    const saved = JSON.parse(readFileSync(snapshot, "utf8"));
    delete saved.migration102.tokenIndexWasPresent;
    saved.migration102.schemaHash = "0".repeat(64);
    writeFileSync(snapshot, JSON.stringify(saved));
    apply(db, migration108, marker108);
    const post = run(db, "post", sha, snapshot);
    expect(post.status).not.toBe(0);
    expect(post.stderr).toContain("migration 102 schema proof changed");
  });

  it("accepts migration 106 exact candidates repaired to the canonical rejected state", () => {
    const { db, snapshot } = fixture();
    insertTradingDisabledCandidate(db);
    const pre = run(db, "pre", sha, snapshot);
    expect(pre.status, pre.stderr).toBe(0);
    expect(JSON.parse(pre.stdout).migration106).toMatchObject({
      candidateCount: 1,
      markerWasPresent: false,
    });
    apply(db, migration101, marker101);
    apply(db, migration102, marker102);
    apply(db, migration103, marker103);
    apply(db, migration106, marker106);
    const post = run(db, "post", sha, snapshot);
    expect(post.status, post.stderr).toBe(0);
    expect(JSON.parse(post.stdout).migration106).toMatchObject({ candidateCount: 1 });
  });

  it("rejects every noncanonical migration 106 candidate result", () => {
    for (const mutation of [
      "status='pending'",
      "fill_progress_shares=1",
      "exchange_error_code='OTHER'",
      "exchange_error_message='other'",
      `exchange_error_payload='{"responseBody":{"status":503}}'`,
      "exchange_rejection_reason='other'",
      `metadata_json='{"keep":1,"makerCaptureLineageV1":{"version":1}}'`,
      "updated_at='not-an-iso-timestamp'",
      "updated_at='2026-08-21T00:00:00.000Z'",
      "updated_at='2099-08-21T00:00:00.000Z'",
      "cancel_reason='changed'",
    ]) {
      const { db, snapshot } = fixture();
      insertTradingDisabledCandidate(db);
      expect(run(db, "pre", sha, snapshot).status).toBe(0);
      apply(db, migration101, marker101);
      apply(db, migration102, marker102);
      apply(db, migration103, marker103);
      apply(db, migration106, marker106);
      sql(db, `UPDATE orders SET ${mutation} WHERE order_id='disabled'`);
      expect(run(db, "post", sha, snapshot).status, mutation).not.toBe(0);
    }
  });

  it("proves first apply with absent intent tables and preserves migration 101 proof", () => {
    const { db, snapshot } = fixture();
    const pre = run(db, "pre", sha, snapshot);
    expect(pre.status, pre.stderr).toBe(0);
    expect(run(db, "pre", sha, snapshot).status).toBe(0);
    expect(JSON.parse(pre.stdout)).toMatchObject({
      migration101: { candidateCount: 1, markerWasPresent: false },
      migration102: { markerWasPresent: false, tableWasPresent: false, rowCount: 0 },
      migration103: { markerWasPresent: false, tableWasPresent: false, rowCount: 0 },
      migration106: { candidateCount: 0, markerWasPresent: false },
    });
    expect(JSON.parse(readFileSync(snapshot, "utf8"))).toMatchObject({
      schemaVersion: 4,
      migration101: { candidateCount: 1 },
      migration102: { tableWasPresent: false, rowCount: 0, rows: [] },
      migration103: { tableWasPresent: false, rowCount: 0, rows: [] },
      migration106: { candidateCount: 0, candidates: [] },
    });
    apply(db, migration101, marker101);
    apply(db, migration102, marker102);
    apply(db, migration103, marker103);
    apply(db, migration106, marker106);
    const post = run(db, "post", sha, snapshot);
    expect(post.status, post.stderr).toBe(0);
    const proof = JSON.parse(post.stdout);
    expect(Object.keys(proof).sort()).toEqual([
      "migration101",
      "migration102",
      "migration103",
      "migration106",
    ]);
    expect(Object.keys(proof.migration101).sort()).toEqual([
      "candidateCount",
      "candidateHash",
      "markerWasPresent",
      "rowsHash",
    ]);
    expect(Object.keys(proof.migration102).sort()).toEqual([
      "markerWasPresent",
      "rowCount",
      "rowsHash",
      "schemaHash",
      "tableWasPresent",
    ]);
    expect(Object.keys(proof.migration103).sort()).toEqual([
      "markerWasPresent",
      "rowCount",
      "rowsHash",
      "schemaHash",
      "tableWasPresent",
    ]);
    expect(Object.keys(proof.migration106).sort()).toEqual([
      "candidateCount",
      "candidateHash",
      "markerWasPresent",
    ]);
    expect(sql(db, "SELECT count(*) FROM maker_capture_reprice_intents")).toBe("0");
    expect(sql(db, "SELECT count(*) FROM bounce_ask_capture_reprice_intents")).toBe("0");
    expect(run(db, "pre", sha, snapshot).status).not.toBe(0);
  });

  it("fails closed for noncandidate mutation and never writes the ledger", () => {
    const { db, snapshot } = fixture();
    expect(run(db, "pre", sha, snapshot).status).toBe(0);
    sql(
      db,
      `UPDATE orders SET status='filled' WHERE order_id='legacy-candidate'; UPDATE orders SET status='open' WHERE order_id='other'; INSERT INTO schema_migrations VALUES('${marker101}');`,
    );
    apply(db, migration102, marker102);
    apply(db, migration103, marker103);
    apply(db, migration106, marker106);
    expect(run(db, "post", sha, snapshot).status).not.toBe(0);
    expect(
      spawnSync("/usr/bin/sqlite3", [db, "SELECT status FROM orders WHERE order_id='other'"], {
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("open");
  });

  it("accepts interrupted empty bootstraps and preserves rows on a future redeploy", () => {
    const interrupted = fixture();
    sql(interrupted.db, readFileSync(migration102, "utf8"));
    sql(interrupted.db, readFileSync(migration103, "utf8"));
    const interruptedPre = run(interrupted.db, "pre", sha, interrupted.snapshot);
    expect(interruptedPre.status, interruptedPre.stderr).toBe(0);
    expect(JSON.parse(interruptedPre.stdout).migration102).toMatchObject({
      markerWasPresent: false,
      tableWasPresent: true,
      rowCount: 0,
    });
    expect(JSON.parse(interruptedPre.stdout).migration103).toMatchObject({
      markerWasPresent: false,
      tableWasPresent: true,
      rowCount: 0,
    });
    apply(interrupted.db, migration101, marker101);
    sql(interrupted.db, `INSERT INTO schema_migrations VALUES('${marker102}')`);
    sql(interrupted.db, `INSERT INTO schema_migrations VALUES('${marker103}')`);
    apply(interrupted.db, migration106, marker106);
    expect(run(interrupted.db, "post", sha, interrupted.snapshot).status).toBe(0);

    const redeploy = fixture();
    apply(redeploy.db, migration101, marker101);
    apply(redeploy.db, migration102, marker102);
    apply(redeploy.db, migration103, marker103);
    apply(redeploy.db, migration106, marker106);
    insertIntent(redeploy.db);
    insertAskIntent(redeploy.db);
    const pre = run(redeploy.db, "pre", sha, redeploy.snapshot);
    expect(pre.status, pre.stderr).toBe(0);
    expect(JSON.parse(pre.stdout).migration102).toMatchObject({
      markerWasPresent: true,
      tableWasPresent: true,
      rowCount: 1,
    });
    expect(JSON.parse(pre.stdout).migration103).toMatchObject({
      markerWasPresent: true,
      tableWasPresent: true,
      rowCount: 1,
    });
    expect(run(redeploy.db, "post", sha, redeploy.snapshot).status).toBe(0);
    expect(sql(redeploy.db, "SELECT status FROM maker_capture_reprice_intents")).toBe("ready");
    expect(sql(redeploy.db, "SELECT status FROM bounce_ask_capture_reprice_intents")).toBe("ready");
  });

  it("rejects marker/table mismatches, duplicate markers, and unmarked rows", () => {
    const absent = fixture();
    sql(absent.db, `INSERT INTO schema_migrations VALUES('${marker102}')`);
    expect(run(absent.db, "pre", sha, absent.snapshot).status).not.toBe(0);

    const duplicate = fixture();
    sql(duplicate.db, readFileSync(migration102, "utf8"));
    sql(duplicate.db, `INSERT INTO schema_migrations VALUES('${marker102}'),('${marker102}')`);
    expect(run(duplicate.db, "pre", sha, duplicate.snapshot).status).not.toBe(0);

    const unmarked = fixture();
    sql(unmarked.db, readFileSync(migration102, "utf8"));
    insertIntent(unmarked.db);
    expect(run(unmarked.db, "pre", sha, unmarked.snapshot).status).not.toBe(0);

    const absent103 = fixture();
    apply(absent103.db, migration102, marker102);
    sql(absent103.db, `INSERT INTO schema_migrations VALUES('${marker103}')`);
    expect(run(absent103.db, "pre", sha, absent103.snapshot).status).not.toBe(0);

    const duplicate103 = fixture();
    apply(duplicate103.db, migration102, marker102);
    sql(duplicate103.db, readFileSync(migration103, "utf8"));
    sql(duplicate103.db, `INSERT INTO schema_migrations VALUES('${marker103}'),('${marker103}')`);
    expect(run(duplicate103.db, "pre", sha, duplicate103.snapshot).status).not.toBe(0);

    const unmarked103 = fixture();
    apply(unmarked103.db, migration102, marker102);
    sql(unmarked103.db, readFileSync(migration103, "utf8"));
    insertAskIntent(unmarked103.db);
    expect(run(unmarked103.db, "pre", sha, unmarked103.snapshot).status).not.toBe(0);

    const duplicate106 = fixture();
    sql(duplicate106.db, `INSERT INTO schema_migrations VALUES('${marker106}'),('${marker106}')`);
    expect(run(duplicate106.db, "pre", sha, duplicate106.snapshot).status).not.toBe(0);

    const stale106 = fixture();
    insertTradingDisabledCandidate(stale106.db);
    sql(stale106.db, `INSERT INTO schema_migrations VALUES('${marker106}')`);
    expect(run(stale106.db, "pre", sha, stale106.snapshot).status).not.toBe(0);
  });

  it("rejects noncanonical columns, CHECKs, UNIQUE constraints, and named indexes", () => {
    const canonical = readFileSync(migration102, "utf8");
    for (const corrupt of [
      canonical.replace("candidate_price       REAL", "candidate_price       TEXT"),
      canonical.replace(
        "  proof_json            TEXT NOT NULL CHECK (json_valid(proof_json)),\n",
        "",
      ),
      canonical.replace("BETWEEN 1 AND 5", "BETWEEN 1 AND 6"),
      canonical.replace("child_order_id        TEXT UNIQUE", "child_order_id        TEXT"),
      canonical.replace(
        "ON maker_capture_reprice_intents(status);",
        "ON maker_capture_reprice_intents(token_id);",
      ),
      canonical.replace(
        "ON maker_capture_reprice_intents(root_order_id, replacement_index);",
        "ON maker_capture_reprice_intents(root_order_id);",
      ),
    ]) {
      expectPreRejected(corrupt);
    }
  });

  it("rejects migration 103 old shapes and malformed proof constraints", () => {
    const canonical = readFileSync(migration103, "utf8");
    for (const corrupt of [
      canonical
        .replace("  position_id           TEXT NOT NULL,\n", "")
        .replace(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_bounce_ask_capture_one_nonterminal_per_position\n  ON bounce_ask_capture_reprice_intents(position_id)\n  WHERE status IN ('cancel_pending', 'ready', 'submitted');\n",
          "",
        ),
      canonical.replace("'failed', 'dust'", "'failed'"),
      canonical.replace(
        "  proof_json            TEXT NOT NULL CHECK (json_valid(proof_json)),\n",
        "",
      ),
      canonical.replace(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_bounce_ask_capture_one_nonterminal_per_position",
        "CREATE INDEX IF NOT EXISTS idx_bounce_ask_capture_one_nonterminal_per_position",
      ),
      canonical.replace(
        "WHERE status IN ('cancel_pending', 'ready', 'submitted');",
        "WHERE status IN ('cancel_pending', 'ready', 'failed');",
      ),
      canonical.replace("WHERE status IN ('cancel_pending', 'ready', 'submitted');", ""),
    ]) {
      const { db, snapshot } = fixture();
      apply(db, migration102, marker102);
      sql(db, corrupt);
      expect(run(db, "pre", sha, snapshot).status).not.toBe(0);
    }
  });

  it("rejects any migration 102 row mutation between the stopped-ledger snapshots", () => {
    const { db, snapshot } = fixture();
    apply(db, migration101, marker101);
    apply(db, migration102, marker102);
    apply(db, migration103, marker103);
    apply(db, migration106, marker106);
    insertIntent(db);
    expect(run(db, "pre", sha, snapshot).status).toBe(0);
    sql(db, "UPDATE maker_capture_reprice_intents SET status='failed',failure='changed'");
    expect(run(db, "post", sha, snapshot).status).not.toBe(0);
  });

  it("rejects any migration 103 row mutation between stopped-ledger snapshots", () => {
    const { db, snapshot } = fixture();
    apply(db, migration101, marker101);
    apply(db, migration102, marker102);
    apply(db, migration103, marker103);
    apply(db, migration106, marker106);
    insertAskIntent(db);
    expect(run(db, "pre", sha, snapshot).status).toBe(0);
    sql(db, "UPDATE bounce_ask_capture_reprice_intents SET status='failed',failure='changed'");
    expect(run(db, "post", sha, snapshot).status).not.toBe(0);
  });

  it("binds the staged helper in deploy order before target runtime start", () => {
    const deploy = readFileSync(join(root, "deploy.sh"), "utf8"),
      controller = deploy.slice(deploy.indexOf("controller() {"));
    expect(controller.indexOf("compose stop krabs-api")).toBeLessThan(
      controller.indexOf("migration_gate pre"),
    );
    expect(controller.indexOf("migration_gate pre")).toBeLessThan(
      controller.indexOf("if ! start_and_prove_target_api"),
    );
    expect(controller.indexOf("migration_gate post")).toBeLessThan(
      controller.indexOf('run "$DOCKER" start "$runtime"'),
    );
    expect(deploy).toContain("KRABS_ORDER_STATUS_GATE_SHA256");
  });
});
