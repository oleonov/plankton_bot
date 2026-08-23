import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const marker101 = "101_repair_filled_phantom_orders.sql";
const marker102 = "102_maker_capture_reprice_intents.sql";
const marker103 = "103_bounce_ask_capture_reprice_intents.sql";
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
    "CREATE TABLE orders(order_id TEXT PRIMARY KEY,status TEXT,cancel_reason TEXT,metadata_json TEXT,exchange_order_id TEXT,size REAL); CREATE TABLE fills(fill_id TEXT PRIMARY KEY,order_id TEXT,side TEXT,price REAL,size REAL,size_usdc REAL,liquidity_role TEXT); CREATE TABLE schema_migrations(name TEXT); INSERT INTO orders VALUES('legacy-candidate','cancelled','phantom_missing_on_exchange','{\"audit\":1}','legacy-candidate',100),('partial','cancelled','phantom_missing_on_exchange','{}','partial',100),('legacy-maker','cancelled','phantom_missing_on_exchange','{}','legacy-maker',100),('other','cancelled','operator_cancelled','{}','other',100); INSERT INTO fills VALUES('f1','legacy-candidate','buy',0.95,99.4,95,'taker'),('f2','partial','buy',1,99,99,'maker'),('f3','legacy-maker','buy',0.95,99.4,95,'maker');",
  );
  return { db, snapshot: join(dir, "snapshot.json") };
}

function run(db: string, ...args: string[]) {
  return spawnSync("bash", [gate, ...args], {
    env: { ...process.env, KRABS_ORDER_STATUS_LEDGER_PATH: db },
    encoding: "utf8",
  });
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

function expectPreRejected(createIntentTable: string): void {
  const { db, snapshot } = fixture();
  sql(db, createIntentTable);
  expect(run(db, "pre", sha, snapshot).status).not.toBe(0);
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("krabs order-status migration gate", () => {
  it("proves first apply with absent intent tables and preserves migration 101 proof", () => {
    const { db, snapshot } = fixture();
    const pre = run(db, "pre", sha, snapshot);
    expect(pre.status, pre.stderr).toBe(0);
    expect(run(db, "pre", sha, snapshot).status).toBe(0);
    expect(JSON.parse(pre.stdout)).toMatchObject({
      migration101: { candidateCount: 1, markerWasPresent: false },
      migration102: { markerWasPresent: false, tableWasPresent: false, rowCount: 0 },
      migration103: { markerWasPresent: false, tableWasPresent: false, rowCount: 0 },
    });
    expect(JSON.parse(readFileSync(snapshot, "utf8"))).toMatchObject({
      schemaVersion: 3,
      migration101: { candidateCount: 1 },
      migration102: { tableWasPresent: false, rowCount: 0, rows: [] },
      migration103: { tableWasPresent: false, rowCount: 0, rows: [] },
    });
    apply(db, migration101, marker101);
    apply(db, migration102, marker102);
    apply(db, migration103, marker103);
    const post = run(db, "post", sha, snapshot);
    expect(post.status, post.stderr).toBe(0);
    const proof = JSON.parse(post.stdout);
    expect(Object.keys(proof).sort()).toEqual(["migration101", "migration102", "migration103"]);
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
    expect(run(interrupted.db, "post", sha, interrupted.snapshot).status).toBe(0);

    const redeploy = fixture();
    apply(redeploy.db, migration101, marker101);
    apply(redeploy.db, migration102, marker102);
    apply(redeploy.db, migration103, marker103);
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
