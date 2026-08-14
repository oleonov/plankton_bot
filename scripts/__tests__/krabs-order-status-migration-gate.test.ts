import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));
const gate = join(root, "scripts", "krabs-order-status-migration-gate.sh");
const migration = join(root, "packages/db/src/migrations/101_repair_filled_phantom_orders.sql");
const sha = "a".repeat(40);
const dirs: string[] = [];

function sql(db: string, statement: string): void {
  const result = spawnSync("/usr/bin/sqlite3", [db], { encoding: "utf8", input: statement });
  if (result.status) throw new Error(result.stderr);
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

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("krabs order-status migration gate", () => {
  it("snapshots the exact pre-census and proves only candidates changed after migration", () => {
    const { db, snapshot } = fixture();
    expect(run(db, "pre", sha, snapshot).status).toBe(0);
    expect(run(db, "pre", sha, snapshot).status).toBe(0);
    expect(JSON.parse(readFileSync(snapshot, "utf8"))).toMatchObject({ candidateCount: 1 });
    sql(db, readFileSync(migration, "utf8"));
    sql(db, "INSERT INTO schema_migrations VALUES('101_repair_filled_phantom_orders.sql')");
    expect(run(db, "post", sha, snapshot).status).toBe(0);
    expect(run(db, "pre", sha, snapshot).status).not.toBe(0);
  });

  it("fails closed for noncandidate mutation and never writes the ledger", () => {
    const { db, snapshot } = fixture();
    expect(run(db, "pre", sha, snapshot).status).toBe(0);
    sql(
      db,
      "UPDATE orders SET status='filled' WHERE order_id='legacy-candidate'; UPDATE orders SET status='open' WHERE order_id='other'; INSERT INTO schema_migrations VALUES('101_repair_filled_phantom_orders.sql')",
    );
    expect(run(db, "post", sha, snapshot).status).not.toBe(0);
    expect(
      spawnSync("/usr/bin/sqlite3", [db, "SELECT status FROM orders WHERE order_id='other'"], {
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("open");
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
