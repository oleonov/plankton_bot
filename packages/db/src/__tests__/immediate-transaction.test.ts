import { describe, it, expect } from "vitest";
import { openDatabase } from "../connection.js";
import { withImmediate } from "../immediate-transaction.js";

describe("withImmediate", () => {
  it("executes writes atomically", () => {
    const conn = openDatabase(":memory:");
    conn.db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");

    withImmediate(conn.db, (db) => {
      db.prepare("INSERT INTO t (val) VALUES (?)").run("a");
      db.prepare("INSERT INTO t (val) VALUES (?)").run("b");
    });

    const rows = conn.db.prepare("SELECT val FROM t ORDER BY id").all() as { val: string }[];
    expect(rows.map((r) => r.val)).toEqual(["a", "b"]);
  });

  it("rolls back on error — no partial writes", () => {
    const conn = openDatabase(":memory:");
    conn.db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT NOT NULL)");

    expect(() =>
      withImmediate(conn.db, (db) => {
        db.prepare("INSERT INTO t (val) VALUES (?)").run("a");
        db.prepare("INSERT INTO t (val) VALUES (?)").run(null);
      }),
    ).toThrow();

    const count = conn.db.prepare("SELECT COUNT(*) as c FROM t").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("returns the value from the callback", () => {
    const conn = openDatabase(":memory:");
    conn.db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");

    const result = withImmediate(conn.db, (db) => {
      db.prepare("INSERT INTO t (val) VALUES (?)").run("x");
      return 42;
    });

    expect(result).toBe(42);
  });
});
